'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createAdminApp } = require('../server/admin/app');
const { hashPassword } = require('../server/admin/auth');
const { createMockProvider } = require('../server/payments');
const { cleanAttribution } = require('../server/commerce');

const STORE = 'http://localhost:3998';
const ADMIN = 'http://localhost:3997';
const PASSWORD = 'correct-horse-battery-staple';
const silent = { info() {}, warn() {}, error() {} };

const customer = (over = {}) => ({
  name: 'Asha Patil', email: 'asha@example.com', phone: '9876543210',
  address1: '12 Ganesh Peth Road', address2: '', city: 'Pune', state: 'Maharashtra', pincode: '411004', ...over,
});

async function boot() {
  const config = buildConfig({
    PUBLIC_ORIGIN: STORE, ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), ADMIN_PORT: '3997', ADMIN_ORIGIN: ADMIN,
  });
  const db = await openDb();
  const provider = createMockProvider({ db });
  const storeApp = createApp({ config, db, provider, log: silent });
  const adminApp = createAdminApp({ config, db, provider, log: silent });
  const storeSrv = http.createServer(storeApp);
  const adminSrv = http.createServer(adminApp);
  await Promise.all([storeSrv, adminSrv].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const sBase = `http://127.0.0.1:${storeSrv.address().port}`;
  const aBase = `http://127.0.0.1:${adminSrv.address().port}`;

  const store = {
    async post(path, body, headers = {}) {
      const res = await fetch(sBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: STORE, ...headers }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async get(path) {
      const res = await fetch(sBase + path);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };

  let cookie = '';
  let csrf = '';
  const admin = {
    async call(method, path, body, headers = {}) {
      const res = await fetch(aBase + path, {
        method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: ADMIN, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const t = await res.text();
      let json = null;
      try { json = JSON.parse(t); } catch { /* not json */ }
      return { status: res.status, body: json, text: t };
    },
    async login() {
      const r = await admin.call('POST', '/api/admin/login', { username: 'admin', password: PASSWORD });
      csrf = r.body.csrf;
    },
    get: path => admin.call('GET', path),
    post: (path, body) => admin.call('POST', path, body || {}, { 'X-CSRF-Token': csrf }),
  };

  /** Full purchase through the public API. Returns the created order id. */
  async function buy({ qty = 1, couponCode, cust = customer(), shippingMethod = 'standard', attribution } = {}) {
    const c = await store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty }], shippingMethod, customer: cust, couponCode, attribution });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const p = await store.post('/api/checkout/mock-pay', { providerOrderId: c.body.providerOrderId, outcome: 'success' });
    const v = await store.post('/api/checkout/verify', p.body);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return { id: c.body.orderId, providerOrderId: c.body.providerOrderId, quote: c.body.quote };
  }

  const close = () => new Promise(r => {
    storeApp.close(); adminApp.close();
    storeSrv.close(() => adminSrv.close(() => { db.close().then(r); }));
  });
  return { db, store, admin, buy, close };
}

test('coupon: WELCOME10 is seeded; discount applies before the free-shipping threshold', async () => {
  const t = await boot();
  try {
    const q1 = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', couponCode: 'welcome10' });
    assert.equal(q1.body.discountPaise, 5000);
    assert.equal(q1.body.totalPaise, 45000 + 8000);
    // 2 jars = ₹1,000, minus ₹100 = ₹900 which is no longer above the ₹999 free-shipping line
    const q2 = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 2 }], shippingMethod: 'standard', couponCode: 'WELCOME10' });
    assert.equal(q2.body.discountPaise, 10000);
    assert.equal(q2.body.shippingPaise, 8000);
    // 4 jars: discount capped at ₹200 (cap), still free shipping
    const q4 = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 4 }], shippingMethod: 'standard', couponCode: 'WELCOME10' });
    assert.equal(q4.body.discountPaise, 20000);
    assert.equal(q4.body.shippingPaise, 0);
  } finally { await t.close(); }
});

test('coupon: invalid codes are soft in quote, hard in create-order, and guessing is throttled', async () => {
  const t = await boot();
  try {
    const q = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', couponCode: 'NOPE123' });
    assert.equal(q.status, 200);
    assert.match(q.body.couponError, /not valid/);
    assert.equal(q.body.discountPaise, 0);

    const c = await t.store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: customer(), couponCode: 'NOPE123' });
    assert.equal(c.status, 400);
    assert.equal(c.body.field, 'coupon');

    let last;
    for (let i = 0; i < 10; i++) last = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }], couponCode: `GUESS${i}` });
    assert.equal(last.status, 429, 'after 8 failures even a valid code is refused for a while');
  } finally { await t.close(); }
});

