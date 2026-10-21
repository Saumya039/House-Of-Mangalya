'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createAdminApp, csvCell } = require('../server/admin/app');
const { hashPassword, verifyPassword } = require('../server/admin/auth');
const { createMockProvider } = require('../server/payments');
const { priceOrder } = require('../server/catalog');

const PASSWORD = 'correct-horse-battery-staple';
const silent = { info() {}, warn() {}, error() {} };

async function startAdmin() {
  const port = 3901;
  const config = buildConfig({
    ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), ADMIN_PORT: String(port), ADMIN_ORIGIN: `http://localhost:${port}`,
  });
  const db = await openDb();
  const provider = createMockProvider({ db });
  const app = createAdminApp({ config, db, provider, log: silent });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = config.admin.origin;

  let cookie = '';
  let csrf = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: origin,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, headers: res.headers, body: json, text };
  }
  async function login() {
    const r = await call('POST', '/api/admin/login', { username: 'admin', password: PASSWORD });
    csrf = r.body?.csrf;
    return r;
  }
  const write = (path, body) => call('POST', path, body, { 'X-CSRF-Token': csrf });

  // One paid order to work with
  const q = priceOrder([{ id: 'turmeric-1kg', qty: 2 }], 'standard');
  const customer = { name: '=HYPERLINK("http://evil")', email: 'buyer@example.com', phone: '+919876543210', address1: '1 Road', address2: '', city: 'Pune', state: 'Maharashtra', pincode: '411004' };
  const gw = await provider.createOrder({ amountPaise: q.totalPaise, currency: 'INR' });
  await db.createOrder({ id: 'HOM-20261020-AAAAAAAA', provider: 'mock', providerOrderId: gw.providerOrderId, customer, ...q });
  const pay = await provider.simulatePayment({ providerOrderId: gw.providerOrderId, amountPaise: q.totalPaise, outcome: 'success' });
  await db.markPaid(gw.providerOrderId, pay.paymentId, 'upi');

  const close = () => new Promise(r => { app.close(); server.close(() => { db.close().then(r); }); });
  return { call, login, write, close, db, base, setCookie: c => { cookie = c; } };
}

test('auth: scrypt hash verifies only the right password', () => {
  const h = hashPassword('s3cret-password!');
  assert.ok(verifyPassword('s3cret-password!', h));
  assert.ok(!verifyPassword('s3cret-password', h));
  assert.ok(!verifyPassword('anything', 'not-a-hash'));
});

test('config: admin exposed beyond localhost must use https', () => {
  assert.throws(() => buildConfig({ ADMIN_PASSWORD_HASH: hashPassword('x'.repeat(12)), ADMIN_HOST: '0.0.0.0' }), /https/);
  assert.throws(() => buildConfig({ ADMIN_PASSWORD_HASH: 'plaintext' }), /admin:password/);
});

test('admin: every API requires a session', async () => {
  const s = await startAdmin();
  try {
    for (const p of ['/api/admin/me', '/api/admin/analytics', '/api/admin/orders', '/api/admin/orders/HOM-20261020-AAAAAAAA',
      '/api/admin/webhooks', '/api/admin/audit', '/api/admin/subscribers', '/api/admin/export/orders.csv', '/api/admin/export/subscribers.csv']) {
      assert.equal((await s.call('GET', p)).status, 401, p);
    }
    assert.equal((await s.call('POST', '/api/admin/orders/HOM-20261020-AAAAAAAA/refund', { confirm: 'HOM-20261020-AAAAAAAA' })).status, 401);
  } finally {
    await s.close();
  }
});

