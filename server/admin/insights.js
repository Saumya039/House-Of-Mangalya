'use strict';
/* ================================================
   Business insights for the admin portal (PostgreSQL).
   Everything is computed from the order database; dates are IST.
   Money is integer paise throughout.
   ================================================ */
const { parseRange } = require('./queries');
const { INDIAN_STATES } = require('../validate');

const IST = "'Asia/Kolkata'";
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ABANDON_AFTER_MS = HOUR;

const istDate = iso => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
const istMonth = iso => istDate(iso).slice(0, 7);
const rupees = paise => Math.round(paise / 100);

// ── Settings ─────────────────────────────────────
const num = (lo, hi) => v => {
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`must be a number between ${lo} and ${hi}`);
  return String(n);
};
const text = max => v => {
  if (typeof v !== 'string') throw new Error('must be text');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (s.length > max) throw new Error(`must be at most ${max} characters`);
  return s;
};
const SETTINGS = {
  biz_name: ['Business name', text(80)],
  biz_address: ['Registered address', text(240)],
  biz_state: ['State', v => { const s = text(60)(v); if (s && !INDIAN_STATES.includes(s)) throw new Error('select a valid state'); return s; }],
  gstin: ['GSTIN', v => { const s = text(15)(v).toUpperCase(); if (s && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) throw new Error('is not a valid 15-character GSTIN'); return s; }],
  fssai: ['FSSAI licence no.', v => { const s = text(14)(v); if (s && !/^\d{14}$/.test(s)) throw new Error('must be 14 digits'); return s; }],
  biz_phone: ['Phone', text(20)],
  biz_email: ['Email', v => { const s = text(120)(v); if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error('is not a valid email'); return s; }],
  invoice_prefix: ['Invoice prefix', v => { const s = text(8)(v).toUpperCase(); if (s && !/^[A-Z0-9]{1,8}$/.test(s)) throw new Error('letters and digits only'); return s; }],
  hsn_code: ['HSN code', v => { const s = text(8)(v); if (s && !/^\d{4,8}$/.test(s)) throw new Error('must be 4–8 digits'); return s; }],
  invoice_note: ['Invoice footer note', text(240)],
  gst_pct: ['GST rate (%)', num(0, 28)],
  cogs_per_unit: ['Cost per jar (₹)', num(0, 100000)],
  packaging_per_order: ['Packaging per order (₹)', num(0, 10000)],
  courier_per_order: ['Courier cost per order (₹)', num(0, 10000)],
  gateway_fee_pct: ['Gateway fee (%)', num(0, 10)],
  gateway_gst_pct: ['GST on gateway fee (%)', num(0, 28)],
  fixed_costs_monthly: ['Fixed monthly costs (₹)', num(0, 1e9)],
  target_monthly_revenue: ['Monthly revenue goal (₹)', num(0, 1e10)],
};
const SETTING_DEFAULTS = {
  gst_pct: '5', gateway_fee_pct: '2', gateway_gst_pct: '18', invoice_prefix: 'HOM', hsn_code: '0910',
  cogs_per_unit: '0', packaging_per_order: '0', courier_per_order: '0', fixed_costs_monthly: '0', target_monthly_revenue: '0',
};

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settings');
  const clean = {};
  for (const [k, v] of Object.entries(input)) {
    if (!Object.hasOwn(SETTINGS, k)) throw new Error(`Unknown setting "${k}"`);
    try {
      clean[k] = SETTINGS[k][1](v);
    } catch (e) {
      throw new Error(`${SETTINGS[k][0]} ${e.message}`);
    }
  }
  return clean;
}

async function settingsWithDefaults(db) {
  return { ...Object.fromEntries(Object.keys(SETTINGS).map(k => [k, SETTING_DEFAULTS[k] ?? ''])), ...(await db.allSettings()) };
}
const n = (settings, k) => Number(settings[k]) || 0;

