'use strict';
/* ================================================
   Schema + migrations (PostgreSQL).
   Every statement is idempotent. A version row means a warm
   serverless instance pays one tiny query; a cold start on a new
   version runs the migration under an advisory lock so two
   instances can't race.
   ================================================ */

const VERSION = 1;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS orders (
    id                TEXT PRIMARY KEY,
    provider          TEXT NOT NULL,
    provider_order_id TEXT NOT NULL UNIQUE,
    status            TEXT NOT NULL CHECK (status IN ('created','authorized','paid','failed')),
    currency          TEXT NOT NULL,
    subtotal_paise    INTEGER NOT NULL,
    shipping_paise    INTEGER NOT NULL,
    total_paise       INTEGER NOT NULL,
    shipping_method   TEXT NOT NULL,
    items_json        JSONB NOT NULL,
    customer_json     JSONB NOT NULL,
    payment_id        TEXT UNIQUE,
    payment_method    TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    paid_at           TEXT,
    fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',
    courier           TEXT,
    tracking_number   TEXT,
    admin_note        TEXT,
    shipped_at        TEXT,
    delivered_at      TEXT,
    refund_id         TEXT,
    refund_status     TEXT,
    refunded_paise    INTEGER NOT NULL DEFAULT 0,
    refunded_at       TEXT,
    discount_paise    INTEGER NOT NULL DEFAULT 0,
    coupon_code       TEXT,
    utm_source        TEXT,
    utm_medium        TEXT,
    utm_campaign      TEXT,
    referrer          TEXT,
    invoice_no        INTEGER,
    invoice_fy        TEXT,
    effects_applied   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
    id                TEXT PRIMARY KEY,
    event             TEXT NOT NULL,
    received_at       TEXT NOT NULL,
    provider_order_id TEXT,
    payment_id        TEXT,
    amount_paise      INTEGER,
    outcome           TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS newsletter (email TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id       BIGSERIAL PRIMARY KEY,
    at       TEXT NOT NULL,
    actor    TEXT NOT NULL,
    action   TEXT NOT NULL,
    order_id TEXT,
    detail   TEXT,
    ip       TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS coupons (
    code                 TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL CHECK (kind IN ('percent','flat')),
    value                INTEGER NOT NULL,
    min_subtotal_paise   INTEGER NOT NULL DEFAULT 0,
    max_discount_paise   INTEGER,
    starts_at            TEXT,
    expires_at           TEXT,
    usage_limit          INTEGER,
    per_customer_limit   INTEGER,
    used_count           INTEGER NOT NULL DEFAULT 0,
    discount_given_paise BIGINT NOT NULL DEFAULT 0,
    active               INTEGER NOT NULL DEFAULT 1,
    description          TEXT,
    created_at           TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inventory (
    product_id    TEXT PRIMARY KEY,
    stock         INTEGER NOT NULL DEFAULT 0,
    low_threshold INTEGER NOT NULL DEFAULT 10,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stock_log (
    id          BIGSERIAL PRIMARY KEY,
    at          TEXT NOT NULL,
    product_id  TEXT NOT NULL,
    delta       INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    reason      TEXT,
    order_id    TEXT,
    actor       TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ad_spend (
    id           BIGSERIAL PRIMARY KEY,
    day          TEXT NOT NULL,
    channel      TEXT NOT NULL,
    amount_paise BIGINT NOT NULL,
    note         TEXT,
    created_at   TEXT NOT NULL
  )`,
  // Shared across serverless instances (rate limits and login lock-outs must not be per-process)
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    csrf       TEXT NOT NULL,
    created_ms BIGINT NOT NULL,
    last_ms    BIGINT NOT NULL
  )`,
  // Test-mode gateway state (only used outside production)
  `CREATE TABLE IF NOT EXISTS mock_payments (
    payment_id   TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL,
    status       TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    currency     TEXT NOT NULL,
    method       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_coupon ON orders (coupon_code)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_email ON orders ((lower(customer_json->>'email')))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice ON orders (invoice_fy, invoice_no) WHERE invoice_no IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_log (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_received ON webhook_events (received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_log_product ON stock_log (product_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ad_spend_day ON ad_spend (day)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits (reset_at)`,
];

async function migrate(db) {
  await db.q('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  const [row] = await db.q('SELECT version FROM schema_meta WHERE id = 1');
  if (row && row.version >= VERSION) return;
  await db.tx(async t => {
    await t.q('SELECT pg_advisory_xact_lock(727001)');
    const [again] = await t.q('SELECT version FROM schema_meta WHERE id = 1');
    if (again && again.version >= VERSION) return;
    for (const s of STATEMENTS) await t.q(s);
    await t.q('INSERT INTO schema_meta (id, version) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version', [VERSION]);
  });
}

module.exports = { migrate, VERSION };
