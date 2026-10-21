'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createMockProvider, createRazorpayProvider, hmacHex } = require('../server/payments');
const { priceOrder } = require('../server/catalog');

const ORIGIN = 'http://localhost:3999';
const WEBHOOK_SECRET = 'whsec_test_secret';
const KEY_SECRET = 'rzp_secret_test';

const customer = {
  name: 'Asha Patil', email: 'asha@example.com', phone: '98765 43210',
  address1: '12 Ganesh Peth Road', address2: '', city: 'Ratnagiri', state: 'Maharashtra', pincode: '415612',
};

async function startServer({ provider, env = {} } = {}) {
  const config = buildConfig({ PUBLIC_ORIGIN: ORIGIN, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env });
  const db = await openDb();
  provider ||= createMockProvider({ db });
  const silent = { info() {}, warn() {}, error() {} };
  const app = createApp({ config, db, provider, log: silent });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(path, body, headers = {}) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  }
  const close = () => new Promise(r => { app.close(); server.close(() => { db.close().then(r); }); });
  return { base, post, db, close };
}

// ── Pricing ────────────────────────────────────────
test('pricing: server ignores client prices and applies shipping rules', () => {
  const one = priceOrder([{ id: 'turmeric-1kg', qty: 1, price: 1 }], 'standard');
  assert.equal(one.subtotalPaise, 50000);
  assert.equal(one.shippingPaise, 8000);
  assert.equal(one.totalPaise, 58000);

  const two = priceOrder([{ id: 'turmeric-1kg', qty: 2 }], 'standard');
  assert.equal(two.shippingPaise, 0, 'free standard shipping above ₹999');

  const express = priceOrder([{ id: 'turmeric-1kg', qty: 2 }], 'express');
  assert.equal(express.shippingPaise, 15000);
});

test('pricing: rejects unknown products, bad quantities, prototype keys', () => {
  assert.throws(() => priceOrder([{ id: 'free-gold', qty: 1 }], 'standard'));
  assert.throws(() => priceOrder([{ id: '__proto__', qty: 1 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: 0 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: -3 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: 1.5 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: 21 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: 15 }, { id: 'turmeric-1kg', qty: 15 }], 'standard'));
  assert.throws(() => priceOrder([{ id: 'turmeric-1kg', qty: 1 }], 'constructor'));
  assert.throws(() => priceOrder([], 'standard'));
});

// ── Config ─────────────────────────────────────────
test('config: production refuses mock payments and http origins', () => {
  assert.throws(() => buildConfig({ NODE_ENV: 'production' }), /Mock payments are disabled/);
  assert.throws(() => buildConfig({
    NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's',
    RAZORPAY_WEBHOOK_SECRET: 'w', PUBLIC_ORIGIN: 'http://shop.example',
  }), /https/);
  assert.doesNotThrow(() => buildConfig({
    NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's',
    RAZORPAY_WEBHOOK_SECRET: 'w', PUBLIC_ORIGIN: 'https://houseofmangalya.com', DATABASE_URL: 'postgres://u:p@db.example.com/x',
  }));
});

// ── Full mock checkout flow ───────────────────────
test('checkout: create → pay → verify marks order paid, idempotently', async () => {
  const s = await startServer();
  try {
    const created = await s.post('/api/checkout/create-order', {
      items: [{ id: 'turmeric-1kg', qty: 1, price: 1 }], shippingMethod: 'standard', customer,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.amountPaise, 58000, 'tampered client price ignored');

    const paid = await s.post('/api/checkout/mock-pay', { providerOrderId: created.body.providerOrderId, outcome: 'success' });
    assert.equal(paid.status, 200);

    const v1 = await s.post('/api/checkout/verify', paid.body);
    assert.equal(v1.status, 200);
    assert.equal(v1.body.status, 'paid');
    assert.equal(v1.body.totalPaise, 58000);

    const v2 = await s.post('/api/checkout/verify', paid.body);
    assert.equal(v2.status, 200, 'replaying a valid verification is harmless');

    const row = await s.db.getByProviderOrderId(created.body.providerOrderId);
    assert.equal(row.status, 'paid');
    assert.equal(row.customer.phone, '+919876543210');
  } finally {
    await s.close();
  }
});

test('checkout: forged signature is rejected and order stays unpaid', async () => {
  const s = await startServer();
  try {
    const created = await s.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer });
    const forged = await s.post('/api/checkout/verify', {
      razorpay_order_id: created.body.providerOrderId,
      razorpay_payment_id: 'pay_attacker123456',
      razorpay_signature: 'a'.repeat(64),
    });
    assert.equal(forged.status, 400);
    assert.equal((await s.db.getByProviderOrderId(created.body.providerOrderId)).status, 'created');
  } finally {
    await s.close();
  }
});

