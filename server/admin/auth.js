'use strict';
/* ================================================
   Admin authentication
   - Password stored only as an scrypt hash (in env)
   - Optional/required two-factor: TOTP (RFC 6238 — Google Authenticator, Authy, 1Password…)
     with replay protection (a code works once)
   - Sessions: 256-bit random tokens in an HttpOnly, SameSite=Strict cookie
     (the __Host- prefix is used over HTTPS); only a SHA-256 of the token is stored,
     in Postgres, so any serverless instance can validate it
   - Idle (30 min) + absolute (8 h) expiry
   - Lock-outs by IP and by account, shared across instances via Postgres
   ================================================ */
const crypto = require('node:crypto');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IP_FAILS = 5;
const ACCOUNT_FAILS = 12;
const LOCK_MS = 15 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ── TOTP (RFC 6238) ──────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

function totpCode(secretB32, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Returns the matching time-step (±1 step of clock drift) or null. */
function matchTotp(secretB32, code, nowMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code || '').replace(/\s+/g, ''))) return null;
  const wanted = String(code).replace(/\s+/g, '');
  const step = Math.floor(nowMs / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    const a = Buffer.from(totpCode(secretB32, s));
    if (crypto.timingSafeEqual(a, Buffer.from(wanted))) return s;
  }
  return null;
}

// ── Cookies / sessions ───────────────────────────
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createAuth({ db, username, passwordHash, totpSecret = '', secureCookies }) {
  const COOKIE = secureCookies ? '__Host-hom_admin' : 'hom_admin';
  // Dummy hash so unknown-user logins cost the same time as real ones
  const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

  const cookie = (value, maxAgeSec) => [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`,
    ...(secureCookies ? ['Secure'] : [])].join('; ');

  const ipKey = ip => `login-fail-ip:${ip}`;
  const acctKey = `login-fail-acct:${username}`;

  return {
    twoFactorRequired: Boolean(totpSecret),

    async isLocked(ip) {
      return (await db.blocked(ipKey(ip), IP_FAILS)) || (await db.blocked(acctKey, ACCOUNT_FAILS));
    },

    /** @returns {Promise<{ok:true, setCookie:string, csrf:string} | {ok:false, locked?:boolean}>} */
    async login(ip, user, password, code) {
      if (await this.isLocked(ip)) return { ok: false, locked: true };
      const userOk = typeof user === 'string' && user.length <= 64 &&
        crypto.timingSafeEqual(Buffer.from(sha256(user)), Buffer.from(sha256(username)));
      const passOk = verifyPassword(typeof password === 'string' ? password.slice(0, 256) : '', userOk ? passwordHash : dummyHash);

      let totpOk = true;
      let step = null;
      if (totpSecret) {
        step = matchTotp(totpSecret, code);
        const last = Number(await db.getSetting('totp.last_step', '0'));
        totpOk = step !== null && step > last; // a code can be used only once
      }

      if (!userOk || !passOk || !totpOk) {
        await db.hit(ipKey(ip), IP_FAILS, LOCK_MS);
        await db.hit(acctKey, ACCOUNT_FAILS, LOCK_MS);
        return { ok: false, locked: await this.isLocked(ip) };
      }
      if (step !== null) await db.setSetting('totp.last_step', String(step));
      await db.clearLimit(ipKey(ip));
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(24).toString('base64url');
      await db.createSession({ tokenHash: sha256(token), username, csrf });
      return { ok: true, setCookie: cookie(token, ABSOLUTE_MS / 1000), csrf };
    },

    /** Returns the session for a request, refreshing its idle timer, or null. */
    async session(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token || token.length > 100) return null;
      const key = sha256(token);
      const s = await db.getSession(key);
      if (!s) return null;
      const now = Date.now();
      if (now - s.last_ms > IDLE_MS || now - s.created_ms > ABSOLUTE_MS) {
        await db.deleteSession(key);
        return null;
      }
      if (now - s.last_ms > 60_000) await db.touchSession(key); // refresh at most once a minute
      return { user: s.username, csrf: s.csrf, key };
    },

    async logout(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) await db.deleteSession(sha256(token));
      return cookie('', 0);
    },

    stop() {},
  };
}

module.exports = { hashPassword, verifyPassword, createAuth, parseCookies, generateTotpSecret, totpCode, matchTotp, base32Encode };
