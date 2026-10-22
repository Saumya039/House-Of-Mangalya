'use strict';
/* ================================================
   House of Mangalya — store request handler & API routes
   Used by the local server (server/index.js) and by the
   Vercel function (api/index.js). Holds no state in memory:
   everything lives in Postgres, so any instance can serve any request.
   ================================================ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { priceOrder, publicCatalog, PricingError } = require('./catalog');
const { validateCustomer, validateCartItems, ValidationError, INDIAN_STATES } = require('./validate');
const { CommerceError, evaluateCoupon, checkStock, cleanAttribution } = require('./commerce');
const { verifyWebhookSignature, GatewayError } = require('./payments');
const { securityHeaders, sendJson, HttpError, readBody, readJson, serveStatic, isSameOrigin, clientIp } = require('./http');

const RAZORPAY_ID = {
  order: /^order_[A-Za-z0-9]{6,40}$/,
  payment: /^pay_[A-Za-z0-9]{6,40}$/,
};

function newOrderId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `HOM-${d}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function orderSummary(order) {
  return {
    orderId: order.id,
    status: order.status,
    currency: order.currency,
    items: order.items,
    subtotalPaise: order.subtotal_paise,
    shippingPaise: order.shipping_paise,
    totalPaise: order.total_paise,
    discountPaise: order.discount_paise,
    couponCode: order.coupon_code,
    email: order.customer.email,
  };
}

function createApp({ config, db, provider, log = console }) {
  const baseHeaders = securityHeaders(config);
  const ip = req => clientIp(req, config.trustProxy);

  async function rateLimit(req, bucket, limit, windowMs = 60_000) {
    const r = await db.hit(`${bucket}:${ip(req)}`, limit, windowMs);
    if (!r.ok) {
      const err = new HttpError(429, 'Too many requests — please wait a moment and try again');
      err.retryAfter = r.retryAfterSec;
      throw err;
    }
  }

  /** Blocks cross-site POSTs from browsers (defence-in-depth alongside the JSON content-type). */
  function requireSameOrigin(req) {
    if (!isSameOrigin(req, [config.publicOrigin])) throw new HttpError(403, 'Cross-origin request blocked');
  }

  /**
   * Single source of truth for what a cart costs: prices, coupon, shipping, stock.
   * soft=true (used for live quotes) reports coupon/stock problems instead of throwing.
   */
  async function buildQuote(req, body, { email = '', soft = false } = {}) {
    const items = validateCartItems(body.items);
    const method = body.shippingMethod || 'standard';
    let quote = priceOrder(items, method);
    const problems = {};

    const rawCode = typeof body.couponCode === 'string' ? body.couponCode.trim() : '';
    if (rawCode) {
      const failKey = `coupon-fail:${ip(req)}`;
      if (await db.blocked(failKey, 8)) {
        const e = new HttpError(429, 'Too many invalid coupon attempts — please try again in a few minutes');
        e.retryAfter = 600;
        throw e;
      }
      try {
        const r = await evaluateCoupon(db, rawCode, { subtotalPaise: quote.subtotalPaise, email });
        quote = { ...priceOrder(items, method, r.discountPaise), couponCode: r.coupon.code };
      } catch (e) {
        if (!(e instanceof CommerceError)) throw e;
        await db.hit(failKey, 8, 600_000);
        if (!soft) throw e;
        problems.couponError = e.message;
      }
    }
    try {
      await checkStock(db, quote.lines);
    } catch (e) {
      if (!(e instanceof CommerceError) || !soft) throw e;
      problems.stockError = e.message;
    }
    return { quote, problems };
  }

  // ── Route handlers ───────────────────────────────
  const routes = {
    'GET /api/health': async (req, res) => {
      await db.pg.q('SELECT 1');
      sendJson(res, 200, { ok: true });
    },

    // Seller details the Consumer Protection (E-Commerce) Rules 2020 and FSSAI require on the website.
    // Only public, non-sensitive fields — never costs, goals or anything else in settings.
    'GET /api/business': async (req, res) => {
      const s = await db.allSettings();
      sendJson(res, 200, {
        name: s.biz_name || '', address: s.biz_address || '', gstin: s.gstin || '', fssai: s.fssai || '',
        phone: s.biz_phone || '', email: s.biz_email || '',
        grievance: { name: s.grievance_name || '', email: s.grievance_email || s.biz_email || '', phone: s.grievance_phone || s.biz_phone || '' },
      });
    },

    'GET /api/config': async (req, res) => {
      const cat = publicCatalog();
      cat.products = await Promise.all(cat.products.map(async p => {
        const row = await db.getStock(p.id);
        const left = Math.max(0, row ? row.stock : 0);
        return { ...p, left, stockStatus: left === 0 ? 'out' : left <= (row?.low_threshold ?? 10) ? 'low' : 'in' };
      }));
      sendJson(res, 200, {
        provider: provider.name,
        keyId: provider.publicKey,
        states: INDIAN_STATES,
        ...cat,
      });
    },

    'POST /api/checkout/quote': async (req, res) => {
      requireSameOrigin(req);
      await rateLimit(req, 'quote', 60);
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
      const { quote, problems } = await buildQuote(req, body, { email, soft: true });
      sendJson(res, 200, { ...quote, ...problems });
    },

    'POST /api/checkout/create-order': async (req, res) => {
      requireSameOrigin(req);
      await rateLimit(req, 'create-order', 10);
      const body = await readJson(req);
      const customer = validateCustomer(body.customer);
      const { quote } = await buildQuote(req, body, { email: customer.email });
      const attribution = cleanAttribution(body.attribution);
      const id = newOrderId();

      const gw = await provider.createOrder({
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        receipt: id,
        notes: { order_id: id },
      });
      if (gw.amountPaise !== quote.totalPaise || gw.currency !== quote.currency) {
        throw new GatewayError('Gateway order amount mismatch');
      }

      await db.createOrder({ id, provider: provider.name, providerOrderId: gw.providerOrderId, customer, attribution, couponCode: quote.couponCode, ...quote });
      log.info(`[order] created ${id} (${quote.totalPaise} paise)`);

      sendJson(res, 201, {
        orderId: id,
        provider: provider.name,
        keyId: provider.publicKey,
        providerOrderId: gw.providerOrderId,
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        prefill: { name: customer.name, email: customer.email, contact: customer.phone },
        quote,
      });
    },

    'POST /api/checkout/verify': async (req, res) => {
      requireSameOrigin(req);
      await rateLimit(req, 'verify', 20);
      const body = await readJson(req);
      const orderId = body.razorpay_order_id;
      const paymentId = body.razorpay_payment_id;
      const signature = body.razorpay_signature;

      if (!RAZORPAY_ID.order.test(orderId) || !RAZORPAY_ID.payment.test(paymentId) || typeof signature !== 'string') {
        throw new HttpError(400, 'Invalid payment response');
      }

      const order = await db.getByProviderOrderId(orderId);
      if (!order) throw new HttpError(404, 'Order not found');

      if (!provider.verifyPaymentSignature({ orderId, paymentId, signature })) {
        log.warn(`[verify] signature mismatch for ${order.id}`);
        throw new HttpError(400, 'Payment verification failed');
      }

      if (order.status === 'paid' && order.payment_id === paymentId) {
        return sendJson(res, 200, orderSummary(order));
      }

      // Signature proves the gateway issued this payment for this order. We also confirm
      // status and amount server-to-server so nothing from the browser is taken on trust.
      let payment;
      try {
        payment = await provider.fetchPayment(paymentId);
      } catch (e) {
        log.error(`[verify] could not fetch payment for ${order.id}: ${e.message}`);
        return sendJson(res, 202, { orderId: order.id, status: 'pending',
          message: 'Payment received — confirmation is pending. You will receive an email shortly.' });
      }
      if (payment.orderId !== orderId || payment.amountPaise !== order.total_paise || payment.currency !== order.currency) {
        log.error(`[verify] payment/order mismatch for ${order.id}`);
        throw new HttpError(400, 'Payment verification failed');
      }

      if (payment.status === 'captured') await db.markPaid(orderId, paymentId, payment.method);
      else if (payment.status === 'authorized') await db.markAuthorized(orderId, paymentId, payment.method);
      else throw new HttpError(402, 'Payment was not completed');

      log.info(`[verify] ${order.id} -> ${payment.status}`);
      sendJson(res, 200, orderSummary(await db.getByProviderOrderId(orderId)));
    },

    'POST /api/checkout/mock-pay': async (req, res) => {
      if (provider.name !== 'mock' || config.isProduction) throw new HttpError(404, 'Not found');
      requireSameOrigin(req);
      await rateLimit(req, 'mock-pay', 20);
      const body = await readJson(req);
      const order = typeof body.providerOrderId === 'string' ? await db.getByProviderOrderId(body.providerOrderId) : null;
      if (!order) throw new HttpError(404, 'Order not found');
      const r = await provider.simulatePayment({
        providerOrderId: order.provider_order_id,
        amountPaise: order.total_paise,
        outcome: body.outcome === 'success' ? 'success' : 'failure',
      });
      if (r.failed) {
        await db.markFailed(order.provider_order_id);
        return sendJson(res, 200, { failed: true, error: 'Test payment declined' });
      }
      sendJson(res, 200, {
        razorpay_order_id: order.provider_order_id,
        razorpay_payment_id: r.paymentId,
        razorpay_signature: r.signature,
      });
    },

    'POST /api/webhooks/razorpay': async (req, res) => {
      await rateLimit(req, 'webhook', 120);
      const secret = config.razorpay.webhookSecret;
      if (!secret) throw new HttpError(404, 'Not found');
      const raw = await readBody(req, 100 * 1024);
      if (!verifyWebhookSignature({ rawBody: raw, signature: req.headers['x-razorpay-signature'], secret })) {
        log.warn('[webhook] invalid signature');
        throw new HttpError(400, 'Invalid signature');
      }
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
      const eventId = String(req.headers['x-razorpay-event-id'] || crypto.randomUUID()).slice(0, 100);
      if (await db.hasWebhookEvent(eventId)) return sendJson(res, 200, { ok: true, duplicate: true });

      const eventName = String(event?.event || 'unknown').slice(0, 64);
      const payment = event?.payload?.payment?.entity;
      const refund = event?.payload?.refund?.entity;
      const order = payment?.order_id ? await db.getByProviderOrderId(payment.order_id) : null;

      let outcome = order ? 'ignored' : 'unknown-order';
      if (order) {
        const amountOk = payment.amount === order.total_paise && payment.currency === order.currency;
        if (eventName.startsWith('refund.') && refund?.id) {
          const status = eventName === 'refund.processed' ? 'processed' : eventName === 'refund.failed' ? 'failed' : 'pending';
          await db.updateRefundStatusByPayment(payment.id, refund.id, status);
          outcome = `refund-${status}`;
        } else if (!amountOk) {
          log.error(`[webhook] amount mismatch for ${order.id}`);
          outcome = 'amount-mismatch';
        } else if (eventName === 'payment.captured' || eventName === 'order.paid') {
          await db.markPaid(payment.order_id, payment.id, payment.method);
          outcome = 'marked-paid';
        } else if (eventName === 'payment.authorized') {
          await db.markAuthorized(payment.order_id, payment.id, payment.method);
          outcome = 'marked-authorized';
        } else if (eventName === 'payment.failed') {
          await db.markFailed(payment.order_id);
          outcome = 'marked-failed';
        }
        log.info(`[webhook] ${eventName} for ${order.id}`);
      }

      await db.recordWebhookEvent(eventId, eventName, {
        providerOrderId: payment?.order_id, paymentId: payment?.id, amountPaise: payment?.amount, outcome,
      });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/orders/track': async (req, res) => {
      requireSameOrigin(req);
      await rateLimit(req, 'track', 15);
      const failKey = `track-fail:${ip(req)}`;
      if (await db.blocked(failKey, 8)) throw new HttpError(429, 'Too many attempts — please try again in a few minutes');
      const body = await readJson(req, 2048);
      const id = typeof body.orderId === 'string' ? body.orderId.trim().toUpperCase() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const order = /^[A-Z]{3,5}-\d{8}-[A-F0-9]{8}$/.test(id) ? await db.getById(id) : null;
      if (!order || order.status !== 'paid' || order.customer.email !== email) {
        await db.hit(failKey, 8, 600_000);
        throw new HttpError(404, 'We could not find an order with those details. Check your order number and email.');
      }
      sendJson(res, 200, {
        orderId: order.id,
        placedAt: order.created_at,
        paidAt: order.paid_at,
        fulfillment: order.refund_id ? 'refunded' : order.fulfillment_status,
        courier: order.courier,
        trackingNumber: order.tracking_number,
        shippedAt: order.shipped_at,
        deliveredAt: order.delivered_at,
        shippingMethod: order.shipping_method,
        items: order.items.map(i => ({ name: i.name, weight: i.weight, qty: i.qty })),
        totalPaise: order.total_paise,
        city: order.customer.city,
      });
    },

    'POST /api/newsletter': async (req, res) => {
      requireSameOrigin(req);
      await rateLimit(req, 'newsletter', 5);
      const body = await readJson(req, 1024);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email)) {
        throw new HttpError(400, 'Enter a valid email address');
      }
      await db.addSubscriber(email);
      const welcome = await db.getCoupon('WELCOME10');
      sendJson(res, 200, { ok: true, code: welcome && welcome.active ? welcome.code : undefined });
    },
  };

  // ── Main handler ─────────────────────────────────
  async function handler(req, res) {
    for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);
    const pathname = (req.url || '/').split('?')[0];

    try {
      if (pathname.startsWith('/api/')) {
        const route = routes[`${req.method} ${pathname}`];
        if (!route) throw new HttpError(Object.keys(routes).some(r => r.endsWith(' ' + pathname)) ? 405 : 404, 'Not found');
        await route(req, res);
        return;
      }
      // Static pages: the local server serves them itself; on Vercel the CDN does.
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      // Locally the admin page lives on its own port; never serve it from the public store port
      if (/^\/admin(\/|$)/.test(pathname)) throw new HttpError(404, 'Not found');
      await rateLimit(req, 'static', 600);
      if (!(await serveStatic(req, res, config.publicDir))) throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError && err.status === 404 && req.method === 'GET' && !pathname.startsWith('/api/') && String(req.headers.accept || '').includes('text/html')) {
        const page = await fs.promises.readFile(path.join(config.publicDir, '404.html')).catch(() => null);
        if (page) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-cache' });
          return res.end(page);
        }
      }
      if (err instanceof ValidationError) return sendJson(res, 400, { error: err.message, field: err.field });
      if (err instanceof PricingError) return sendJson(res, 400, { error: err.message });
      if (err instanceof CommerceError) return sendJson(res, 400, { error: err.message, field: err.field });
      if (err instanceof HttpError) {
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        return sendJson(res, err.status, { error: err.message });
      }
      if (err instanceof GatewayError) {
        log.error(`[gateway] ${err.message}`);
        return sendJson(res, 502, { error: 'Payment gateway is unavailable. Please try again shortly.' });
      }
      log.error('[error]', err);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  }

  handler.close = () => {};
  return handler;
}

module.exports = { createApp };