test('checkout: validation errors name the offending field', async () => {
  const s = await startServer();
  try {
    const r = await s.post('/api/checkout/create-order', {
      items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: { ...customer, pincode: '012345' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'pincode');

    const xss = await s.post('/api/checkout/create-order', {
      items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer: { ...customer, name: '<script>alert(1)</script>' },
    });
    assert.equal(xss.status, 400);
    assert.equal(xss.body.field, 'name');
  } finally {
    await s.close();
  }
});

// ── Razorpay provider (fake network) ──────────────
function fakeRazorpayFetch(paymentOverrides = {}) {
  return async (url, opts) => {
    if (url.endsWith('/orders')) {
      const body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 'order_TEST1234567890', amount: body.amount, currency: body.currency }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'pay_TEST1234567890', order_id: 'order_TEST1234567890', status: 'captured', amount: 58000, currency: 'INR', method: 'upi',
      ...paymentOverrides,
    }), { status: 200 });
  };
}

test('razorpay: valid signature but wrong captured amount is rejected', async () => {
  const provider = createRazorpayProvider({ keyId: 'rzp_test_x', keySecret: KEY_SECRET, fetchImpl: fakeRazorpayFetch({ amount: 100 }) });
  const s = await startServer({ provider });
  try {
    await s.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer });
    const r = await s.post('/api/checkout/verify', {
      razorpay_order_id: 'order_TEST1234567890',
      razorpay_payment_id: 'pay_TEST1234567890',
      razorpay_signature: hmacHex(KEY_SECRET, 'order_TEST1234567890|pay_TEST1234567890'),
    });
    assert.equal(r.status, 400);
    assert.equal((await s.db.getByProviderOrderId('order_TEST1234567890')).status, 'created');
  } finally {
    await s.close();
  }
});

test('razorpay: genuine payment is verified server-to-server', async () => {
  const provider = createRazorpayProvider({ keyId: 'rzp_test_x', keySecret: KEY_SECRET, fetchImpl: fakeRazorpayFetch() });
  const s = await startServer({ provider });
  try {
    await s.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer });
    const r = await s.post('/api/checkout/verify', {
      razorpay_order_id: 'order_TEST1234567890',
      razorpay_payment_id: 'pay_TEST1234567890',
      razorpay_signature: hmacHex(KEY_SECRET, 'order_TEST1234567890|pay_TEST1234567890'),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'paid');
  } finally {
    await s.close();
  }
});

// ── Webhooks ───────────────────────────────────────
test('webhook: rejects bad signatures, accepts valid ones, ignores replays', async () => {
  const s = await startServer();
  try {
    const created = await s.post('/api/checkout/create-order', { items: [{ id: 'turmeric-1kg', qty: 1 }], shippingMethod: 'standard', customer });
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_hook123456', order_id: created.body.providerOrderId, amount: 58000, currency: 'INR', method: 'card' } } },
    });

    const bad = await s.post('/api/webhooks/razorpay', payload, { 'X-Razorpay-Signature': 'b'.repeat(64), Origin: '' });
    assert.equal(bad.status, 400);
    assert.equal((await s.db.getByProviderOrderId(created.body.providerOrderId)).status, 'created');

    const sig = hmacHex(WEBHOOK_SECRET, payload);
    const ok = await s.post('/api/webhooks/razorpay', payload, { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': 'evt_1' });
    assert.equal(ok.status, 200);
    assert.equal((await s.db.getByProviderOrderId(created.body.providerOrderId)).status, 'paid');

    const replay = await s.post('/api/webhooks/razorpay', payload, { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': 'evt_1' });
    assert.equal(replay.body.duplicate, true);

    // A late "failed" event must never downgrade a paid order
    const failPayload = payload.replace('payment.captured', 'payment.failed');
    await s.post('/api/webhooks/razorpay', failPayload, { 'X-Razorpay-Signature': hmacHex(WEBHOOK_SECRET, failPayload), 'X-Razorpay-Event-Id': 'evt_2' });
    assert.equal((await s.db.getByProviderOrderId(created.body.providerOrderId)).status, 'paid');
  } finally {
    await s.close();
  }
});

// ── Transport security ────────────────────────────
test('http: cross-origin POST, wrong content type and huge bodies are refused', async () => {
  const s = await startServer();
  try {
    const cross = await s.post('/api/checkout/quote', { items: [] }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);

    const form = await s.post('/api/checkout/quote', 'items=1', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);

    const big = await s.post('/api/checkout/quote', JSON.stringify({ pad: 'x'.repeat(20_000) }));
    assert.equal(big.status, 413);
  } finally {
    await s.close();
  }
});

test('http: rate limit kicks in on order creation', async () => {
  const s = await startServer();
  try {
    let last;
    for (let i = 0; i < 11; i++) last = await s.post('/api/checkout/create-order', { items: [], shippingMethod: 'standard', customer });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally {
    await s.close();
  }
});

test('static: serves pages with security headers, blocks traversal and server files', async () => {
  const s = await startServer();
  try {
    const home = await fetch(s.base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

    for (const p of ['/../server/app.js', '/%2e%2e/server/app.js', '/..%2f.env', '/.env', '/%2e%2e%5cpackage.json', '/js/../../package.json']) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 404, `should block ${p}`);
    }
  } finally {
    await s.close();
  }
});
