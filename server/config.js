'use strict';
/* ================================================
   Configuration — read once from environment / .env
   Refuses to start in production with unsafe settings.

   Works in three places:
     • your laptop        → PGlite database, mock payments, admin on :3001
     • Vercel preview     → Neon/Postgres, mock payments allowed (private URL)
     • Vercel production  → Neon/Postgres, real Razorpay, admin protected by 2FA
   ================================================ */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

function buildConfig(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  // On Vercel the platform tells us which environment this is; elsewhere NODE_ENV decides.
  const isProduction = onVercel ? env.VERCEL_ENV === 'production' : env.NODE_ENV === 'production';
  const hasRazorpayKeys = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  const provider = (env.PAYMENT_PROVIDER || (hasRazorpayKeys ? 'razorpay' : 'mock')).toLowerCase();
  const adminHost = env.ADMIN_HOST || '127.0.0.1';
  const adminExposed = onVercel || !LOOPBACK.includes(adminHost);
  const port = Number.parseInt(env.PORT || '3000', 10);

  const publicOrigin = (env.PUBLIC_ORIGIN
    || (onVercel && env.VERCEL_URL ? `https://${env.VERCEL_URL}` : `http://localhost:${port}`)).replace(/\/+$/, '');

  const config = {
    isProduction,
    onVercel,
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
    dataDir: path.resolve(ROOT, env.PGLITE_DIR || 'data/pgdata'),
    defaultStock: Math.max(0, Number.parseInt(env.DEFAULT_STOCK || '200', 10) || 0),
    host: env.HOST || '127.0.0.1',
    port,
    publicOrigin,
    trustProxy: onVercel || env.TRUST_PROXY === 'true',
    provider,
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID || '',
      keySecret: env.RAZORPAY_KEY_SECRET || '',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    },
    admin: {
      enabled: Boolean(env.ADMIN_PASSWORD_HASH),
      username: env.ADMIN_USERNAME || 'admin',
      passwordHash: env.ADMIN_PASSWORD_HASH || '',
      totpSecret: (env.ADMIN_TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase(),
      host: adminHost,
      port: Number.parseInt(env.ADMIN_PORT || '3001', 10),
      exposed: adminExposed,
      // On Vercel the admin lives on the same origin as the store (path /admin)
      origin: (env.ADMIN_ORIGIN || (onVercel ? publicOrigin : `http://localhost:${env.ADMIN_PORT || 3001}`)).replace(/\/+$/, ''),
      allowedIps: (env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
    },
  };

  const errors = [];

  if (config.admin.enabled) {
    if (!config.admin.passwordHash.startsWith('scrypt$')) {
      errors.push('ADMIN_PASSWORD_HASH must be generated with "npm run admin:password"');
    }
    if (config.admin.totpSecret && !/^[A-Z2-7]{16,}$/.test(config.admin.totpSecret)) {
      errors.push('ADMIN_TOTP_SECRET must be a base32 secret (generate with "npm run admin:password")');
    }
    if (!onVercel) {
      if (!Number.isInteger(config.admin.port) || config.admin.port === config.port) {
        errors.push('ADMIN_PORT must be a valid port different from PORT');
      }
      if (adminExposed && !config.admin.origin.startsWith('https://')) {
        errors.push('Admin is exposed beyond localhost — ADMIN_ORIGIN must be https:// (or keep ADMIN_HOST=127.0.0.1 and use an SSH tunnel)');
      }
    }
    if (isProduction && adminExposed && !config.admin.totpSecret) {
      errors.push('The admin is reachable from the internet — ADMIN_TOTP_SECRET (two-factor) is required in production');
    }
  }

  if (!['mock', 'razorpay'].includes(provider)) {
    errors.push(`PAYMENT_PROVIDER must be "mock" or "razorpay" (got "${provider}")`);
  }
  if (provider === 'razorpay' && !hasRazorpayKeys) {
    errors.push('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be a valid port number');
  }
  if (onVercel && !config.databaseUrl) {
    errors.push('DATABASE_URL (Postgres connection string) is required on Vercel');
  }
  if (isProduction) {
    if (provider !== 'razorpay') errors.push('Mock payments are disabled in production — set PAYMENT_PROVIDER=razorpay');
    if (!config.razorpay.webhookSecret) errors.push('RAZORPAY_WEBHOOK_SECRET is required in production');
    if (!config.publicOrigin.startsWith('https://')) errors.push('PUBLIC_ORIGIN must be https:// in production');
    if (!config.databaseUrl) errors.push('DATABASE_URL (Postgres) is required in production');
    if (config.razorpay.keyId.startsWith('rzp_test_')) {
      console.warn('[config] WARNING: using a Razorpay TEST key in production — no real money will be collected.');
    }
  }
  if (errors.length) {
    const err = new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
    err.code = 'ECONFIG';
    throw err;
  }
  return Object.freeze(config);
}

module.exports = { loadDotEnv, buildConfig, LOOPBACK };
