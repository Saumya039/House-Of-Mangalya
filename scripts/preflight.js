'use strict';
/* ================================================
   Go-live checker.   npm run preflight
   Reads the environment the same way the app does, as if it were
   production, and reports what would stop you launching (FAIL) or
   deserves a look (WARN). Never prints secrets.
   Run it with your production variables loaded (e.g. in a .env file,
   or `vercel env pull`).
   ================================================ */
const fs = require('node:fs');
const { loadDotEnv, buildConfig } = require('../server/config');
const { openDb } = require('../server/db');

(async () => {
  loadDotEnv();
  const rows = [];
  const add = (level, msg) => rows.push([level, msg]);

  let config = null;
  try {
    const env = { ...process.env };
    if (env.VERCEL) env.VERCEL_ENV = 'production';
    else env.NODE_ENV = 'production';
    config = buildConfig(env);
    add('OK', 'Configuration is valid for production (https origin, live gateway keys, webhook secret, database)');
  } catch (e) {
    for (const line of e.message.split('\n').slice(1)) add('FAIL', line.replace(/^\s*-\s*/, ''));
  }

  if (config) {
    if (config.razorpay.keyId.startsWith('rzp_test_')) add('WARN', 'Razorpay key is a TEST key — no real money will be collected');
    else if (config.razorpay.keyId.startsWith('rzp_live_')) add('OK', 'Razorpay LIVE key in use');
    if (!config.admin.enabled) add('FAIL', 'Admin portal disabled — run: npm run admin:password -- --generate --totp --print-env');
    else add('OK', config.admin.totpSecret ? 'Admin protected by password + two-factor' : 'Admin has no two-factor (recommended)');
    if (config.publicOrigin.includes('localhost') || config.publicOrigin.endsWith('.vercel.app')) add('WARN', `PUBLIC_ORIGIN is ${config.publicOrigin} — set your real domain when you have one`);

    try {
      const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, defaultStock: config.defaultStock });
      add('OK', `Database reachable (${db.engine})`);
      const one = async (t, p) => (await db.pg.q(t, p))[0];
      const demo = (await one("SELECT COUNT(*) AS n FROM orders WHERE id LIKE 'DEMO-%'")).n;
      if (demo) add('FAIL', `${demo} DEMO orders in the database — run: npm run seed:demo -- --clear`);
      const mock = (await one("SELECT COUNT(*) AS n FROM orders WHERE provider = 'mock'")).n;
      if (mock) add('WARN', `${mock} test (mock-gateway) orders exist — consider starting production with a fresh database`);
      const s = await db.allSettings();
      for (const [k, label] of [['biz_name', 'Business name'], ['gstin', 'GSTIN'], ['fssai', 'FSSAI number'], ['biz_address', 'Registered address'], ['biz_state', 'State']]) {
        if (!s[k]) add('WARN', `Admin → Settings: ${label} is empty (needed for GST invoices)`);
      }
      await db.close();
    } catch (e) {
      add('FAIL', `Cannot reach the database: ${e.message}`);
    }

    if (fs.existsSync(`${config.root}/data/ADMIN_LOGIN.txt`)) add('FAIL', 'data/ADMIN_LOGIN.txt still exists — save the password elsewhere and delete it');
    const html = fs.readFileSync(`${config.root}/public/product.html`, 'utf8');
    if (/USDA Organic #NOP/.test(html)) add('WARN', 'product.html shows a USDA Organic certificate number — keep only if it is real');
    if (/1,247 Reviews/.test(html)) add('WARN', 'product.html shows “1,247 Reviews” — keep only if backed by real verified reviews');
    if (/anti-inflammatory drugs/.test(html)) add('WARN', 'product.html makes a drug-comparison health claim — consider removing');
  }

  const icon = { OK: '✔', WARN: '▲', FAIL: '✖' };
  for (const [l, m] of rows) console.log(`${icon[l]} ${l.padEnd(4)} ${m}`);
  const fails = rows.filter(r => r[0] === 'FAIL').length;
  const warns = rows.filter(r => r[0] === 'WARN').length;
  console.log(`\n${fails} blocking issue(s), ${warns} warning(s).${fails ? ' Fix the FAIL items before going live.' : ' No blockers.'}`);
  process.exit(fails ? 1 : 0);
})();
