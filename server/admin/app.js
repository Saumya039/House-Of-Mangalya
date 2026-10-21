'use strict';
/* ================================================
   Admin portal API. Every route except login requires a session;
   every state change requires the session's CSRF token and is
   written to the audit log. Sessions, lock-outs and rate limits live
   in Postgres, so it works the same on a laptop (own port, localhost
   only) and on Vercel (same origin, path /admin, two-factor required).
   ================================================ */
const path = require('node:path');
const { createAuth } = require('./auth');
const { createQueries, FULFILLMENT, istToday } = require('./queries');
const { createInsights } = require('./insights');
const { extraRoutes } = require('./routes-extra');
const { sendJson, HttpError, readJson, serveStatic, isSameOrigin, clientIp } = require('../http');
const { GatewayError } = require('../payments');
const { INDIAN_STATES } = require('../validate');

const ADMIN_DIR = path.resolve(__dirname, '..', '..', 'public', 'admin');

const ADMIN_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'",
    "form-action 'self'", "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(headers, rows) {
  return '﻿' + [headers.map(h => csvCell(h[0])).join(','),
    ...rows.map(r => headers.map(h => csvCell(r[h[1]])).join(','))].join('\r\n');
}

function createAdminApp({ config, db, provider, log = console }) {
  const admin = config.admin;
  const secureCookies = admin.origin.startsWith('https://') || config.onVercel;
  const auth = createAuth({ db, username: admin.username, passwordHash: admin.passwordHash, totpSecret: admin.totpSecret, secureCookies });
  const queries = createQueries(db.pg);
  const insights = createInsights(db);

  const ip = req => clientIp(req, config.trustProxy);

  async function limit(req, bucket, n, windowMs = 60_000) {
    const r = await db.hit(`${bucket}:${ip(req)}`, n, windowMs);
    if (!r.ok) {
      const e = new HttpError(429, 'Too many requests — slow down');
      e.retryAfter = r.retryAfterSec;
      throw e;
    }
  }

  async function requireSession(req) {
    const s = await auth.session(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    return s;
  }

  /** For state-changing requests: same origin + CSRF token bound to the session. */
  async function requireWrite(req) {
    if (!isSameOrigin(req, [admin.origin])) throw new HttpError(403, 'Cross-origin request blocked');
    const s = await requireSession(req);
    const token = String(req.headers['x-csrf-token'] || '');
    if (token.length !== s.csrf.length || token !== s.csrf) throw new HttpError(403, 'Session expired — reload the page');
    return s;
  }

  async function audit(s, req, action, orderId, detail) {
    await db.audit({ actor: s.user, action, orderId, detail: detail ? String(detail).slice(0, 500) : null, ip: ip(req) });
  }

  async function loadOrder(id) {
    if (!/^[A-Z]{3,5}-\d{8}-[A-F0-9]{8}$/.test(id)) throw new HttpError(404, 'Order not found');
    const o = await db.getById(id);
    if (!o) throw new HttpError(404, 'Order not found');
    return o;
  }

  function cleanText(v, max) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new HttpError(400, 'Invalid text');
    const s = v.replace(CONTROL, '').trim();
    if (s.length > max) throw new HttpError(400, `Must be at most ${max} characters`);
    return s;
  }

  const baseRoutes = [
    // Public: lets the sign-in form know whether to ask for a two-factor code
    ['GET', /^\/api\/admin\/login-info$/, async (req, res) => {
      sendJson(res, 200, { twoFactor: auth.twoFactorRequired });
    }],

    ['POST', /^\/api\/admin\/login$/, async (req, res) => {
      await limit(req, 'login', 10);
      if (!isSameOrigin(req, [admin.origin])) throw new HttpError(403, 'Cross-origin request blocked');
      const body = await readJson(req, 2048);
      const r = await auth.login(ip(req), body.username, body.password, body.code);
      if (!r.ok) {
        await db.audit({ actor: String(body.username || '?').slice(0, 64), action: r.locked ? 'login.locked' : 'login.failed', ip: ip(req) });
        log.warn(`[admin] failed login from ${ip(req)}${r.locked ? ' (locked)' : ''}`);
        throw new HttpError(r.locked ? 429 : 401, r.locked
          ? 'Too many failed attempts. Try again in 15 minutes.'
          : `Incorrect username, password${auth.twoFactorRequired ? ' or code' : ''}`);
      }
      await db.audit({ actor: admin.username, action: 'login', ip: ip(req) });
      res.setHeader('Set-Cookie', r.setCookie);
      sendJson(res, 200, { user: admin.username, csrf: r.csrf });
    }],

    ['POST', /^\/api\/admin\/logout$/, async (req, res) => {
      const s = await auth.session(req);
      if (s) await audit(s, req, 'logout');
      res.setHeader('Set-Cookie', await auth.logout(req));
      sendJson(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/admin\/me$/, async (req, res) => {
      const s = await requireSession(req);
      sendJson(res, 200, {
        user: s.user, csrf: s.csrf, provider: provider.name,
        testMode: provider.name === 'mock' || String(provider.publicKey).startsWith('rzp_test_'),
        states: INDIAN_STATES,
        storeOrigin: config.publicOrigin, today: istToday(), fulfillmentStates: FULFILLMENT,
      });
    }],

    ['GET', /^\/api\/admin\/analytics$/, async (req, res, m, url) => {
      await requireSession(req);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const [a, extras] = await Promise.all([queries.analytics(from, to), insights.analyticsExtras(from, to)]);
      sendJson(res, 200, { ...a, ...extras });
    }],

    ['GET', /^\/api\/admin\/orders$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await queries.listOrders(Object.fromEntries(url.searchParams)));
    }],

    ['GET', /^\/api\/admin\/orders\/([^/]+)$/, async (req, res, m) => {
      await requireSession(req);
      sendJson(res, 200, await queries.orderDetail(await loadOrder(m[1])));
    }],

    ['POST', /^\/api\/admin\/orders\/([^/]+)\/fulfillment$/, async (req, res, m) => {
      const s = await requireWrite(req);
      const order = await loadOrder(m[1]);
      const body = await readJson(req, 2048);
      if (!FULFILLMENT.includes(body.status)) throw new HttpError(400, 'Invalid fulfilment status');
      if (order.status !== 'paid') throw new HttpError(409, 'Only paid orders can be fulfilled');
      const courier = cleanText(body.courier, 40);
      const trackingNumber = cleanText(body.trackingNumber, 60);
      if (trackingNumber && !/^[A-Za-z0-9-]+$/.test(trackingNumber)) throw new HttpError(400, 'Tracking number: letters, digits and dashes only');
      if (body.status === 'shipped' && !trackingNumber) throw new HttpError(400, 'Add a tracking number to mark as shipped');
      await db.setFulfillment(order.id, { status: body.status, courier, trackingNumber });
      await audit(s, req, 'order.fulfillment', order.id, `${order.fulfillment_status} → ${body.status}${trackingNumber ? ` (${courier} ${trackingNumber})` : ''}`);
      sendJson(res, 200, await queries.orderDetail(await db.getById(order.id)));
    }],

    ['POST', /^\/api\/admin\/orders\/([^/]+)\/note$/, async (req, res, m) => {
      const s = await requireWrite(req);
      const order = await loadOrder(m[1]);
      const body = await readJson(req, 4096);
      await db.setNote(order.id, cleanText(body.note, 1000));
      await audit(s, req, 'order.note', order.id);
      sendJson(res, 200, await queries.orderDetail(await db.getById(order.id)));
    }],

    ['POST', /^\/api\/admin\/orders\/([^/]+)\/refund$/, async (req, res, m) => {
      const s = await requireWrite(req);
      await limit(req, 'refund', 10);
      const order = await loadOrder(m[1]);
      const body = await readJson(req, 1024);
      if (body.confirm !== order.id) throw new HttpError(400, 'Type the order number to confirm the refund');
      if (order.status !== 'paid' || !order.payment_id) throw new HttpError(409, 'Only paid orders can be refunded');
      if (order.refund_id) throw new HttpError(409, 'This order has already been refunded');
      const amountPaise = body.amountPaise === undefined ? order.total_paise : body.amountPaise;
      if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > order.total_paise) {
        throw new HttpError(400, `Refund amount must be between ₹1 and ₹${order.total_paise / 100}`);
      }
      const r = await provider.refund({ paymentId: order.payment_id, amountPaise, receipt: order.id });
      await db.setRefund(order.id, { refundId: r.refundId, status: r.status === 'processed' ? 'processed' : 'pending', amountPaise: r.amountPaise });
      await audit(s, req, 'order.refund', order.id, `₹${amountPaise / 100} refund ${r.refundId} (${r.status})`);
      log.info(`[admin] refund ${r.refundId} for ${order.id}`);
      sendJson(res, 200, await queries.orderDetail(await db.getById(order.id)));
    }],

    ['POST', /^\/api\/admin\/orders\/([^/]+)\/sync$/, async (req, res, m) => {
      const s = await requireWrite(req);
      await limit(req, 'sync', 30);
      const order = await loadOrder(m[1]);
      const payments = await provider.fetchOrderPayments(order.provider_order_id);
      const ok = p => p.amountPaise === order.total_paise && p.currency === order.currency && p.orderId === order.provider_order_id;
      const captured = payments.find(p => p.status === 'captured' && ok(p));
      const authorized = payments.find(p => p.status === 'authorized' && ok(p));
      let result = 'no change';
      if (captured && await db.markPaid(order.provider_order_id, captured.id, captured.method)) result = 'marked paid';
      else if (!captured && authorized && await db.markAuthorized(order.provider_order_id, authorized.id, authorized.method)) result = 'marked authorized';
      else if (payments.length && payments.every(p => p.status === 'failed') && await db.markFailed(order.provider_order_id)) result = 'marked failed';
      await audit(s, req, 'order.sync', order.id, `${payments.length} gateway payment(s); ${result}`);
      sendJson(res, 200, { result, gatewayPayments: payments, order: await queries.orderDetail(await db.getById(order.id)) });
    }],

    ['GET', /^\/api\/admin\/webhooks$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await queries.webhooks(Object.fromEntries(url.searchParams)));
    }],

    ['GET', /^\/api\/admin\/audit$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await queries.audit(Object.fromEntries(url.searchParams)));
    }],

    ['GET', /^\/api\/admin\/subscribers$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await queries.subscribers(Object.fromEntries(url.searchParams)));
    }],

    ['GET', /^\/api\/admin\/export\/orders\.csv$/, async (req, res, m, url) => {
      const s = await requireSession(req);
      await limit(req, 'export', 10);
      const rows = (await queries.exportOrders(Object.fromEntries(url.searchParams))).map(r => ({
        ...r, total: (r.totalPaise / 100).toFixed(2), subtotal: (r.subtotalPaise / 100).toFixed(2), shipping: (r.shippingPaise / 100).toFixed(2), discount: (r.discountPaise / 100).toFixed(2),
      }));
      await audit(s, req, 'export.orders', null, `${rows.length} rows; ${url.search || 'no filters'}`);
      const csv = toCsv([
        ['Order', 'id'], ['Created (UTC)', 'createdAt'], ['Paid (UTC)', 'paidAt'], ['Payment status', 'status'],
        ['Fulfilment', 'fulfillment'], ['Items', 'items'], ['Units', 'units'], ['Subtotal (INR)', 'subtotal'],
        ['Shipping (INR)', 'shipping'], ['Discount (INR)', 'discount'], ['Coupon', 'couponCode'], ['Source', 'source'], ['Total (INR)', 'total'], ['Shipping method', 'shippingMethod'],
        ['Payment method', 'paymentMethod'], ['Payment ID', 'paymentId'], ['Name', 'name'], ['Email', 'email'],
        ['Phone', 'phone'], ['Address', 'address'], ['Courier', 'courier'], ['Tracking', 'trackingNumber'], ['Refund', 'refundStatus'],
      ], rows);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${istToday()}.csv"` });
      res.end(csv);
    }],

    ['GET', /^\/api\/admin\/export\/subscribers\.csv$/, async (req, res) => {
      const s = await requireSession(req);
      await limit(req, 'export', 10);
      const rows = await queries.allSubscribers();
      await audit(s, req, 'export.subscribers', null, `${rows.length} rows`);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="subscribers-${istToday()}.csv"` });
      res.end(toCsv([['Email', 'email'], ['Subscribed (UTC)', 'created_at']], rows));
    }],
  ];

  // Extras first: more specific patterns (e.g. orders/bulk/…) must win over orders/:id/…
  const routes = [
    ...extraRoutes({ db, queries, insights, provider, requireSession, requireWrite, audit, limit, cleanText, HttpError, readJson, sendJson, toCsv, istToday, loadOrder }),
    ...baseRoutes,
  ];

  async function handler(req, res) {
    for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.setHeader(k, v);
    try {
      if (admin.allowedIps.length && !admin.allowedIps.includes(ip(req))) throw new HttpError(403, 'Forbidden');
      const url = new URL(req.url || '/', 'http://admin.local');
      if (url.pathname.startsWith('/api/')) {
        await limit(req, 'admin-api', 300);
        for (const [method, re, fn] of routes) {
          const m = url.pathname.match(re);
          if (m && method === req.method) return await fn(req, res, m, url);
        }
        throw new HttpError(404, 'Not found');
      }
      // The admin page itself: served here when running locally; on Vercel the CDN serves /admin/*
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (!(await serveStatic(req, res, ADMIN_DIR))) throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) {
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        return sendJson(res, err.status, { error: err.message });
      }
      if (err instanceof GatewayError) {
        log.error(`[admin gateway] ${err.message}`);
        return sendJson(res, 502, { error: `Payment gateway error: ${err.message}` });
      }
      log.error('[admin error]', err);
      sendJson(res, 500, { error: 'Internal error' });
    }
  }

  handler.close = () => auth.stop();
  return handler;
}

module.exports = { createAdminApp, toCsv, csvCell, ADMIN_HEADERS };