function createInsights(db) {
  const pg = db.pg;
  const q = (text, params = {}) => pg.named(text, params);
  const one = async (text, params) => (await q(text, params))[0];

  // ── Customers ──────────────────────────────────
  async function allCustomers() {
    const nowMs = Date.now();
    const rows = await q(`
      SELECT lower(customer_json->>'email') AS email,
             MAX(customer_json->>'name')  AS name,
             MAX(customer_json->>'phone') AS phone,
             MAX(customer_json->>'city')  AS city,
             MAX(customer_json->>'state') AS state,
             COUNT(*) AS orders,
             SUM(total_paise - refunded_paise) AS "ltvPaise",
             MIN(COALESCE(paid_at, created_at)) AS "firstOrder",
             MAX(COALESCE(paid_at, created_at)) AS "lastOrder"
      FROM orders WHERE status = 'paid' GROUP BY 1`);
    return rows.map(c => {
      const daysSince = Math.floor((nowMs - Date.parse(c.lastOrder)) / DAY);
      const tags = [];
      if (c.orders >= 3 || c.ltvPaise >= 300_000) tags.push('vip');
      if (c.orders >= 2) tags.push('repeat');
      if (c.orders === 1 && daysSince <= 30) tags.push('new');
      if (daysSince > 60) tags.push('lapsed');
      return { ...c, aovPaise: Math.round(c.ltvPaise / c.orders), daysSinceLast: daysSince, tags };
    });
  }

  async function customers(f = {}) {
    let rows = await allCustomers();
    const counts = { all: rows.length, vip: 0, repeat: 0, new: 0, lapsed: 0 };
    for (const r of rows) for (const t of r.tags) counts[t] += 1;
    if (f.tag && Object.hasOwn(counts, f.tag) && f.tag !== 'all') rows = rows.filter(r => r.tags.includes(f.tag));
    if (typeof f.q === 'string' && f.q.trim()) {
      const term = f.q.trim().toLowerCase().slice(0, 80);
      rows = rows.filter(r => [r.name, r.email, r.phone, r.city].some(v => String(v || '').toLowerCase().includes(term)));
    }
    const sorts = {
      ltv: (a, b) => b.ltvPaise - a.ltvPaise, orders: (a, b) => b.orders - a.orders,
      last: (a, b) => b.lastOrder.localeCompare(a.lastOrder), name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    rows.sort(sorts[f.sort] || sorts.ltv);
    const pageSize = Math.min(Math.max(Number.parseInt(f.pageSize, 10) || 25, 5), 100);
    const page = Math.max(Number.parseInt(f.page, 10) || 1, 1);
    const total = rows.length;
    return {
      counts, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      customers: rows.slice((page - 1) * pageSize, page * pageSize),
      repeatRate: counts.all ? counts.repeat / counts.all : 0,
    };
  }

  const exportCustomers = async () => (await allCustomers()).sort((a, b) => b.ltvPaise - a.ltvPaise);

  // ── Cohorts ────────────────────────────────────
  async function cohorts() {
    const byEmail = new Map();
    const rows = await q(`
      SELECT lower(customer_json->>'email') AS email,
             to_char((COALESCE(paid_at, created_at)::timestamptz AT TIME ZONE ${IST}), 'YYYY-MM') AS ym
      FROM orders WHERE status = 'paid' GROUP BY 1, 2`);
    for (const r of rows) {
      if (!byEmail.has(r.email)) byEmail.set(r.email, []);
      byEmail.get(r.email).push(r.ym);
    }
    const monthIdx = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
    const nowIdx = monthIdx(istMonth(new Date().toISOString()));
    const groups = new Map();
    for (const months of byEmail.values()) {
      const idx = months.map(monthIdx).sort((a, b) => a - b);
      const first = idx[0];
      if (!groups.has(first)) groups.set(first, []);
      groups.get(first).push(new Set(idx));
    }
    const out = [...groups.entries()].sort((a, b) => b[0] - a[0]).slice(0, 12).reverse().map(([first, sets]) => {
      const maxOffset = Math.min(6, nowIdx - first);
      const retained = [];
      for (let k = 0; k <= 6; k++) retained.push(k > maxOffset ? null : sets.filter(s => s.has(first + k)).length);
      const y = Math.floor(first / 12);
      const m = (first % 12) + 1;
      return { month: `${y}-${String(m).padStart(2, '0')}`, size: sets.length, retained, pct: retained.map(r => (r === null ? null : r / sets.length)) };
    });
    return { rows: out, offsets: [0, 1, 2, 3, 4, 5, 6] };
  }

  // ── Marketing & attribution ────────────────────
  async function marketing(fromDay, toDay) {
    const r = parseRange(fromDay, toDay);
    const p = { start: r.start, end: r.end, from: r.from, to: r.to };
    const [spendRows, sourceRows, campaigns, newCust, spendLog] = await Promise.all([
      q('SELECT channel, SUM(amount_paise) AS "spendPaise" FROM ad_spend WHERE day >= :from AND day <= :to GROUP BY 1', p),
      q(`SELECT COALESCE(utm_source, 'unknown') AS source, COUNT(*) AS checkouts,
           COUNT(*) FILTER (WHERE status = 'paid') AS paid,
           COALESCE(SUM(total_paise) FILTER (WHERE status = 'paid'), 0) AS "revenuePaise"
         FROM orders WHERE created_at >= :start AND created_at < :end GROUP BY 1 ORDER BY 4 DESC, 2 DESC`, p),
      q(`SELECT COALESCE(utm_campaign, '—') AS campaign, COALESCE(utm_source, 'unknown') AS source, COUNT(*) AS checkouts,
           COUNT(*) FILTER (WHERE status = 'paid') AS paid,
           COALESCE(SUM(total_paise) FILTER (WHERE status = 'paid'), 0) AS "revenuePaise"
         FROM orders WHERE created_at >= :start AND created_at < :end AND utm_campaign IS NOT NULL
         GROUP BY 1, 2 ORDER BY 5 DESC LIMIT 15`, p),
      one(`SELECT COUNT(*) AS n FROM (
             SELECT lower(customer_json->>'email') AS e, MIN(COALESCE(paid_at, created_at)) AS first_at
             FROM orders WHERE status = 'paid' GROUP BY 1) t WHERE first_at >= :start AND first_at < :end`, p),
      db.listAdSpend(100),
    ]);
    const spend = new Map(spendRows.map(x => [x.channel.toLowerCase(), x.spendPaise]));
    const sources = sourceRows.map(s => {
      const sp = spend.get(s.source) || 0;
      return { ...s, spendPaise: sp, roas: sp ? s.revenuePaise / sp : null, conversion: s.checkouts ? s.paid / s.checkouts : 0 };
    });
    for (const [channel, sp] of spend) {
      if (!sources.some(s => s.source === channel)) sources.push({ source: channel, checkouts: 0, paid: 0, revenuePaise: 0, spendPaise: sp, roas: 0, conversion: 0 });
    }
    const totalSpend = [...spend.values()].reduce((a, b) => a + b, 0);
    const paidRevenue = sources.reduce((a, s) => a + s.revenuePaise, 0);
    const newCustomers = newCust.n;
    return {
      range: { from: r.from, to: r.to, days: r.days },
      sources, campaigns,
      totals: {
        spendPaise: totalSpend, newCustomers, revenuePaise: paidRevenue,
        cacPaise: newCustomers && totalSpend ? Math.round(totalSpend / newCustomers) : null,
        roas: totalSpend ? paidRevenue / totalSpend : null,
      },
      spend: spendLog,
    };
  }

  // ── Unit economics ─────────────────────────────
  async function economics(fromDay, toDay) {
    const r = parseRange(fromDay, toDay);
    const p = { start: r.start, end: r.end, from: r.from, to: r.to };
    const s = await settingsWithDefaults(db);
    const [e, unitsRow, spendRow] = await Promise.all([
      one(`SELECT COUNT(*) AS orders,
             COALESCE(SUM(total_paise), 0) AS "grossPaise",
             COALESCE(SUM(refunded_paise) FILTER (WHERE refund_status IN ('processed','pending')), 0) AS "refundedPaise",
             COUNT(*) FILTER (WHERE refund_id IS NULL) AS "keptOrders",
             COALESCE(SUM(discount_paise), 0) AS "discountPaise",
             COALESCE(SUM(shipping_paise), 0) AS "shippingPaise"
           FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end`, p),
      one(`SELECT COALESCE(SUM((j.value->>'qty')::int), 0) AS units
           FROM orders o, jsonb_array_elements(o.items_json) AS j(value)
           WHERE o.status = 'paid' AND o.refund_id IS NULL AND o.created_at >= :start AND o.created_at < :end`, p),
      one('SELECT COALESCE(SUM(amount_paise), 0) AS "spendPaise" FROM ad_spend WHERE day >= :from AND day <= :to', p),
    ]);
    const units = unitsRow.units;
    const spendPaise = spendRow.spendPaise;

    const gstPct = n(s, 'gst_pct');
    const netRevenuePaise = e.grossPaise - e.refundedPaise;
    const gstPaise = Math.round((netRevenuePaise * gstPct) / (100 + gstPct));
    const revenueExTaxPaise = netRevenuePaise - gstPaise;
    const cogsPaise = Math.round(units * n(s, 'cogs_per_unit') * 100);
    const packagingPaise = Math.round(e.keptOrders * n(s, 'packaging_per_order') * 100);
    const courierPaise = Math.round(e.orders * n(s, 'courier_per_order') * 100);
    const gatewayPaise = Math.round(e.grossPaise * (n(s, 'gateway_fee_pct') / 100) * (1 + n(s, 'gateway_gst_pct') / 100));
    const contributionPaise = revenueExTaxPaise - cogsPaise - packagingPaise - courierPaise - gatewayPaise;
    const fixedPaise = Math.round((n(s, 'fixed_costs_monthly') * 100 * r.days) / 30);
    const profitPaise = contributionPaise - spendPaise - fixedPaise;
    const keptOrders = e.keptOrders;
    return {
      range: { from: r.from, to: r.to, days: r.days },
      configured: n(s, 'cogs_per_unit') > 0,
      orders: e.orders, keptOrders, units,
      grossPaise: e.grossPaise, refundedPaise: e.refundedPaise, discountPaise: e.discountPaise,
      gstPaise, revenueExTaxPaise, cogsPaise, packagingPaise, courierPaise, gatewayPaise,
      contributionPaise, spendPaise, fixedPaise, profitPaise,
      contributionMargin: revenueExTaxPaise > 0 ? contributionPaise / revenueExTaxPaise : 0,
      perOrder: keptOrders ? {
        revenueExTaxPaise: Math.round(revenueExTaxPaise / keptOrders),
        contributionPaise: Math.round(contributionPaise / keptOrders),
      } : null,
      // The most you can pay to acquire a customer on their first order and break even
      breakEvenCacPaise: keptOrders ? Math.max(0, Math.round(contributionPaise / keptOrders)) : null,
    };
  }

  // ── Abandoned / failed checkouts to follow up ──
  async function abandoned(days = 7) {
    const d = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 60);
    const now = Date.now();
    const rows = await pg.q(`
      SELECT o.id, o.status, o.created_at, o.total_paise, o.customer_json, o.coupon_code, o.utm_source
      FROM orders o
      WHERE ((o.status = 'created' AND o.created_at < $1) OR o.status = 'failed') AND o.created_at >= $2
        AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.status = 'paid' AND p.created_at >= o.created_at
              AND lower(p.customer_json->>'email') = lower(o.customer_json->>'email'))
      ORDER BY o.created_at DESC LIMIT 300`, [new Date(now - ABANDON_AFTER_MS).toISOString(), new Date(now - d * DAY).toISOString()]);
    const list = rows.map(o => {
      const c = o.customer_json;
      return { id: o.id, kind: o.status === 'failed' ? 'failed' : 'abandoned', createdAt: o.created_at, totalPaise: o.total_paise,
        name: c.name, email: c.email, phone: c.phone, city: c.city, coupon: o.coupon_code, source: o.utm_source };
    });
    return { days: d, total: list.length, valuePaise: list.reduce((a, o) => a + o.totalPaise, 0), rows: list };
  }

  // ── Dashboard extras ───────────────────────────
  async function analyticsExtras(fromDay, toDay) {
    const r = parseRange(fromDay, toDay);
    const p = { start: r.start, end: r.end };
    const today = istDate(new Date().toISOString());
    const from14 = new Date(Date.parse(today + 'T00:00:00+05:30') - 14 * DAY).toISOString();
    const monthStart = today.slice(0, 8) + '01';
    const mStart = new Date(monthStart + 'T00:00:00+05:30').toISOString();

    const [weekdayRows, discounts, last14, monthRows, settings] = await Promise.all([
      q(`SELECT EXTRACT(DOW FROM (created_at::timestamptz AT TIME ZONE ${IST}))::int AS dow, COUNT(*) AS orders,
           COALESCE(SUM(total_paise), 0) AS "revenuePaise"
         FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end GROUP BY 1`, p),
      one(`SELECT COALESCE(SUM(discount_paise), 0) AS "discountPaise", COUNT(*) FILTER (WHERE discount_paise > 0) AS "couponOrders"
           FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end`, p),
      q(`SELECT to_char((created_at::timestamptz AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS day, COALESCE(SUM(total_paise), 0) AS "revenuePaise"
         FROM orders WHERE status = 'paid' AND created_at >= :start GROUP BY 1`, { start: from14 }),
      one("SELECT COALESCE(SUM(total_paise), 0) AS r FROM orders WHERE status = 'paid' AND created_at >= :start", { start: mStart }),
      settingsWithDefaults(db),
    ]);
    const dow = Array.from({ length: 7 }, () => ({ orders: 0, revenuePaise: 0 }));
    for (const w of weekdayRows) dow[w.dow] = { orders: w.orders, revenuePaise: w.revenuePaise };

    const byDay = new Map(last14.map(x => [x.day, x.revenuePaise]));
    let sum = 0;
    for (let i = 1; i <= 14; i++) sum += byDay.get(istDate(new Date(Date.parse(today + 'T12:00:00+05:30') - i * DAY).toISOString())) || 0;
    const runRatePaise = Math.round(sum / 14);
    const mtd = monthRows.r;
    const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    const dayOfMonth = Number(today.slice(8, 10));
    const goalPaise = Math.round(n(settings, 'target_monthly_revenue') * 100);

    return {
      weekdays: dow,
      discounts,
      forecast: {
        runRatePaise, projected30Paise: runRatePaise * 30,
        monthToDatePaise: mtd, monthProjectedPaise: Math.round(mtd + runRatePaise * (daysInMonth - dayOfMonth)),
        goalPaise, goalProgress: goalPaise ? mtd / goalPaise : null, dayOfMonth, daysInMonth,
      },
    };
  }

  // ── Action center ──────────────────────────────
  const TO_SHIP = "status = 'paid' AND refund_id IS NULL AND fulfillment_status IN ('unfulfilled','packed')";

  async function overview(provider) {
    const nowMs = Date.now();
    const iso = ms => new Date(nowMs - ms).toISOString();
    const todayStart = new Date(istDate(new Date(nowMs).toISOString()) + 'T00:00:00+05:30').getTime();
    const dayAgg = `SELECT COUNT(*) AS orders, COUNT(*) FILTER (WHERE status = 'paid') AS paid,
        COALESCE(SUM(total_paise) FILTER (WHERE status = 'paid'), 0) AS "revenuePaise"
      FROM orders WHERE created_at >= :start AND created_at < :end`;

    const [stock, old, toShipAll, auth, failed, refundsPending, ab, paidRecent, hooksRecent, t, y] = await Promise.all([
      db.listInventory(),
      one(`SELECT COUNT(*) AS n, MIN(paid_at) AS oldest FROM orders WHERE ${TO_SHIP} AND paid_at < :cutoff`, { cutoff: iso(48 * HOUR) }),
      one(`SELECT COUNT(*) AS n FROM orders WHERE ${TO_SHIP}`),
      one("SELECT COUNT(*) AS n FROM orders WHERE status = 'authorized' AND updated_at < :cutoff", { cutoff: iso(30 * 60_000) }),
      one("SELECT COUNT(*) AS n FROM orders WHERE status = 'failed' AND updated_at >= :cutoff", { cutoff: iso(24 * HOUR) }),
      one("SELECT COUNT(*) AS n FROM orders WHERE refund_status = 'pending'"),
      one("SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS v FROM orders WHERE status = 'created' AND created_at < :abandon AND created_at >= :cutoff", { abandon: iso(ABANDON_AFTER_MS), cutoff: iso(24 * HOUR) }),
      one("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND created_at >= :cutoff", { cutoff: iso(48 * HOUR) }),
      one('SELECT COUNT(*) AS n FROM webhook_events WHERE received_at >= :cutoff', { cutoff: iso(48 * HOUR) }),
      one(dayAgg, { start: new Date(todayStart).toISOString(), end: new Date(todayStart + DAY).toISOString() }),
      one(dayAgg, { start: new Date(todayStart - DAY).toISOString(), end: new Date(todayStart).toISOString() }),
    ]);

    const alerts = [];
    const add = (level, title, detail, link) => alerts.push({ level, title, detail, link });
    for (const s of stock) {
      if (s.stock <= 0) add('critical', `Out of stock: ${s.product_id}`, s.stock < 0 ? `Oversold by ${-s.stock} — customers may be waiting` : 'The store has stopped selling it.', '#inventory');
      else if (s.stock <= s.low_threshold) add('warning', `Low stock: ${s.product_id}`, `${s.stock} left (alert at ${s.low_threshold}). Reorder soon.`, '#inventory');
    }
    if (old.n) add('critical', `${old.n} paid order${old.n > 1 ? 's' : ''} waiting over 48 hours`, `Oldest paid ${Math.floor((nowMs - Date.parse(old.oldest)) / HOUR)}h ago — ship or contact the customer.`, '#fulfilment');
    else if (toShipAll.n) add('info', `${toShipAll.n} order${toShipAll.n > 1 ? 's' : ''} to pack and ship`, 'All within 48 hours.', '#fulfilment');
    if (auth.n) add('warning', `${auth.n} payment${auth.n > 1 ? 's' : ''} authorised but not captured`, 'Enable auto-capture in Razorpay, or open the order and use “Check status with gateway”.', '#orders');
    if (failed.n >= 3) add('warning', `${failed.n} failed payments in 24 hours`, 'Check the gateway status and your UPI/card success rate.', '#recover');
    if (refundsPending.n) add('info', `${refundsPending.n} refund${refundsPending.n > 1 ? 's' : ''} still processing`, 'Razorpay will confirm by webhook.', '#orders');
    if (ab.n) add('info', `${ab.n} abandoned checkout${ab.n > 1 ? 's' : ''} today (₹${rupees(ab.v).toLocaleString('en-IN')})`, 'Message them on WhatsApp from the Recover page.', '#recover');
    if (provider === 'razorpay' && paidRecent.n > 0 && hooksRecent.n === 0) {
      add('warning', 'No webhooks received in 48 hours', 'Payments are still confirmed when customers return to the site, but a missed webhook can leave an order unpaid. Check the webhook URL and secret in Razorpay.', '#payments');
    }
    const order = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => order[a.level] - order[b.level]);
    return { alerts, today: t, yesterday: y, toShip: toShipAll.n };
  }

  // ── GST invoices / packing slips ───────────────
  async function invoiceData(orderId) {
    const inv = await db.ensureInvoice(orderId);
    if (!inv) return null;
    const o = await db.getById(orderId);
    const s = await settingsWithDefaults(db);
    const gstPct = n(s, 'gst_pct');
    const sameState = Boolean(s.biz_state) && s.biz_state === o.customer.state;

    const subtotal = o.items.reduce((a, i) => a + i.lineTotalPaise, 0);
    let remaining = o.discount_paise;
    const lines = o.items.map((i, idx) => {
      const share = idx === o.items.length - 1 ? remaining : Math.min(remaining, Math.round((o.discount_paise * i.lineTotalPaise) / (subtotal || 1)));
      remaining -= share;
      return { name: `${i.name} (${i.weight})`, qty: i.qty, unitPaise: i.unitPaise, grossPaise: i.lineTotalPaise, discountPaise: share, payablePaise: i.lineTotalPaise - share };
    });
    if (o.shipping_paise > 0) {
      lines.push({ name: `Delivery charge (${o.shipping_method})`, qty: 1, unitPaise: o.shipping_paise, grossPaise: o.shipping_paise, discountPaise: 0, payablePaise: o.shipping_paise });
    }
    for (const l of lines) {
      l.taxablePaise = Math.round((l.payablePaise * 100) / (100 + gstPct));
      l.taxPaise = l.payablePaise - l.taxablePaise;
    }
    const taxPaise = lines.reduce((a, l) => a + l.taxPaise, 0);
    const taxablePaise = lines.reduce((a, l) => a + l.taxablePaise, 0);
    const cgst = sameState ? Math.floor(taxPaise / 2) : 0;
    return {
      invoiceNumber: `${s.invoice_prefix || 'HOM'}/${inv.fy}/${String(inv.invoiceNo).padStart(5, '0')}`,
      invoiceDate: o.paid_at || o.created_at,
      order: { id: o.id, createdAt: o.created_at, paymentMethod: o.payment_method, paymentId: o.payment_id, shippingMethod: o.shipping_method,
        courier: o.courier, trackingNumber: o.tracking_number, couponCode: o.coupon_code, note: o.admin_note },
      seller: { name: s.biz_name, address: s.biz_address, state: s.biz_state, gstin: s.gstin, fssai: s.fssai, phone: s.biz_phone, email: s.biz_email },
      buyer: o.customer,
      hsn: s.hsn_code, gstPct, intraState: sameState,
      lines, taxablePaise, taxPaise,
      cgstPaise: cgst, sgstPaise: sameState ? taxPaise - cgst : 0, igstPaise: sameState ? 0 : taxPaise,
      totalPaise: o.total_paise, discountPaise: o.discount_paise, note: s.invoice_note,
      isRefunded: Boolean(o.refund_id),
    };
  }

  return { customers, exportCustomers, cohorts, marketing, economics, abandoned, analyticsExtras, overview, invoiceData };
}

module.exports = { createInsights, validateSettings, settingsWithDefaults, SETTINGS };
