'use strict';
/* ================================================
   Admin routes: overview, customers, inventory,
   coupons, marketing, unit economics, settings,
   invoices, recovery, bulk actions.
   Reads need a session; every write needs the CSRF
   token and is recorded in the audit log.
   ================================================ */
const { PRODUCTS } = require('../catalog');
const { normalizeCode } = require('../commerce');
const { validateSettings, settingsWithDefaults } = require('./insights');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = s => typeof s === 'string' && ISO_DAY.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const istEndOfDay = day => new Date(day + 'T23:59:59+05:30').toISOString();
const istStartOfDay = day => new Date(day + 'T00:00:00+05:30').toISOString();

function extraRoutes(ctx) {
  const { db, queries, insights, provider, requireSession, requireWrite, audit, limit, cleanText, HttpError, readJson, sendJson, toCsv, istToday, loadOrder } = ctx;

  const intIn = (v, lo, hi, label) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${label} must be a whole number between ${lo} and ${hi}`);
    return v;
  };
  const rupeesToPaise = (v, lo, hi, label) => {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${label} must be between ₹${lo} and ₹${hi}`);
    return Math.round(n * 100);
  };
  const productOr404 = id => {
    if (typeof id !== 'string' || !Object.hasOwn(PRODUCTS, id)) throw new HttpError(404, 'Product not found');
    return id;
  };
  const inventoryView = async () => Promise.all((await db.listInventory()).map(async r => ({
    productId: r.product_id, name: PRODUCTS[r.product_id]?.name || r.product_id, weight: PRODUCTS[r.product_id]?.weight || '',
    stock: r.stock, lowThreshold: r.low_threshold, updatedAt: r.updated_at,
    status: r.stock <= 0 ? 'out' : r.stock <= r.low_threshold ? 'low' : 'in', history: await db.stockHistory(r.product_id, 15),
  })));
  const couponView = c => ({
    code: c.code, kind: c.kind, value: c.value, minSubtotalPaise: c.min_subtotal_paise, maxDiscountPaise: c.max_discount_paise,
    startsAt: c.starts_at, expiresAt: c.expires_at, usageLimit: c.usage_limit, perCustomerLimit: c.per_customer_limit,
    used: c.used_count, discountGivenPaise: c.discount_given_paise, active: Boolean(c.active), description: c.description, createdAt: c.created_at,
    expired: Boolean(c.expires_at && c.expires_at < new Date().toISOString()),
  });
  const couponList = async () => (await db.listCoupons()).map(couponView);

  return [
    ['GET', /^\/api\/admin\/overview$/, async (req, res) => {
      await requireSession(req);
      sendJson(res, 200, await insights.overview(provider.name));
    }],

    ['GET', /^\/api\/admin\/search$/, async (req, res, m, url) => {
      await requireSession(req);
      await limit(req, 'search', 120);
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (q.length < 2) return sendJson(res, 200, { orders: [], customers: [] });
      const [orders, customers] = await Promise.all([queries.listOrders({ q, pageSize: 6 }), insights.customers({ q, pageSize: 5 })]);
      sendJson(res, 200, {
        orders: orders.orders.map(o => ({ id: o.id, name: o.name, email: o.email, totalPaise: o.totalPaise, status: o.status, createdAt: o.createdAt })),
        customers: customers.customers.map(c => ({ name: c.name, email: c.email, orders: c.orders, ltvPaise: c.ltvPaise })),
      });
    }],

    ['GET', /^\/api\/admin\/customers$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await insights.customers(Object.fromEntries(url.searchParams)));
    }],

    ['GET', /^\/api\/admin\/export\/customers\.csv$/, async (req, res) => {
      const s = await requireSession(req);
      await limit(req, 'export', 10);
      const rows = (await insights.exportCustomers()).map(c => ({
        ...c, ltv: (c.ltvPaise / 100).toFixed(2), aov: (c.aovPaise / 100).toFixed(2), tagList: c.tags.join(' '),
      }));
      await audit(s, req, 'export.customers', null, `${rows.length} rows`);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customers-${istToday()}.csv"` });
      res.end(toCsv([['Name', 'name'], ['Email', 'email'], ['Phone', 'phone'], ['City', 'city'], ['State', 'state'], ['Orders', 'orders'],
        ['Net spend (INR)', 'ltv'], ['Avg order (INR)', 'aov'], ['First order (UTC)', 'firstOrder'], ['Last order (UTC)', 'lastOrder'], ['Segments', 'tagList']], rows));
    }],

    ['GET', /^\/api\/admin\/cohorts$/, async (req, res) => {
      await requireSession(req);
      sendJson(res, 200, await insights.cohorts());
    }],

    ['GET', /^\/api\/admin\/marketing$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await insights.marketing(url.searchParams.get('from'), url.searchParams.get('to')));
    }],

    ['GET', /^\/api\/admin\/economics$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await insights.economics(url.searchParams.get('from'), url.searchParams.get('to')));
    }],

    ['POST', /^\/api\/admin\/ad-spend$/, async (req, res) => {
      const s = await requireWrite(req);
      const b = await readJson(req, 2048);
      if (!validDay(b.day)) throw new HttpError(400, 'Choose a valid date');
      if (b.day > new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10)) throw new HttpError(400, 'Date cannot be in the future');
      const channel = cleanText(b.channel, 30).toLowerCase();
      if (!/^[a-z0-9][a-z0-9 _.-]{1,29}$/.test(channel)) throw new HttpError(400, 'Channel: 2–30 letters, digits or spaces (e.g. instagram, google, facebook)');
      const amountPaise = rupeesToPaise(b.amount, 1, 10_000_000, 'Amount');
      const id = await db.addAdSpend({ day: b.day, channel, amountPaise, note: cleanText(b.note, 120) });
      await audit(s, req, 'adspend.add', null, `${channel} ₹${amountPaise / 100} on ${b.day}`);
      sendJson(res, 201, { id });
    }],

    ['POST', /^\/api\/admin\/ad-spend\/(\d+)\/delete$/, async (req, res, m) => {
      const s = await requireWrite(req);
      if (!(await db.deleteAdSpend(Number(m[1])))) throw new HttpError(404, 'Entry not found');
      await audit(s, req, 'adspend.delete', null, `entry ${m[1]}`);
      sendJson(res, 200, { ok: true });
    }],

    ['GET', /^\/api\/admin\/settings$/, async (req, res) => {
      await requireSession(req);
      sendJson(res, 200, { settings: await settingsWithDefaults(db) });
    }],

    ['POST', /^\/api\/admin\/settings$/, async (req, res) => {
      const s = await requireWrite(req);
      const b = await readJson(req, 8192);
      let clean;
      try {
        clean = validateSettings(b);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      for (const [k, v] of Object.entries(clean)) await db.setSetting(k, v);
      await audit(s, req, 'settings.update', null, Object.keys(clean).join(', '));
      sendJson(res, 200, { settings: await settingsWithDefaults(db) });
    }],

    // ── Inventory ────────────────────────────────
    ['GET', /^\/api\/admin\/inventory$/, async (req, res) => {
      await requireSession(req);
      sendJson(res, 200, { items: await inventoryView() });
    }],

    ['POST', /^\/api\/admin\/inventory\/([^/]+)\/adjust$/, async (req, res, m) => {
      const s = await requireWrite(req);
      const id = productOr404(decodeURIComponent(m[1]));
      const b = await readJson(req, 1024);
      const reason = cleanText(b.reason, 80);
      let row;
      if (b.mode === 'set') {
        row = await db.adjustStock(id, { set: intIn(b.value, 0, 1_000_000, 'Stock level'), reason: reason || 'stock count', actor: s.user });
      } else if (b.mode === 'delta') {
        const d = intIn(b.value, -100_000, 100_000, 'Change');
        if (d === 0) throw new HttpError(400, 'Change cannot be zero');
        row = await db.adjustStock(id, { delta: d, reason: reason || (d > 0 ? 'stock received' : 'stock removed'), actor: s.user });
      } else {
        throw new HttpError(400, 'Invalid adjustment');
      }
      await audit(s, req, 'inventory.adjust', null, `${id}: ${b.mode} ${b.value} → ${row.stock}${reason ? ` (${reason})` : ''}`);
      sendJson(res, 200, { items: await inventoryView() });
    }],

    ['POST', /^\/api\/admin\/inventory\/([^/]+)\/threshold$/, async (req, res, m) => {
      const s = await requireWrite(req);
      const id = productOr404(decodeURIComponent(m[1]));
      const b = await readJson(req, 512);
      await db.setLowThreshold(id, intIn(b.value, 0, 10_000, 'Alert level'));
      await audit(s, req, 'inventory.threshold', null, `${id}: ${b.value}`);
      sendJson(res, 200, { items: await inventoryView() });
    }],

    // ── Coupons ──────────────────────────────────
    ['GET', /^\/api\/admin\/coupons$/, async (req, res) => {
      await requireSession(req);
      sendJson(res, 200, { coupons: await couponList() });
    }],

    ['POST', /^\/api\/admin\/coupons$/, async (req, res) => {
      const s = await requireWrite(req);
      await limit(req, 'coupon-write', 30);
      const b = await readJson(req, 2048);
      const code = normalizeCode(typeof b.code === 'string' ? b.code : '');
      if (!code) throw new HttpError(400, 'Code: 3–20 letters, digits, - or _');
      if (await db.getCoupon(code)) throw new HttpError(409, 'A coupon with this code already exists');
      if (b.kind !== 'percent' && b.kind !== 'flat') throw new HttpError(400, 'Choose percent or flat');
      const value = b.kind === 'percent' ? intIn(Number(b.value), 1, 90, 'Percent') : rupeesToPaise(b.value, 1, 5000, 'Discount');
      const blank = v => v === '' || v === undefined || v === null;
      const c = {
        code, kind: b.kind, value, description: cleanText(b.description, 120),
        minSubtotalPaise: blank(b.minSubtotal) ? 0 : rupeesToPaise(b.minSubtotal, 0, 100_000, 'Minimum order'),
        maxDiscountPaise: blank(b.maxDiscount) ? null : rupeesToPaise(b.maxDiscount, 1, 100_000, 'Maximum discount'),
        startsAt: null, expiresAt: null,
        usageLimit: blank(b.usageLimit) ? null : intIn(Number(b.usageLimit), 1, 1_000_000, 'Usage limit'),
        perCustomerLimit: blank(b.perCustomerLimit) ? null : intIn(Number(b.perCustomerLimit), 1, 1000, 'Per-customer limit'),
      };
      if (b.startsAt) { if (!validDay(b.startsAt)) throw new HttpError(400, 'Invalid start date'); c.startsAt = istStartOfDay(b.startsAt); }
      if (b.expiresAt) { if (!validDay(b.expiresAt)) throw new HttpError(400, 'Invalid end date'); c.expiresAt = istEndOfDay(b.expiresAt); }
      if (c.startsAt && c.expiresAt && c.expiresAt < c.startsAt) throw new HttpError(400, 'End date is before the start date');
      await db.createCoupon(c);
      await audit(s, req, 'coupon.create', null, `${code} ${c.kind} ${b.value}`);
      sendJson(res, 201, { coupons: await couponList() });
    }],

    ['POST', /^\/api\/admin\/coupons\/([A-Z0-9_-]{3,20})\/active$/, async (req, res, m) => {
      const s = await requireWrite(req);
      const b = await readJson(req, 256);
      if (typeof b.active !== 'boolean') throw new HttpError(400, 'Invalid request');
      if (!(await db.setCouponActive(m[1], b.active))) throw new HttpError(404, 'Coupon not found');
      await audit(s, req, b.active ? 'coupon.enable' : 'coupon.disable', null, m[1]);
      sendJson(res, 200, { coupons: await couponList() });
    }],

    // ── Recovery, invoices, bulk ─────────────────
    ['GET', /^\/api\/admin\/abandoned$/, async (req, res, m, url) => {
      await requireSession(req);
      sendJson(res, 200, await insights.abandoned(url.searchParams.get('days')));
    }],

    ['GET', /^\/api\/admin\/invoices$/, async (req, res, m, url) => {
      const s = await requireSession(req);
      await limit(req, 'invoices', 30);
      const ids = (url.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!ids.length || ids.length > 40) throw new HttpError(400, 'Choose between 1 and 40 orders');
      const docs = [];
      for (const id of ids) {
        await loadOrder(id);
        const d = await insights.invoiceData(id);
        if (d) docs.push(d);
      }
      if (!docs.length) throw new HttpError(409, 'Only paid orders have invoices');
      await audit(s, req, 'invoice.view', ids.length === 1 ? ids[0] : null, `${docs.length} document(s)`);
      sendJson(res, 200, { documents: docs, generatedAt: new Date().toISOString() });
    }],

    ['POST', /^\/api\/admin\/orders\/bulk\/fulfillment$/, async (req, res) => {
      const s = await requireWrite(req);
      await limit(req, 'bulk', 20);
      const b = await readJson(req, 8192);
      if (b.status !== 'packed') throw new HttpError(400, 'Bulk update supports “packed” only — shipping needs a tracking number per order');
      if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100) throw new HttpError(400, 'Select between 1 and 100 orders');
      let updated = 0;
      let skipped = 0;
      for (const id of b.ids) {
        const o = typeof id === 'string' && /^[A-Z]{3,5}-\d{8}-[A-F0-9]{8}$/.test(id) ? await db.getById(id) : null;
        if (o && o.status === 'paid' && !o.refund_id && o.fulfillment_status === 'unfulfilled') {
          await db.setFulfillment(o.id, { status: 'packed', courier: o.courier, trackingNumber: o.tracking_number });
          await db.audit({ actor: s.user, action: 'order.fulfillment', orderId: o.id, detail: 'unfulfilled → packed (bulk)', ip: req.socket.remoteAddress });
          updated += 1;
        } else skipped += 1;
      }
      sendJson(res, 200, { updated, skipped });
    }],
  ];
}

module.exports = { extraRoutes };