test('coupon: counted once on payment, one use per customer, admin can create/disable', async () => {
  const t = await boot();
  try {
    const o = await t.buy({ couponCode: 'WELCOME10' });
    assert.equal(o.quote.discountPaise, 5000);
    assert.equal((await t.db.getCoupon('WELCOME10')).used_count, 1);
    assert.equal((await t.db.getCoupon('WELCOME10')).discount_given_paise, 5000);

    const again = await t.store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: customer(), couponCode: 'WELCOME10' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already used/);
    const other = await t.store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: customer({ email: 'other@example.com' }), couponCode: 'WELCOME10' });
    assert.equal(other.status, 201);

    await t.admin.login();
    const made = await t.admin.post('/api/admin/coupons', { code: 'diwali25', kind: 'percent', value: 25, minSubtotal: 500, maxDiscount: 300, usageLimit: 2 });
    assert.equal(made.status, 201);
    assert.equal((await t.admin.post('/api/admin/coupons', { code: 'DIWALI25', kind: 'flat', value: 50 })).status, 409);
    assert.equal((await t.admin.post('/api/admin/coupons', { code: 'BAD', kind: 'percent', value: 99 })).status, 400);
    const q = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }], couponCode: 'DIWALI25' });
    assert.equal(q.body.discountPaise, 12500);
    await t.admin.post('/api/admin/coupons/DIWALI25/active', { active: false });
    const off = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }], couponCode: 'DIWALI25' });
    assert.match(off.body.couponError, /not valid/);
  } finally { await t.close(); }
});

test('stock: blocks overselling, decrements once on payment, logs it, admin can adjust', async () => {
  const t = await boot();
  try {
    await t.admin.login();
    assert.equal((await t.admin.post('/api/admin/inventory/turmeric-1kg/adjust', { mode: 'set', value: 3, reason: 'cycle count' })).status, 200);
    const q = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 5 }], shippingMethod: 'standard' });
    assert.match(q.body.stockError, /Only 3/);
    const c = await t.store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 5 }], shippingMethod: 'standard', customer: customer() });
    assert.equal(c.status, 400);

    const o = await t.buy({ qty: 2 });
    assert.equal((await t.db.getStock('turmeric-1kg')).stock, 1);
    // replaying verify must not decrement again
    const p = await t.store.post('/api/checkout/mock-pay', { providerOrderId: o.providerOrderId, outcome: 'success' });
    await t.store.post('/api/checkout/verify', p.body);
    assert.equal((await t.db.getStock('turmeric-1kg')).stock, 1);

    const cfg = await t.store.get('/api/config');
    assert.equal(cfg.body.products[0].left, 1);
    assert.equal(cfg.body.products[0].stockStatus, 'low');

    await t.admin.post('/api/admin/inventory/turmeric-1kg/adjust', { mode: 'delta', value: -1 });
    const out = await t.store.post('/api/checkout/quote', { items: [{ id: 'turmeric-1kg', qty: 1 }] });
    assert.match(out.body.stockError, /out of stock/);

    const inv = await t.admin.get('/api/admin/inventory');
    assert.equal(inv.body.items[0].status, 'out');
    assert.ok(inv.body.items[0].history.some(h => h.reason === 'sale'));
    assert.equal((await t.admin.post('/api/admin/inventory/turmeric-1kg/adjust', { mode: 'set', value: -4 })).status, 400);
    assert.equal((await t.admin.post('/api/admin/inventory/nope/adjust', { mode: 'set', value: 4 })).status, 404);

    const ov = await t.admin.get('/api/admin/overview');
    assert.ok(ov.body.alerts.some(a => a.level === 'critical' && /Out of stock/.test(a.title)));
  } finally { await t.close(); }
});

