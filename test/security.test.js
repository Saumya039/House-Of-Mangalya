'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { buildConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createAdminApp } = require('../server/admin/app');
const { createApp } = require('../server/app');
const { hashPassword, totpCode, matchTotp, generateTotpSecret } = require('../server/admin/auth');
const { createMockProvider } = require('../server/payments');
const { toPositional } = require('../server/pg');

const silent = { info() {}, warn() {}, error() {} };
const PASSWORD = 'correct-horse-battery-staple';

test('totp: matches the RFC 6238 reference vector and tolerates ±1 step of clock drift', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(totpCode(secret, 1), '287082'); // T = 59 s
  assert.equal(totpCode(secret, 37037036), '081804'); // T = 1111111109 s
  assert.equal(matchTotp(secret, '287082', 59_000), 1);
  assert.equal(matchTotp(secret, '287082', 59_000 + 30_000), 1, 'previous step still accepted');
  assert.equal(matchTotp(secret, '287082', 59_000 + 90_000), null, 'two steps later is rejected');
  assert.equal(matchTotp(secret, 'abcdef', 59_000), null);
  assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/);
});

test('sql: named placeholders become positional and ignore ::casts', () => {
  const [text, params] = toPositional("SELECT :a::int, :b, :a, 'x:y'", { a: 1, b: 2 });
  assert.equal(text, "SELECT $1::int, $2, $1, 'x:y'");
  assert.deepEqual(params, [1, 2]);
  assert.throws(() => toPositional('SELECT :missing', {}), /Missing SQL parameter/);
});

test('config: Vercel rules — production needs Postgres, Razorpay, 2FA; preview may use test payments', () => {
  const vercel = { VERCEL: '1', VERCEL_URL: 'x-abc.vercel.app', DATABASE_URL: 'postgres://u:p@db.example.com/x' };
  const admin = { ADMIN_PASSWORD_HASH: hashPassword('x'.repeat(12)) };

  // Preview: mock payments + no 2FA are fine (the URL is private to the team)
  const preview = buildConfig({ ...vercel, VERCEL_ENV: 'preview', ...admin });
  assert.equal(preview.isProduction, false);
  assert.equal(preview.provider, 'mock');
  assert.equal(preview.admin.origin, 'https://x-abc.vercel.app');

  // Production must be hardened
  const prod = { ...vercel, VERCEL_ENV: 'production', PUBLIC_ORIGIN: 'https://houseofmangalya.com' };
  assert.throws(() => buildConfig({ ...prod }), /Mock payments are disabled/);
  assert.throws(() => buildConfig({ ...prod, RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', ...admin }), /two-factor/);
  assert.doesNotThrow(() => buildConfig({
    ...prod, RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', ...admin, ADMIN_TOTP_SECRET: generateTotpSecret(),
  }));
  assert.throws(() => buildConfig({ VERCEL: '1', VERCEL_ENV: 'preview' }), /DATABASE_URL/);
});

async function bootAdmin() {
  const secret = generateTotpSecret();
  const config = buildConfig({
    PUBLIC_ORIGIN: 'http://localhost:3996', ADMIN_PASSWORD_HASH: hashPassword(PASSWORD), ADMIN_TOTP_SECRET: secret,
    ADMIN_PORT: '3995', ADMIN_ORIGIN: 'http://localhost:3995',
  });
  const db = await openDb();
  const provider = createMockProvider({ db });
  const app = createAdminApp({ config, db, provider, log: silent });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3995' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const close = () => new Promise(r => server.close(() => db.close().then(r)));
  return { secret, post, close, base };
}

test('admin login: two-factor code is required, valid once, and wrong codes count toward lock-out', async () => {
  const t = await bootAdmin();
  try {
    const info = await (await fetch(t.base + '/api/admin/login-info')).json();
    assert.equal(info.twoFactor, true);

    const good = (step = Math.floor(Date.now() / 30_000)) => totpCode(t.secret, step);
    assert.equal((await t.post('/api/admin/login', { username: 'admin', password: PASSWORD })).status, 401, 'password alone is not enough');
    assert.equal((await t.post('/api/admin/login', { username: 'admin', password: PASSWORD, code: '000000' })).status, 401);

    const step = Math.floor(Date.now() / 30_000);
    const ok = await t.post('/api/admin/login', { username: 'admin', password: PASSWORD, code: good(step) });
    assert.equal(ok.status, 200);
    const replay = await t.post('/api/admin/login', { username: 'admin', password: PASSWORD, code: good(step) });
    assert.equal(replay.status, 401, 'the same code cannot be used twice');

    // A success clears the counter, so the replay above was failure #1. Keep failing until the IP is locked.
    let locked = false;
    for (let i = 0; i < 6 && !locked; i++) {
      locked = (await t.post('/api/admin/login', { username: 'admin', password: 'nope-nope-nope', code: good() })).status === 429;
    }
    assert.ok(locked, 'repeated failures lock the IP');
    assert.equal((await t.post('/api/admin/login', { username: 'admin', password: PASSWORD, code: good(step + 1) })).status, 429, 'locked even with correct credentials');
  } finally { await t.close(); }
});

test('same-origin check follows the Host header (so Vercel preview URLs work) but still blocks other sites', async () => {
  const config = buildConfig({ PUBLIC_ORIGIN: 'https://houseofmangalya.com' });
  const db = await openDb();
  const app = createApp({ config, db, provider: createMockProvider({ db }), log: silent });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const call = origin => fetch(`http://127.0.0.1:${port}/api/newsletter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-Proto': 'http' }, body: JSON.stringify({ email: 'a@b.co' }),
    }).then(r => r.status);
    assert.equal(await call(`http://127.0.0.1:${port}`), 200, 'origin equal to the request host is accepted');
    assert.equal(await call('https://houseofmangalya.com'), 200, 'configured public origin is accepted');
    assert.equal(await call('https://evil.example'), 403);
  } finally {
    await new Promise(r => server.close(() => db.close().then(r)));
  }
});

test('vercel.json is generated from the server’s own security headers (no drift)', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-vercel.js'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
  const cfg = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const store = cfg.headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(store, /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.ok(!store.includes("script-src 'self' 'unsafe-inline'"));
  const adminCsp = cfg.headers.find(h => h.source === '/admin/(.*)').headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.ok(!adminCsp.includes('razorpay'), 'admin pages never load third-party scripts');
});
