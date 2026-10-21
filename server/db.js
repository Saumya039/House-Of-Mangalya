'use strict';
/* ================================================
   Data access — PostgreSQL (Neon / any Postgres) or PGlite in dev.
   All queries are parameterised; no string-built SQL.
   Every method returns a Promise.
   ================================================ */
const { openAdapter } = require('./pg');
const { migrate } = require('./schema');
const { PRODUCTS } = require('./catalog');

/** Indian financial year (Apr–Mar) of an instant, as '2026-27'. */
function financialYear(iso) {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

const now = () => new Date().toISOString();
const asOrder = row => (row ? { ...row, items: row.items_json, customer: row.customer_json } : null);

/**
 * @param {{databaseUrl?:string, dataDir?:string, defaultStock?:number}} opts
 *   databaseUrl → Postgres; otherwise PGlite (dataDir for a persistent local folder, omit for in-memory)
 */
async function openDb(opts = {}) {
  const pg = await openAdapter(opts);
  await migrate(pg);

  const one = async (text, params) => (await pg.q(text, params))[0] || null;

  // Default stock for every catalog product, and the welcome coupon promised on the site
  const defaultStock = opts.defaultStock ?? 200;
  for (const id of Object.keys(PRODUCTS)) {
    await pg.q('INSERT INTO inventory (product_id, stock, low_threshold, updated_at) VALUES ($1, $2, 10, $3) ON CONFLICT (product_id) DO NOTHING', [id, defaultStock, now()]);
  }
  if (!(await one("SELECT 1 FROM settings WHERE key = 'seed.welcome10'"))) {
    await pg.q(`INSERT INTO coupons (code, kind, value, min_subtotal_paise, max_discount_paise, per_customer_limit, active, description, created_at)
      VALUES ('WELCOME10', 'percent', 10, 0, 20000, 1, 1, 'Newsletter welcome offer — 10% off first order', $1) ON CONFLICT (code) DO NOTHING`, [now()]);
    await pg.q("INSERT INTO settings (key, value) VALUES ('seed.welcome10', '1') ON CONFLICT (key) DO NOTHING");
  }

  async function logStock(t, productId, delta, stockAfter, reason, orderId, actor) {
    await t.q('INSERT INTO stock_log (at, product_id, delta, stock_after, reason, order_id, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [now(), productId, delta, stockAfter, reason, orderId || null, actor || null]);
  }

  /** Runs exactly once per order, inside the same transaction as the transition to paid. */
  async function applyPaidEffects(t, providerOrderId) {
    const [row] = await t.q('SELECT * FROM orders WHERE provider_order_id = $1 FOR UPDATE', [providerOrderId]);
    if (!row || row.effects_applied) return;
    for (const item of row.items_json) {
      await t.q('INSERT INTO inventory (product_id, stock, low_threshold, updated_at) VALUES ($1, 0, 10, $2) ON CONFLICT (product_id) DO NOTHING', [item.id, now()]);
      const [after] = await t.q('UPDATE inventory SET stock = stock - $1, updated_at = $2 WHERE product_id = $3 RETURNING stock', [item.qty, now(), item.id]);
      await logStock(t, item.id, -item.qty, after.stock, 'sale', row.id, 'system');
    }
    if (row.coupon_code) {
      await t.q('UPDATE coupons SET used_count = used_count + 1, discount_given_paise = discount_given_paise + $1 WHERE code = $2', [row.discount_paise, row.coupon_code]);
    }
    await t.q('UPDATE orders SET effects_applied = 1 WHERE id = $1', [row.id]);
  }

  return {
    /** Raw adapter for the reporting modules (queries.js / insights.js). */
    pg,
    engine: pg.engine,

    async createOrder(o) {
      const t = o.createdAt || now();
      const a = o.attribution || {};
      await pg.q(`INSERT INTO orders
        (id, provider, provider_order_id, status, currency, subtotal_paise, shipping_paise, total_paise, shipping_method,
         items_json, customer_json, created_at, updated_at, discount_paise, coupon_code, utm_source, utm_medium, utm_campaign, referrer)
        VALUES ($1,$2,$3,'created',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$11,$12,$13,$14,$15,$16,$17)`,
      [o.id, o.provider, o.providerOrderId, o.currency, o.subtotalPaise, o.shippingPaise, o.totalPaise, o.shippingMethod,
        JSON.stringify(o.lines), JSON.stringify(o.customer), t, o.discountPaise || 0, o.couponCode || null,
        a.source || null, a.medium || null, a.campaign || null, a.referrer || null]);
    },
    async getByProviderOrderId(id) {
      return asOrder(await one('SELECT * FROM orders WHERE provider_order_id = $1', [id]));
    },
    async getById(id) {
      return asOrder(await one('SELECT * FROM orders WHERE id = $1', [id]));
    },

    // Status transitions are guarded in SQL so a paid order can never be downgraded
    async markPaid(providerOrderId, paymentId, method) {
      const t = now();
      return pg.tx(async tx => {
        const r = await tx.run(`UPDATE orders SET status = 'paid', payment_id = $1, payment_method = $2,
          paid_at = COALESCE(paid_at, $3), updated_at = $3 WHERE provider_order_id = $4 AND status <> 'paid'`,
        [paymentId, method || null, t, providerOrderId]);
        if (r.rowCount > 0) await applyPaidEffects(tx, providerOrderId);
        return r.rowCount > 0;
      });
    },
    async markAuthorized(providerOrderId, paymentId, method) {
      const r = await pg.run(`UPDATE orders SET status = 'authorized', payment_id = $1, payment_method = $2, updated_at = $3
        WHERE provider_order_id = $4 AND status IN ('created','failed')`, [paymentId, method || null, now(), providerOrderId]);
      return r.rowCount > 0;
    },
    async markFailed(providerOrderId) {
      const r = await pg.run("UPDATE orders SET status = 'failed', updated_at = $1 WHERE provider_order_id = $2 AND status = 'created'", [now(), providerOrderId]);
      return r.rowCount > 0;
    },

    async hasWebhookEvent(id) {
      return Boolean(await one('SELECT 1 FROM webhook_events WHERE id = $1', [id]));
    },
    /** @returns {Promise<boolean>} true if the event is new (not a replay) */
    async recordWebhookEvent(id, event, info = {}) {
      const r = await pg.run(`INSERT INTO webhook_events (id, event, received_at, provider_order_id, payment_id, amount_paise, outcome)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [id, event, now(), info.providerOrderId || null, info.paymentId || null, Number.isInteger(info.amountPaise) ? info.amountPaise : null, info.outcome || null]);
      return r.rowCount > 0;
    },
    async addSubscriber(email) {
      await pg.q('INSERT INTO newsletter (email, created_at) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [email, now()]);
    },

    async setFulfillment(id, { status, courier, trackingNumber }) {
      const t = now();
      const r = await pg.run(`UPDATE orders SET fulfillment_status = $1, courier = $2, tracking_number = $3,
        shipped_at = CASE WHEN $1 = 'shipped' THEN COALESCE(shipped_at, $4) ELSE shipped_at END,
        delivered_at = CASE WHEN $1 = 'delivered' THEN COALESCE(delivered_at, $4) ELSE delivered_at END,
        updated_at = $4 WHERE id = $5 AND status = 'paid'`, [status, courier || null, trackingNumber || null, t, id]);
      return r.rowCount > 0;
    },
    async setNote(id, note) {
      return (await pg.run('UPDATE orders SET admin_note = $1, updated_at = $2 WHERE id = $3', [note || null, now(), id])).rowCount > 0;
    },
    async setRefund(id, { refundId, status, amountPaise }) {
      const t = now();
      return (await pg.run(`UPDATE orders SET refund_id = $1, refund_status = $2, refunded_paise = $3,
        refunded_at = COALESCE(refunded_at, $4), updated_at = $4 WHERE id = $5 AND status = 'paid'`, [refundId, status, amountPaise, t, id])).rowCount > 0;
    },
    async updateRefundStatusByPayment(paymentId, refundId, status) {
      return (await pg.run(`UPDATE orders SET refund_status = $1, refund_id = COALESCE(refund_id, $2), updated_at = $3
        WHERE payment_id = $4 AND refund_id IS NOT NULL`, [status, refundId, now(), paymentId])).rowCount > 0;
    },
    async audit({ actor, action, orderId = null, detail = null, ip = null }) {
      await pg.q('INSERT INTO audit_log (at, actor, action, order_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)', [now(), actor, action, orderId, detail, ip]);
    },

    // ── Inventory ────────────────────────────────
    getStock: productId => one('SELECT * FROM inventory WHERE product_id = $1', [productId]),
    listInventory: () => pg.q('SELECT * FROM inventory ORDER BY product_id'),
    /** Set an absolute level (`set`) or add/remove units (`delta`). Always logged. */
    adjustStock(productId, { set, delta, reason, actor }) {
      return pg.tx(async t => {
        const [row] = await t.q('SELECT stock FROM inventory WHERE product_id = $1 FOR UPDATE', [productId]);
        if (!row) return null;
        const after = set !== undefined ? set : row.stock + delta;
        await t.q('UPDATE inventory SET stock = $1, updated_at = $2 WHERE product_id = $3', [after, now(), productId]);
        await logStock(t, productId, after - row.stock, after, reason || (set !== undefined ? 'set level' : 'adjustment'), null, actor);
        return (await t.q('SELECT * FROM inventory WHERE product_id = $1', [productId]))[0];
      });
    },
    async setLowThreshold(productId, n) {
      return (await pg.run('UPDATE inventory SET low_threshold = $1, updated_at = $2 WHERE product_id = $3', [n, now(), productId])).rowCount > 0;
    },
    stockHistory: (productId, limit = 30) => pg.q('SELECT * FROM stock_log WHERE product_id = $1 ORDER BY id DESC LIMIT $2', [productId, limit]),

    // ── Coupons ──────────────────────────────────
    getCoupon: code => one('SELECT * FROM coupons WHERE code = $1', [code]),
    listCoupons: () => pg.q('SELECT * FROM coupons ORDER BY active DESC, created_at DESC'),
    async createCoupon(c) {
      await pg.q(`INSERT INTO coupons (code, kind, value, min_subtotal_paise, max_discount_paise, starts_at, expires_at,
        usage_limit, per_customer_limit, active, description, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)`,
      [c.code, c.kind, c.value, c.minSubtotalPaise || 0, c.maxDiscountPaise ?? null, c.startsAt || null, c.expiresAt || null,
        c.usageLimit ?? null, c.perCustomerLimit ?? null, c.description || null, now()]);
    },
    async setCouponActive(code, active) {
      return (await pg.run('UPDATE coupons SET active = $1 WHERE code = $2', [active ? 1 : 0, code])).rowCount > 0;
    },
    async couponUsesByEmail(code, email) {
      const r = await one(`SELECT COUNT(*) AS n FROM orders WHERE coupon_code = $1 AND status = 'paid' AND lower(customer_json->>'email') = $2`, [code, String(email).toLowerCase()]);
      return r.n;
    },

    // ── Settings / ad spend ──────────────────────
    async getSetting(key, fallback = '') {
      return (await one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? fallback;
    },
    async allSettings() {
      const rows = await pg.q("SELECT key, value FROM settings WHERE key NOT LIKE 'seed.%'");
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async setSetting(key, value) {
      await pg.q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
    },
    async addAdSpend({ day, channel, amountPaise, note }) {
      return (await one('INSERT INTO ad_spend (day, channel, amount_paise, note, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [day, channel, amountPaise, note || null, now()])).id;
    },
    listAdSpend: (limit = 200) => pg.q('SELECT * FROM ad_spend ORDER BY day DESC, id DESC LIMIT $1', [limit]),
    async deleteAdSpend(id) {
      return (await pg.run('DELETE FROM ad_spend WHERE id = $1', [id])).rowCount > 0;
    },

    // ── Invoices (sequential per financial year) ──
    ensureInvoice(orderId) {
      return pg.tx(async t => {
        await t.q('SELECT pg_advisory_xact_lock(727002)');
        const [o] = await t.q('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (!o || o.status !== 'paid') return null;
        if (!o.invoice_no) {
          const fy = financialYear(o.paid_at || o.created_at);
          const [{ n }] = await t.q('SELECT COALESCE(MAX(invoice_no), 0) AS n FROM orders WHERE invoice_fy = $1', [fy]);
          await t.q('UPDATE orders SET invoice_no = $1, invoice_fy = $2 WHERE id = $3 AND invoice_no IS NULL', [n + 1, fy, orderId]);
        }
        const [r] = await t.q('SELECT invoice_no, invoice_fy FROM orders WHERE id = $1', [orderId]);
        return { invoiceNo: r.invoice_no, fy: r.invoice_fy };
      });
    },

    // ── Rate limits & lock-outs (shared by every serverless instance) ──
    /** Counts one hit against `key`. @returns {{ok:boolean, retryAfterSec:number}} */
    async hit(key, limit, windowMs) {
      const t = Date.now();
      const r = await one(`INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limits.reset_at <= $3 THEN 1 ELSE rate_limits.count + 1 END,
          reset_at = CASE WHEN rate_limits.reset_at <= $3 THEN $2 ELSE rate_limits.reset_at END
        RETURNING count, reset_at`, [key, t + windowMs, t]);
      if (Math.random() < 0.02) pg.q('DELETE FROM rate_limits WHERE reset_at <= $1', [t]).catch(() => {});
      return { ok: r.count <= limit, retryAfterSec: Math.max(1, Math.ceil((r.reset_at - t) / 1000)) };
    },
    /** Read-only: has this key already used its allowance? */
    async blocked(key, limit) {
      const r = await one('SELECT count, reset_at FROM rate_limits WHERE key = $1', [key]);
      return Boolean(r && r.reset_at > Date.now() && r.count >= limit);
    },
    async clearLimit(key) {
      await pg.q('DELETE FROM rate_limits WHERE key = $1', [key]);
    },

    // ── Admin sessions ───────────────────────────
    async createSession({ tokenHash, username, csrf }) {
      const t = Date.now();
      await pg.q('INSERT INTO admin_sessions (token_hash, username, csrf, created_ms, last_ms) VALUES ($1,$2,$3,$4,$4)', [tokenHash, username, csrf, t]);
      if (Math.random() < 0.05) pg.q('DELETE FROM admin_sessions WHERE created_ms < $1', [t - 9 * 3_600_000]).catch(() => {});
    },
    getSession: tokenHash => one('SELECT * FROM admin_sessions WHERE token_hash = $1', [tokenHash]),
    async touchSession(tokenHash) {
      await pg.q('UPDATE admin_sessions SET last_ms = $1 WHERE token_hash = $2', [Date.now(), tokenHash]);
    },
    async deleteSession(tokenHash) {
      await pg.q('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
    },

    // ── Test-mode gateway (never used in production) ──
    async saveMockPayment(p) {
      await pg.q('INSERT INTO mock_payments (payment_id, order_id, status, amount_paise, currency, method) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.id, p.orderId, p.status, p.amountPaise, p.currency, p.method]);
    },
    async getMockPayment(id) {
      const r = await one('SELECT * FROM mock_payments WHERE payment_id = $1', [id]);
      return r && { id: r.payment_id, orderId: r.order_id, status: r.status, amountPaise: r.amount_paise, currency: r.currency, method: r.method };
    },
    async listMockPaymentsForOrder(orderId) {
      return (await pg.q('SELECT * FROM mock_payments WHERE order_id = $1', [orderId]))
        .map(r => ({ id: r.payment_id, orderId: r.order_id, status: r.status, amountPaise: r.amount_paise, currency: r.currency, method: r.method }));
    },
    async setMockPaymentStatus(id, status) {
      await pg.q('UPDATE mock_payments SET status = $1 WHERE payment_id = $2', [status, id]);
    },

    close: () => pg.close(),
  };
}

module.exports = { openDb, financialYear };
