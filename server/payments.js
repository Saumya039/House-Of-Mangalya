'use strict';
/* ================================================
   Payment providers.
   - razorpay: real gateway (PCI-DSS L1). Card/UPI data is
     entered inside Razorpay's hosted Checkout and never
     touches this server.
   - mock: local development only. Refused in production.
   Both expose the same interface so the checkout flow and
   signature verification path are identical.
   ================================================ */
const crypto = require('node:crypto');

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two hex strings. */
function safeEqualHex(expectedHex, receivedHex) {
  if (typeof receivedHex !== 'string' || !/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(receivedHex.toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPaymentSignature({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId || !secret) return false;
  return safeEqualHex(hmacHex(secret, `${orderId}|${paymentId}`), signature);
}

function verifyWebhookSignature({ rawBody, signature, secret }) {
  if (!Buffer.isBuffer(rawBody) || !secret) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature);
}

class GatewayError extends Error {}

function createRazorpayProvider({ keyId, keySecret, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(RAZORPAY_API + path, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new GatewayError(`Payment gateway unreachable (${e.name})`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Log only the gateway's error code — never the auth header or customer data
      throw new GatewayError(`Gateway ${method} ${path.split('/')[1]} failed: ${res.status} ${data?.error?.code || ''}`);
    }
    return data;
  }

  return {
    name: 'razorpay',
    publicKey: keyId,
    async createOrder({ amountPaise, currency, receipt, notes }) {
      const o = await call('POST', '/orders', { amount: amountPaise, currency, receipt, notes });
      return { providerOrderId: o.id, amountPaise: o.amount, currency: o.currency };
    },
    async fetchPayment(paymentId) {
      if (!/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) throw new GatewayError('Invalid payment id');
      const p = await call('GET', `/payments/${paymentId}`);
      return mapPayment(p);
    },
    async fetchOrderPayments(providerOrderId) {
      if (!/^order_[A-Za-z0-9]{6,40}$/.test(providerOrderId)) throw new GatewayError('Invalid order id');
      const r = await call('GET', `/orders/${providerOrderId}/payments`);
      return (r.items || []).map(mapPayment);
    },
    async refund({ paymentId, amountPaise, receipt }) {
      if (!/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) throw new GatewayError('Invalid payment id');
      const r = await call('POST', `/payments/${paymentId}/refund`, { amount: amountPaise, speed: 'normal', receipt });
      return { refundId: r.id, status: r.status, amountPaise: r.amount };
    },
    verifyPaymentSignature: args => verifyPaymentSignature({ ...args, secret: keySecret }),
  };
}

function mapPayment(p) {
  return { id: p.id, orderId: p.order_id, status: p.status, amountPaise: p.amount, currency: p.currency, method: p.method };
}

/**
 * Test-mode gateway. State lives in the database (serverless instances don't share memory) and
 * signatures use a secret derived from the deployment's own database URL, so they can't be forged
 * without access to your environment. Never constructed in production.
 */
function createMockProvider({ db, secretSeed = 'local' }) {
  const secret = crypto.createHash('sha256').update('mock-gateway:' + secretSeed).digest('hex');
  return {
    name: 'mock',
    publicKey: 'mock',
    async createOrder({ amountPaise, currency }) {
      return { providerOrderId: 'order_mock' + crypto.randomBytes(8).toString('hex'), amountPaise, currency };
    },
    /** Simulates the customer completing payment in the gateway popup. */
    async simulatePayment({ providerOrderId, amountPaise, outcome }) {
      const paymentId = 'pay_mock' + crypto.randomBytes(8).toString('hex');
      const status = outcome === 'success' ? 'captured' : 'failed';
      await db.saveMockPayment({ id: paymentId, orderId: providerOrderId, status, amountPaise, currency: 'INR', method: 'mock' });
      if (status !== 'captured') return { paymentId, failed: true };
      return { paymentId, signature: hmacHex(secret, `${providerOrderId}|${paymentId}`) };
    },
    async fetchPayment(paymentId) {
      const p = await db.getMockPayment(paymentId);
      if (!p) throw new GatewayError('Unknown payment');
      return p;
    },
    fetchOrderPayments: providerOrderId => db.listMockPaymentsForOrder(providerOrderId),
    async refund({ paymentId, amountPaise }) {
      const p = await db.getMockPayment(paymentId);
      if (p && p.status !== 'captured') throw new GatewayError('Payment is not captured');
      if (p) await db.setMockPaymentStatus(paymentId, 'refunded');
      return { refundId: 'rfnd_mock' + crypto.randomBytes(8).toString('hex'), status: 'processed', amountPaise };
    },
    verifyPaymentSignature: args => verifyPaymentSignature({ ...args, secret }),
  };
}

function createProvider(config, db) {
  if (config.provider === 'razorpay') return createRazorpayProvider(config.razorpay);
  if (config.isProduction) throw new Error('Mock payment provider is not allowed in production');
  return createMockProvider({ db, secretSeed: config.databaseUrl || 'local' });
}

module.exports = {
  GatewayError,
  createProvider,
  createRazorpayProvider,
  createMockProvider,
  verifyPaymentSignature,
  verifyWebhookSignature,
  hmacHex,
};