test('admin: wrong password is rejected and repeated failures lock the IP', async () => {
  const s = await startAdmin();
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal((await s.call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' })).status, 401);
    }
    assert.equal((await s.call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' })).status, 429);
    // Even the right password is refused while locked
    assert.equal((await s.login()).status, 429);
  } finally {
    await s.close();
  }
});

test('admin: session cookie is HttpOnly + SameSite=Strict; logout kills it', async () => {
  const s = await startAdmin();
  try {
    const r = await s.login();
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    assert.equal((await s.call('GET', '/api/admin/me')).status, 200);
    const stolen = sc.split(';')[0];
    await s.write('/api/admin/logout');
    s.setCookie(stolen);
    assert.equal((await s.call('GET', '/api/admin/me')).status, 401, 'old token is dead after logout');
  } finally {
    await s.close();
  }
});

test('admin: writes need the CSRF token and same origin', async () => {
  const s = await startAdmin();
  try {
    await s.login();
    const id = 'HOM-20261020-AAAAAAAA';
    assert.equal((await s.call('POST', `/api/admin/orders/${id}/note`, { note: 'x' })).status, 403, 'no CSRF token');
    assert.equal((await s.call('POST', `/api/admin/orders/${id}/note`, { note: 'x' }, { 'X-CSRF-Token': 'forged' })).status, 403);
    assert.equal((await s.write(`/api/admin/orders/${id}/note`, { note: 'Gift wrap please' })).status, 200);
  } finally {
    await s.close();
  }
});

test('admin: analytics, fulfilment, refund and audit trail', async () => {
  const s = await startAdmin();
  try {
    await s.login();
    const id = 'HOM-20261020-AAAAAAAA';

    const a = await s.call('GET', '/api/admin/analytics');
    assert.equal(a.status, 200);
    assert.equal(a.body.summary.paid, 1);
    assert.equal(a.body.summary.grossPaise, 100000);
    assert.equal(a.body.summary.unitsSold, 2);
    assert.equal(a.body.fulfillmentQueue.unfulfilled, 1);

    assert.equal((await s.write(`/api/admin/orders/${id}/fulfillment`, { status: 'shipped' })).status, 400, 'tracking required');
    assert.equal((await s.write(`/api/admin/orders/${id}/fulfillment`, { status: 'shipped', courier: 'BlueDart', trackingNumber: '<x>' })).status, 400);
    const shipped = await s.write(`/api/admin/orders/${id}/fulfillment`, { status: 'shipped', courier: 'BlueDart', trackingNumber: 'BD12345678' });
    assert.equal(shipped.status, 200);
    assert.equal(shipped.body.fulfillment, 'shipped');
    assert.ok(shipped.body.timeline.shippedAt);

    assert.equal((await s.write(`/api/admin/orders/${id}/refund`, { confirm: 'nope' })).status, 400, 'typed confirmation required');
    assert.equal((await s.write(`/api/admin/orders/${id}/refund`, { confirm: id, amountPaise: 999999 })).status, 400, 'cannot refund more than paid');
    const refund = await s.write(`/api/admin/orders/${id}/refund`, { confirm: id });
    assert.equal(refund.status, 200);
    assert.equal(refund.body.status, 'refunded');
    assert.equal((await s.write(`/api/admin/orders/${id}/refund`, { confirm: id })).status, 409, 'no double refunds');

    const after = await s.call('GET', '/api/admin/analytics');
    assert.equal(after.body.summary.netPaise, 0);

    const audit = await s.call('GET', '/api/admin/audit');
    const actions = audit.body.rows.map(r => r.action);
    assert.ok(actions.includes('login') && actions.includes('order.fulfillment') && actions.includes('order.refund'));

    const list = await s.call('GET', '/api/admin/orders?q=buyer@example&payment=refunded');
    assert.equal(list.body.total, 1);
    const none = await s.call('GET', '/api/admin/orders?q=%25');
    assert.equal(none.body.total, 0, 'LIKE wildcards are escaped');
  } finally {
    await s.close();
  }
});

test('admin: CSV export neutralises spreadsheet formulas', async () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  const s = await startAdmin();
  try {
    await s.login();
    const r = await s.call('GET', '/api/admin/export/orders.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.ok(r.text.includes('"\'=HYPERLINK'), 'formula is prefixed with a quote');
  } finally {
    await s.close();
  }
});

test('admin: strict CSP and no caching on every response', async () => {
  const s = await startAdmin();
  try {
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await fetch(s.base + '/../server/admin/auth.js')).status, 404);
  } finally {
    await s.close();
  }
});
