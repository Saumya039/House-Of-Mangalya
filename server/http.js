'use strict';
/* ================================================
   HTTP helpers — security headers, safe static file
   serving, bounded body parsing, rate limiting.
   ================================================ */
const fs = require('node:fs');
const path = require('node:path');

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
});

function securityHeaders({ isProduction }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://checkout.razorpay.com",
    // 'unsafe-inline' for styles only: the pages use style="" attributes. Scripts stay strict.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
    'frame-src https://api.razorpay.com https://checkout.razorpay.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isProduction ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isProduction) headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  return headers;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Reads the body with a hard size cap. Returns a Buffer. */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limitBytes) return reject(new HttpError(413, 'Request too large'));
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limitBytes = 16 * 1024) {
  const type = req.headers['content-type'] || '';
  if (!/^application\/json(;|$)/i.test(type)) throw new HttpError(415, 'Content-Type must be application/json');
  const raw = await readBody(req, limitBytes);
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** The scheme+host the browser used to reach us (works behind Vercel / a reverse proxy). */
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + req.headers.host;
}

/**
 * Same-origin check for state-changing requests: the Origin header (if sent) must be this site,
 * and the browser must not report a cross-site fetch.
 */
function isSameOrigin(req, alsoAllowed = []) {
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req) && !alsoAllowed.includes(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  return true;
}

/** Visitor IP. Behind Vercel / a trusted proxy the platform sets x-forwarded-for. */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd.slice(0, 64);
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Serves files from publicDir only. Blocks traversal, dotfiles and unknown types. */
async function serveStatic(req, res, publicDir) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return false;
  }
  if (pathname.includes('\0')) return false;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const resolved = path.resolve(publicDir, '.' + pathname);
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return false;
  if (path.relative(publicDir, resolved).split(path.sep).some(seg => seg.startsWith('.'))) return false;

  const type = MIME[path.extname(resolved).toLowerCase()];
  if (!type) return false;

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  // HTML/CSS/JS revalidate every time (so deploys show up at once); images cache for an hour
  const revalidate = /^(text\/(html|css|javascript))/.test(type);
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    'Content-Type': type,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
    'Last-Modified': lastModified,
  };
  const since = Date.parse(req.headers['if-modified-since'] || '');
  if (!Number.isNaN(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
  return true;
}

module.exports = { securityHeaders, sendJson, HttpError, readBody, readJson, serveStatic, isSameOrigin, clientIp, requestOrigin };
