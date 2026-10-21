'use strict';
/* ================================================
   Admin reporting queries (read-only, PostgreSQL).
   Dates are grouped on the IST calendar (Asia/Kolkata).
   Every value is bound as a parameter; WHERE clauses
   are assembled only from fixed fragments below.
   camelCase aliases are quoted ("grossPaise") because Postgres
   lower-cases unquoted identifiers.
   ================================================ */

const IST_TS = "(created_at::timestamptz AT TIME ZONE 'Asia/Kolkata')";
const ABANDON_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const PAYMENT_FILTERS = {
  paid: "o.status = 'paid' AND o.refund_id IS NULL",
  refunded: "o.status = 'paid' AND o.refund_id IS NOT NULL",
  authorized: "o.status = 'authorized'",
  failed: "o.status = 'failed'",
  pending: "o.status = 'created' AND o.created_at >= :abandonCutoff",
  abandoned: "o.status = 'created' AND o.created_at < :abandonCutoff",
};
const FULFILLMENT = ['unfulfilled', 'packed', 'shipped', 'delivered', 'cancelled'];

/** 'YYYY-MM-DD' (IST) -> UTC ISO of that IST midnight */
function istDayStart(day) {
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}
function istToday() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}
function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function parseRange(fromDay, toDay) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let to = re.test(toDay || '') && !Number.isNaN(Date.parse(toDay)) ? toDay : istToday();
  let from = re.test(fromDay || '') && !Number.isNaN(Date.parse(fromDay)) ? fromDay : addDays(to, -29);
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  if (days > 731) from = addDays(to, -730);
  return { from, to, days: Math.min(days, 731), start: istDayStart(from), end: istDayStart(addDays(to, 1)) };
}