test('tracking: needs the matching email, reveals no address, and is throttled', async () => {
  const t = await boot();
  try {
    const o = await t.buy();
    const ok = await t.store.post('/api/orders/track', { orderId: o.id.toLowerCase(), email: ' ASHA@example.com ' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.fulfillment, 'unfulfilled');
    const text = JSON.stringify(ok.body);
    assert.ok(!text.includes('Ganesh') && !text.includes('9876543210') && !text.includes('411004'), 'no address or phone leaks');

    const wrong = await t.store.post('/api/orders/track', { orderId: o.id, email: 'someone@else.com' });
    assert.equal(wrong.status, 404);
    const junk = await t.store.post('/api/orders/track', { orderId: "x' OR 1=1 --", email: 'a@b.co' });
    assert.equal(junk.status, 404);
    let last;
    for (let i = 0; i < 9; i++) last = await t.store.post('/api/orders/track', { orderId: o.id, email: `guess${i}@x.com` });
    assert.equal(last.status, 429);
  } finally { await t.close(); }
});

test('attribution: sanitised, derived from referrer, stored on the order', async () => {
  assert.deepEqual(cleanAttribution({ source: '<script>', medium: 'cpc' }).source, 'direct');
  assert.equal(cleanAttribution({ referrer: 'l.instagram.com' }).source, 'instagram');
  assert.equal(cleanAttribution({ referrer: 'www.google.co.in' }).source, 'google');
  assert.equal(cleanAttribution({ source: 'Newsletter', campaign: 'Diwali Sale' }).campaign, 'diwali sale');
  assert.equal(cleanAttribution({ referrer: 'evil.com/<x>' }).referrer, null);
  const t = await boot();
  try {
    const o = await t.buy({ attribution: { source: 'Instagram', medium: 'paid', campaign: 'diwali' } });
    const row = await t.db.getById(o.id);
    assert.equal(row.utm_source, 'instagram');
    assert.equal(row.utm_campaign, 'diwali');
  } finally { await t.close(); }
});

test('invoice: sequential numbering, GST math adds up, CGST/SGST vs IGST', async () => {
  const t = await boot();
  try {
    await t.admin.login();
    assert.equal((await t.admin.post('/api/admin/settings', { gstin: '27ABCDE1234F1Z5', biz_state: 'Maharashtra', biz_name: 'House of Mangalya' })).status, 200);
    assert.equal((await t.admin.post('/api/admin/settings', { gstin: '12345' })).status, 400);
    assert.equal((await t.admin.post('/api/admin/settings', { hacker: 'x' })).status, 400);

    const a = await t.buy({ qty: 2, couponCode: 'WELCOME10' });
    const b = await t.buy({ qty: 1, cust: customer({ email: 'ravi@example.com', state: 'Karnataka', city: 'Bengaluru', pincode: '560038' }) });
    const ia = (await t.admin.get(`/api/admin/invoices?ids=${a.id}`)).body.documents[0];
    const ib = (await t.admin.get(`/api/admin/invoices?ids=${b.id}`)).body.documents[0];
    assert.match(ia.invoiceNumber, /^HOM\/\d{4}-\d{2}\/00001$/);
    assert.match(ib.invoiceNumber, /\/00002$/);
    const again = (await t.admin.get(`/api/admin/invoices?ids=${a.id}`)).body.documents[0];
    assert.equal(again.invoiceNumber, ia.invoiceNumber, 'number is stable');

    for (const inv of [ia, ib]) {
      assert.equal(inv.taxablePaise + inv.taxPaise, inv.totalPaise, 'taxable + tax = amount paid');
      assert.equal(inv.cgstPaise + inv.sgstPaise + inv.igstPaise, inv.taxPaise);
    }
    assert.equal(ia.intraState, true);
    assert.ok(ia.cgstPaise > 0 && ia.igstPaise === 0);
    assert.equal(ib.intraState, false);
    assert.ok(ib.igstPaise > 0 && ib.cgstPaise === 0);
    assert.equal(ia.discountPaise, 10000);

    assert.equal((await t.admin.get('/api/admin/invoices?ids=HOM-20261020-ZZZZZZZZ')).status, 404);
  } finally { await t.close(); }
});

test('admin insights: customers, cohorts, marketing, economics, recovery, bulk pack', async () => {
  const t = await boot();
  try {
    for (const p of ['overview', 'customers', 'cohorts', 'marketing', 'economics', 'settings', 'coupons', 'inventory', 'abandoned', 'search?q=ab']) {
      assert.equal((await t.admin.get('/api/admin/' + p)).status, 401, p);
    }
    await t.admin.login();

    await t.admin.post('/api/admin/settings', { cogs_per_unit: 200, gst_pct: 5, gateway_fee_pct: 2, gateway_gst_pct: 18 });
    const o1 = await t.buy({ qty: 2, attribution: { source: 'instagram' } });
    await t.buy({ qty: 1, cust: customer({ email: 'ravi@example.com', name: 'Ravi Rao' }), attribution: { source: 'google' } });
    await t.buy({ qty: 1, attribution: { source: 'instagram' } }); // repeat customer (asha)

    const cust = (await t.admin.get('/api/admin/customers')).body;
    assert.equal(cust.total, 2);
    assert.equal(cust.customers[0].email, 'asha@example.com');
    assert.equal(cust.customers[0].orders, 2);
    assert.ok(cust.customers[0].tags.includes('repeat'));
    assert.equal((await t.admin.get('/api/admin/customers?q=ravi')).body.total, 1);
    assert.equal((await t.admin.get('/api/admin/customers?tag=repeat')).body.total, 1);

    const co = (await t.admin.get('/api/admin/cohorts')).body;
    assert.equal(co.rows.length, 1);
    assert.equal(co.rows[0].size, 2);
    assert.equal(co.rows[0].retained[0], 2);

    await t.admin.post('/api/admin/ad-spend', { day: new Date().toISOString().slice(0, 10), channel: 'Instagram', amount: 500, note: 'reel boost' });
    assert.equal((await t.admin.post('/api/admin/ad-spend', { day: 'not-a-date', channel: 'x', amount: 5 })).status, 400);
    const mk = (await t.admin.get('/api/admin/marketing')).body;
    const ig = mk.sources.find(s => s.source === 'instagram');
    assert.equal(ig.paid, 2);
    assert.equal(ig.spendPaise, 50000);
    assert.ok(ig.roas > 0);
    assert.equal(mk.totals.newCustomers, 2);

    // Unit economics on a known order: 2 jars
    const ec = (await t.admin.get('/api/admin/economics')).body;
    assert.equal(ec.configured, true);
    assert.equal(ec.units, 4);
    assert.equal(ec.cogsPaise, 4 * 20000);
    assert.equal(ec.contributionPaise, ec.revenueExTaxPaise - ec.cogsPaise - ec.gatewayPaise);
    assert.equal(ec.profitPaise, ec.contributionPaise - ec.spendPaise);

    const an = (await t.admin.get('/api/admin/analytics')).body;
    assert.equal(an.summary.paid, 3);
    assert.equal(an.weekdays.length, 7);
    assert.ok(an.forecast.runRatePaise >= 0);

    // Failed checkout shows up for recovery
    const c = await t.store.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: customer({ email: 'lost@example.com', name: 'Lost Buyer' }) });
    const p = await t.store.post('/api/checkout/mock-pay', { providerOrderId: c.body.providerOrderId, outcome: 'failure' });
    assert.equal(p.body.failed, true);
    const ab = (await t.admin.get('/api/admin/abandoned')).body;
    assert.equal(ab.total, 1);
    assert.equal(ab.rows[0].kind, 'failed');

    const bulk = await t.admin.post('/api/admin/orders/bulk/fulfillment', { ids: [o1.id, 'junk', o1.id], status: 'packed' });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.updated, 1);
    assert.equal(bulk.body.skipped, 2);
    assert.equal((await t.db.getById(o1.id)).fulfillment_status, 'packed');
    assert.equal((await t.admin.post('/api/admin/orders/bulk/fulfillment', { ids: [o1.id], status: 'shipped' })).status, 400);

    const search = (await t.admin.get('/api/admin/search?q=ravi')).body;
    assert.equal(search.customers.length, 1);
    assert.equal(search.orders.length, 1);

    const csv = await t.admin.get('/api/admin/export/customers.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /asha@example\.com/);
  } finally { await t.close(); }
});

test('database: migrations are idempotent and data survives a restart', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hom-pg-'));
  try {
    const db1 = await openDb({ dataDir: dir });
    await db1.setSetting('biz_name', 'House of Mangalya');
    await db1.close();
    const db2 = await openDb({ dataDir: dir }); // migrate() runs again on the same files
    assert.equal(await db2.getSetting('biz_name'), 'House of Mangalya');
    assert.ok(await db2.getCoupon('WELCOME10'), 'welcome coupon seeded once');
    assert.equal((await db2.listCoupons()).length, 1, 'seeding does not duplicate');
    const [{ version }] = await db2.pg.q('SELECT version FROM schema_meta WHERE id = 1');
    assert.ok(version >= 1);
    await db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
