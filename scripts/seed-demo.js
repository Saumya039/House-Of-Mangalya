'use strict';
/* ================================================
   Load DEMO orders so the admin dashboard has data to show
   during local development. Every demo order id starts with
   "DEMO-" and every demo email ends in @example.com.
     npm run seed:demo            → add ~200 demo orders
     npm run seed:demo -- --clear → remove all demo data
   Refuses to run in production. If DATABASE_URL points at a remote
   database you must also pass --yes-remote.
   ================================================ */
const crypto = require('node:crypto');
const { loadDotEnv, buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { priceOrder } = require('../server/catalog');

(async () => {
  loadDotEnv();
  const config = buildConfig();
  if (config.isProduction) {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
  }
  if (config.databaseUrl && !process.argv.includes('--yes-remote')) {
    console.error('DATABASE_URL is set (a remote database). Re-run with --yes-remote if you really want demo data there.');
    process.exit(1);
  }
  const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, defaultStock: config.defaultStock });
  const sql = (text, params) => db.pg.q(text, params);

  if (process.argv.includes('--clear')) {
    await sql("DELETE FROM audit_log WHERE order_id LIKE 'DEMO-%'");
    await sql("DELETE FROM ad_spend WHERE note = 'DEMO'");
    await sql("DELETE FROM webhook_events WHERE id LIKE 'evt_demo%'");
    await sql("DELETE FROM newsletter WHERE email LIKE 'demo.%@example.com'");
    const r = await db.pg.run("DELETE FROM orders WHERE id LIKE 'DEMO-%'");
    console.log(`Removed ${r.rowCount} demo orders.`);
    await db.close();
    return;
  }

  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const weighted = pairs => {
    let r = Math.random() * pairs.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
    return pairs[0][0];
  };

  const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Sneha', 'Arjun', 'Kavya', 'Ishaan', 'Meera', 'Kabir', 'Diya', 'Aditya', 'Neha', 'Siddharth', 'Pooja'];
  const LAST = ['Sharma', 'Patil', 'Iyer', 'Nair', 'Desai', 'Reddy', 'Kulkarni', 'Mehta', 'Joshi', 'Gupta', 'Rao', 'Shah'];
  const PLACES = [
    ['Mumbai', 'Maharashtra', '400050', 9], ['Pune', 'Maharashtra', '411004', 7], ['Ratnagiri', 'Maharashtra', '415612', 3],
    ['Bengaluru', 'Karnataka', '560038', 6], ['Delhi', 'Delhi', '110017', 5], ['Hyderabad', 'Telangana', '500034', 4],
    ['Chennai', 'Tamil Nadu', '600020', 4], ['Ahmedabad', 'Gujarat', '380015', 3], ['Kochi', 'Kerala', '682020', 2],
    ['Kolkata', 'West Bengal', '700019', 2], ['Jaipur', 'Rajasthan', '302001', 2], ['Goa', 'Goa', '403001', 1],
  ];
  const customers = Array.from({ length: 70 }, (_, i) => {
    const [city, state, pincode] = weighted(PLACES.map(p => [p, p[3]]));
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    return {
      name, email: `demo.${name.toLowerCase().replace(/\s+/g, '.')}${i}@example.com`,
      phone: `+919${String(rand(100000000, 999999999))}`, address1: `${rand(1, 200)} Demo Street`, address2: '',
      city, state, pincode,
    };
  });

  const now = Date.now();
  let created = 0;
  for (let i = 0; i < 210; i++) {
    // More orders in recent weeks, mostly in the evening (IST)
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.4) * 60);
    const istHour = weighted([[8, 1], [10, 2], [12, 3], [14, 2], [17, 3], [19, 5], [20, 6], [21, 5], [22, 3], [23, 1]]);
    const t = new Date(now - daysAgo * 86_400_000);
    t.setUTCHours(istHour - 5, rand(0, 59) + 30, rand(0, 59));
    while (t.getTime() > now) t.setTime(t.getTime() - 86_400_000);
    const iso = t.toISOString();
    const day = new Date(t.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');

    const customer = Math.random() < 0.3 ? customers[rand(0, 14)] : pick(customers); // some repeat buyers
    const qty = weighted([[1, 5], [2, 4], [3, 2], [4, 1], [6, 0.5]]);
    const shipMethod = weighted([['standard', 4], ['express', 1]]);
    const base = priceOrder([{ id: 'turmeric-1kg', qty }], shipMethod);
    const useCoupon = Math.random() < 0.15;
    const discount = useCoupon ? Math.min(Math.floor(base.subtotalPaise / 10), 20000) : 0;
    const q = priceOrder([{ id: 'turmeric-1kg', qty }], shipMethod, discount);
    const attribution = { source: weighted([['instagram', 4], ['google', 3], ['direct', 3], ['whatsapp', 2], ['facebook', 1.5], ['youtube', 1]]), medium: null, campaign: null };
    if (['instagram', 'facebook', 'google'].includes(attribution.source) && Math.random() < 0.6) { attribution.medium = 'paid'; attribution.campaign = pick(['diwali', 'harvest', 'goldenmilk']); }
    const id = `DEMO-${day}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const providerOrderId = 'order_demo' + crypto.randomBytes(7).toString('hex');
    await db.createOrder({ id, provider: 'mock', providerOrderId, customer, attribution, couponCode: useCoupon ? 'WELCOME10' : null, ...q, createdAt: iso });

    const outcome = weighted([['paid', 72], ['created', 16], ['failed', 9], ['authorized', 3]]);
    const paymentId = 'pay_demo' + crypto.randomBytes(7).toString('hex');
    const payMethod = weighted([['upi', 6], ['card', 3], ['netbanking', 1], ['wallet', 1]]);
    const later = mins => new Date(t.getTime() + mins * 60_000).toISOString();

    if (outcome === 'paid') {
      await sql("UPDATE orders SET status = 'paid', payment_id = $1, payment_method = $2, paid_at = $3, updated_at = $3 WHERE id = $4", [paymentId, payMethod, later(2), id]);
      await db.recordWebhookEvent('evt_demo' + crypto.randomBytes(6).toString('hex'), 'payment.captured',
        { providerOrderId, paymentId, amountPaise: q.totalPaise, outcome: 'marked-paid' });
      const f = daysAgo > 7 ? weighted([['delivered', 8], ['shipped', 1]]) : daysAgo > 2 ? weighted([['shipped', 5], ['packed', 2], ['delivered', 2]]) : weighted([['unfulfilled', 5], ['packed', 2]]);
      const courier = pick(['Delhivery', 'BlueDart', 'India Post']);
      const tracking = f === 'shipped' || f === 'delivered' ? `${courier.slice(0, 2).toUpperCase()}${rand(10000000, 99999999)}` : null;
      await sql('UPDATE orders SET fulfillment_status = $1, courier = $2, tracking_number = $3, shipped_at = $4, delivered_at = $5 WHERE id = $6',
        [f, tracking ? courier : null, tracking, tracking ? later(60 * 24) : null, f === 'delivered' ? later(60 * 24 * 5) : null, id]);
      if (Math.random() < 0.04) {
        await sql("UPDATE orders SET refund_id = $1, refund_status = 'processed', refunded_paise = $2, refunded_at = $3 WHERE id = $4",
          ['rfnd_demo' + crypto.randomBytes(6).toString('hex'), q.totalPaise, later(60 * 24 * 8), id]);
      }
    } else if (outcome === 'failed') {
      await sql("UPDATE orders SET status = 'failed', updated_at = $1 WHERE id = $2", [later(3), id]);
      await db.recordWebhookEvent('evt_demo' + crypto.randomBytes(6).toString('hex'), 'payment.failed',
        { providerOrderId, paymentId, amountPaise: q.totalPaise, outcome: 'marked-failed' });
    } else if (outcome === 'authorized') {
      await sql("UPDATE orders SET status = 'authorized', payment_id = $1, payment_method = $2, updated_at = $3 WHERE id = $4", [paymentId, payMethod, later(2), id]);
    }
    created++;
  }

  for (let i = 0; i < 45; i++) {
    const ts = new Date(now - Math.floor(Math.random() * 60) * 86_400_000).toISOString();
    await sql('INSERT INTO newsletter (email, created_at) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [`demo.subscriber${i}@example.com`, ts]);
  }
  for (let d = 0; d < 60; d++) {
    const day = new Date(now - d * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    for (const [channel, lo, hi] of [['instagram', 300, 800], ['google', 200, 500], ['facebook', 100, 300]]) {
      await sql('INSERT INTO ad_spend (day, channel, amount_paise, note, created_at) VALUES ($1, $2, $3, $4, $5)', [day, channel, rand(lo, hi) * 100, 'DEMO', new Date().toISOString()]);
    }
  }

  console.log(`Added ${created} DEMO orders and 45 demo subscribers. Remove them with: npm run seed:demo -- --clear`);
  await db.close();
})().catch(e => { console.error(e); process.exit(1); });