function createQueries(pg) {
  const q = (text, params = {}) => pg.named(text, params);
  const one = async (text, params) => (await q(text, params))[0];

  const SUMMARY = `
    SELECT
      COUNT(*)                                                          AS "ordersAll",
      COUNT(*) FILTER (WHERE status = 'paid')                           AS paid,
      COUNT(*) FILTER (WHERE status = 'failed')                         AS failed,
      COUNT(*) FILTER (WHERE status = 'authorized')                     AS authorized,
      COUNT(*) FILTER (WHERE status = 'created' AND created_at <  :abandonCutoff) AS abandoned,
      COUNT(*) FILTER (WHERE status = 'created' AND created_at >= :abandonCutoff) AS pending,
      COALESCE(SUM(total_paise) FILTER (WHERE status = 'paid'), 0)      AS "grossPaise",
      COALESCE(SUM(shipping_paise) FILTER (WHERE status = 'paid'), 0)   AS "shippingPaise",
      COALESCE(SUM(refunded_paise) FILTER (WHERE status = 'paid' AND refund_status IN ('processed','pending')), 0) AS "refundedPaise",
      COUNT(*) FILTER (WHERE status = 'paid' AND refund_id IS NOT NULL) AS refunds,
      COALESCE(SUM(total_paise) FILTER (WHERE status = 'created' AND created_at < :abandonCutoff), 0) AS "abandonedPaise",
      COUNT(DISTINCT customer_json->>'email') FILTER (WHERE status = 'paid') AS customers
    FROM orders WHERE created_at >= :start AND created_at < :end`;

  const UNITS = `
    SELECT COALESCE(SUM((j.value->>'qty')::int), 0) AS units
    FROM orders o, jsonb_array_elements(o.items_json) AS j(value)
    WHERE o.status = 'paid' AND o.created_at >= :start AND o.created_at < :end`;

  const REPEAT = `
    SELECT COUNT(*) AS n FROM (
      SELECT customer_json->>'email' AS e FROM orders
      WHERE status = 'paid' AND created_at >= :start AND created_at < :end
      GROUP BY 1 HAVING COUNT(*) > 1) t`;

  const groupPaid = expr => `
    SELECT COALESCE(${expr}, 'unknown') AS k, COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS "revenuePaise"
    FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end
    GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT 10`;

  async function summaryFor(r, abandonCutoff) {
    const p = { start: r.start, end: r.end, abandonCutoff };
    const s = { ...(await one(SUMMARY, p)) };
    s.unitsSold = (await one(UNITS, p)).units;
    s.repeatCustomers = (await one(REPEAT, p)).n;
    s.netPaise = s.grossPaise - s.refundedPaise;
    s.aovPaise = s.paid ? Math.round(s.grossPaise / s.paid) : 0;
    s.conversion = s.ordersAll ? s.paid / s.ordersAll : 0;
    s.newSubscribers = (await one('SELECT COUNT(*) AS n FROM newsletter WHERE created_at >= :start AND created_at < :end', { start: r.start, end: r.end })).n;
    return s;
  }

  async function analytics(fromDay, toDay) {
    const range = parseRange(fromDay, toDay);
    const abandonCutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
    const p = { start: range.start, end: range.end };
    const pa = { ...p, abandonCutoff };

    const prevTo = addDays(range.from, -1);
    const prev = parseRange(addDays(prevTo, -(range.days - 1)), prevTo);

    const [dailyRaw, hourlyRaw, queueRaw, current, previous, totalSubs, statusBreakdown, methods, shipping, states, cities, products, topCustomers] = await Promise.all([
      q(`SELECT to_char(${IST_TS}, 'YYYY-MM-DD') AS day, COUNT(*) AS orders,
           COUNT(*) FILTER (WHERE status = 'paid') AS paid,
           COALESCE(SUM(total_paise) FILTER (WHERE status = 'paid'), 0) AS "revenuePaise"
         FROM orders WHERE created_at >= :start AND created_at < :end GROUP BY 1`, p),
      q(`SELECT EXTRACT(HOUR FROM ${IST_TS})::int AS hour, COUNT(*) AS n
         FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end GROUP BY 1`, p),
      q(`SELECT fulfillment_status AS k, COUNT(*) AS n FROM orders WHERE status = 'paid' AND refund_id IS NULL GROUP BY 1`),
      summaryFor(range, abandonCutoff),
      summaryFor(prev, abandonCutoff),
      one('SELECT COUNT(*) AS n FROM newsletter'),
      q(`SELECT CASE
             WHEN status = 'paid' AND refund_id IS NOT NULL THEN 'refunded'
             WHEN status = 'created' AND created_at < :abandonCutoff THEN 'abandoned'
             WHEN status = 'created' THEN 'pending'
             ELSE status END AS k,
           COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS "valuePaise"
         FROM orders WHERE created_at >= :start AND created_at < :end GROUP BY 1`, pa),
      q(groupPaid('payment_method'), p),
      q(groupPaid('shipping_method'), p),
      q(groupPaid("customer_json->>'state'"), p),
      q(groupPaid("customer_json->>'city'"), p),
      q(`SELECT j.value->>'id' AS "productId", MAX(j.value->>'name') AS name,
           SUM((j.value->>'qty')::int) AS units, SUM((j.value->>'lineTotalPaise')::bigint) AS "revenuePaise"
         FROM orders o, jsonb_array_elements(o.items_json) AS j(value)
         WHERE o.status = 'paid' AND o.created_at >= :start AND o.created_at < :end
         GROUP BY 1 ORDER BY 4 DESC`, p),
      q(`SELECT customer_json->>'email' AS email, MAX(customer_json->>'name') AS name,
           COUNT(*) AS orders, SUM(total_paise) AS "spendPaise", MAX(created_at) AS "lastOrder"
         FROM orders WHERE status = 'paid' AND created_at >= :start AND created_at < :end
         GROUP BY 1 ORDER BY 4 DESC LIMIT 10`, p),
    ]);

    const dailyRows = new Map(dailyRaw.map(r => [r.day, r]));
    const daily = [];
    for (let i = 0; i < range.days; i++) {
      const day = addDays(range.from, i);
      const r = dailyRows.get(day);
      daily.push({ day, orders: r?.orders || 0, paid: r?.paid || 0, revenuePaise: r?.revenuePaise || 0 });
    }
    const hours = Array(24).fill(0);
    for (const r of hourlyRaw) hours[r.hour] = r.n;
    const queue = Object.fromEntries(FULFILLMENT.map(k => [k, 0]));
    for (const r of queueRaw) queue[r.k] = r.n;

    return {
      range: { from: range.from, to: range.to, days: range.days },
      previousRange: { from: prev.from, to: prev.to },
      summary: { ...current, totalSubscribers: totalSubs.n },
      previous,
      fulfillmentQueue: queue,
      daily,
      hours,
      statusBreakdown,
      paymentMethods: methods,
      shippingMethods: shipping,
      states,
      cities,
      products,
      topCustomers,
    };
  }

  // ── Orders list ────────────────────────────────
  function buildOrderFilter(f) {
    const where = [];
    const params = { abandonCutoff: new Date(Date.now() - ABANDON_AFTER_MS).toISOString() };
    if (f.payment && Object.hasOwn(PAYMENT_FILTERS, f.payment)) where.push(PAYMENT_FILTERS[f.payment]);
    if (f.fulfillment === 'toship') {
      where.push("o.status = 'paid' AND o.refund_id IS NULL AND o.fulfillment_status IN ('unfulfilled','packed')");
    } else if (f.fulfillment && FULFILLMENT.includes(f.fulfillment)) {
      where.push("o.status = 'paid' AND o.fulfillment_status = :fulfillment");
      params.fulfillment = f.fulfillment;
    }
    if (f.from || f.to) {
      const r = parseRange(f.from, f.to);
      where.push('o.created_at >= :start AND o.created_at < :end');
      params.start = r.start;
      params.end = r.end;
    }
    if (typeof f.q === 'string' && f.q.trim()) {
      // backslash is Postgres' default LIKE escape, so user-typed % and _ are matched literally
      const term = f.q.trim().slice(0, 80).replace(/[\\%_]/g, c => '\\' + c);
      where.push(`(o.id ILIKE :q OR o.customer_json->>'name' ILIKE :q OR o.customer_json->>'email' ILIKE :q
        OR o.customer_json->>'phone' ILIKE :q OR o.customer_json->>'city' ILIKE :q OR o.payment_id ILIKE :q OR o.tracking_number ILIKE :q)`);
      params.q = `%${term}%`;
    }
    return { sqlWhere: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  const ORDER_COLS = `o.id, o.created_at, o.status, o.total_paise, o.subtotal_paise, o.shipping_paise, o.shipping_method,
    o.payment_method, o.payment_id, o.fulfillment_status, o.courier, o.tracking_number, o.refund_status, o.refunded_paise,
    o.items_json, o.customer_json, o.paid_at, o.discount_paise, o.coupon_code, o.utm_source`;

  function displayStatus(row, abandonCutoff) {
    if (row.status === 'paid' && row.refund_status) return 'refunded';
    if (row.status === 'created') return row.created_at < abandonCutoff ? 'abandoned' : 'pending';
    return row.status;
  }

  function mapRow(row, abandonCutoff) {
    const c = row.customer_json;
    const items = row.items_json;
    return {
      id: row.id,
      createdAt: row.created_at,
      paidAt: row.paid_at,
      status: displayStatus(row, abandonCutoff),
      totalPaise: row.total_paise,
      subtotalPaise: row.subtotal_paise,
      shippingPaise: row.shipping_paise,
      discountPaise: row.discount_paise,
      couponCode: row.coupon_code,
      source: row.utm_source,
      shippingMethod: row.shipping_method,
      paymentMethod: row.payment_method,
      paymentId: row.payment_id,
      fulfillment: row.fulfillment_status,
      courier: row.courier,
      trackingNumber: row.tracking_number,
      refundStatus: row.refund_status,
      units: items.reduce((n, i) => n + i.qty, 0),
      items: items.map(i => `${i.name} (${i.weight}) × ${i.qty}`).join('; '),
      name: c.name, email: c.email, phone: c.phone, city: c.city, state: c.state, pincode: c.pincode,
      address: [c.address1, c.address2, c.city, c.state, c.pincode].filter(Boolean).join(', '),
    };
  }

  async function listOrders(f) {
    const { sqlWhere, params } = buildOrderFilter(f);
    const pageSize = Math.min(Math.max(Number.parseInt(f.pageSize, 10) || 25, 5), 100);
    const page = Math.max(Number.parseInt(f.page, 10) || 1, 1);
    const total = (await one(`SELECT COUNT(*) AS n FROM orders o ${sqlWhere}`, params)).n;
    const rows = await q(`SELECT ${ORDER_COLS} FROM orders o ${sqlWhere} ORDER BY o.created_at DESC, o.id LIMIT :limit OFFSET :offset`,
      { ...params, limit: pageSize, offset: (page - 1) * pageSize });
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), orders: rows.map(r => mapRow(r, params.abandonCutoff)) };
  }

  async function exportOrders(f) {
    const { sqlWhere, params } = buildOrderFilter(f);
    const rows = await q(`SELECT ${ORDER_COLS} FROM orders o ${sqlWhere} ORDER BY o.created_at DESC, o.id LIMIT 20000`, params);
    return rows.map(r => mapRow(r, params.abandonCutoff));
  }

  async function orderDetail(order) {
    const abandonCutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
    const [audit, webhooks] = await Promise.all([
      pg.q('SELECT at, actor, action, detail FROM audit_log WHERE order_id = $1 ORDER BY id DESC LIMIT 100', [order.id]),
      pg.q('SELECT id, event, received_at, outcome, payment_id, amount_paise FROM webhook_events WHERE provider_order_id = $1 ORDER BY received_at DESC LIMIT 50', [order.provider_order_id]),
    ]);
    return {
      id: order.id,
      status: displayStatus(order, abandonCutoff),
      rawStatus: order.status,
      provider: order.provider,
      providerOrderId: order.provider_order_id,
      paymentId: order.payment_id,
      paymentMethod: order.payment_method,
      currency: order.currency,
      items: order.items,
      subtotalPaise: order.subtotal_paise,
      discountPaise: order.discount_paise,
      couponCode: order.coupon_code,
      shippingPaise: order.shipping_paise,
      totalPaise: order.total_paise,
      shippingMethod: order.shipping_method,
      attribution: { source: order.utm_source, medium: order.utm_medium, campaign: order.utm_campaign, referrer: order.referrer },
      invoiceNo: order.invoice_no ? `${order.invoice_fy}/${order.invoice_no}` : null,
      customer: order.customer,
      fulfillment: order.fulfillment_status,
      courier: order.courier,
      trackingNumber: order.tracking_number,
      adminNote: order.admin_note,
      refundId: order.refund_id,
      refundStatus: order.refund_status,
      refundedPaise: order.refunded_paise,
      timeline: {
        createdAt: order.created_at, paidAt: order.paid_at, shippedAt: order.shipped_at,
        deliveredAt: order.delivered_at, refundedAt: order.refunded_at, updatedAt: order.updated_at,
      },
      audit,
      webhooks,
    };
  }

  // ── Other lists ────────────────────────────────
  const page = (listSql, countSql) => async f => {
    const pageSize = Math.min(Math.max(Number.parseInt(f.pageSize, 10) || 50, 10), 200);
    const pg2 = Math.max(Number.parseInt(f.page, 10) || 1, 1);
    const total = (await one(countSql)).n;
    return { total, page: pg2, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), rows: await q(listSql, { limit: pageSize, offset: (pg2 - 1) * pageSize }) };
  };

  return {
    analytics,
    listOrders,
    exportOrders,
    orderDetail,
    webhooks: page(
      'SELECT id, event, received_at, provider_order_id, payment_id, amount_paise, outcome FROM webhook_events ORDER BY received_at DESC, id LIMIT :limit OFFSET :offset',
      'SELECT COUNT(*) AS n FROM webhook_events'),
    audit: page(
      'SELECT at, actor, action, order_id, detail, ip FROM audit_log ORDER BY id DESC LIMIT :limit OFFSET :offset',
      'SELECT COUNT(*) AS n FROM audit_log'),
    subscribers: page(
      'SELECT email, created_at FROM newsletter ORDER BY created_at DESC, email LIMIT :limit OFFSET :offset',
      'SELECT COUNT(*) AS n FROM newsletter'),
    allSubscribers: () => q('SELECT email, created_at FROM newsletter ORDER BY created_at DESC, email'),
  };
}

module.exports = { createQueries, parseRange, FULFILLMENT, istToday };
