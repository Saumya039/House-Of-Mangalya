'use strict';
/* ================================================
   Commerce rules that need the database: coupons,
   stock availability, attribution sanitising.
   The browser never decides any of these.
   ================================================ */

class CommerceError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

const CODE_RE = /^[A-Z0-9_-]{3,20}$/;

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : '';
}

/**
 * @returns {{coupon: object, discountPaise: number}}
 * @throws {CommerceError} with a customer-safe message
 */
async function evaluateCoupon(db, rawCode, { subtotalPaise, email }) {
  const code = normalizeCode(rawCode);
  if (!code) throw new CommerceError('That coupon code is not valid', 'coupon');
  const c = await db.getCoupon(code);
  const nowIso = new Date().toISOString();
  if (!c || !c.active) throw new CommerceError('That coupon code is not valid', 'coupon');
  if (c.starts_at && nowIso < c.starts_at) throw new CommerceError('This coupon is not active yet', 'coupon');
  if (c.expires_at && nowIso > c.expires_at) throw new CommerceError('This coupon has expired', 'coupon');
  if (c.usage_limit !== null && c.used_count >= c.usage_limit) throw new CommerceError('This coupon has been fully redeemed', 'coupon');
  if (subtotalPaise < c.min_subtotal_paise) {
    throw new CommerceError(`Add ₹${Math.ceil((c.min_subtotal_paise - subtotalPaise) / 100)} more to use this coupon`, 'coupon');
  }
  if (c.per_customer_limit !== null && email && (await db.couponUsesByEmail(code, email)) >= c.per_customer_limit) {
    throw new CommerceError('You have already used this coupon', 'coupon');
  }
  let discount = c.kind === 'percent' ? Math.floor((subtotalPaise * c.value) / 100) : c.value;
  if (c.max_discount_paise !== null) discount = Math.min(discount, c.max_discount_paise);
  discount = Math.max(0, Math.min(discount, subtotalPaise - 100)); // always charge at least ₹1
  if (discount <= 0) throw new CommerceError('This coupon does not apply to your cart', 'coupon');
  return { coupon: c, discountPaise: discount };
}

/** Throws if any line asks for more than is in stock. Stock can go negative after a race; that reads as out of stock. */
async function checkStock(db, lines) {
  for (const l of lines) {
    const row = await db.getStock(l.id);
    const left = row ? row.stock : 0;
    if (left <= 0) throw new CommerceError(`${l.name} is currently out of stock`);
    if (l.qty > left) throw new CommerceError(`Only ${left} of ${l.name} left in stock`);
  }
}

const TOKEN = /^[A-Za-z0-9_.\- ]{1,40}$/;
const SOURCE_BY_HOST = [
  [/(^|\.)google\./, 'google'], [/(^|\.)bing\./, 'bing'], [/(^|\.)duckduckgo\./, 'duckduckgo'],
  [/(^|\.)instagram\./, 'instagram'], [/(^|\.)facebook\.|(^|\.)fb\.|(^|\.)l\.facebook/, 'facebook'],
  [/(^|\.)youtube\./, 'youtube'], [/(^|\.)whatsapp\./, 'whatsapp'], [/(^|\.)t\.co$|(^|\.)twitter\.|(^|\.)x\.com$/, 'x'],
  [/(^|\.)linkedin\./, 'linkedin'], [/(^|\.)pinterest\./, 'pinterest'],
];

/** Accepts only short, plain tokens — attribution is analytics, never trusted for anything else. */
function cleanAttribution(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const tok = v => (typeof v === 'string' && TOKEN.test(v.trim()) ? v.trim().toLowerCase() : null);
  let referrer = typeof raw.referrer === 'string' ? raw.referrer.trim().toLowerCase().slice(0, 80) : null;
  if (referrer && !/^[a-z0-9.-]+$/.test(referrer)) referrer = null;
  let source = tok(raw.source);
  if (!source && referrer) source = (SOURCE_BY_HOST.find(([re]) => re.test(referrer)) || [null, referrer])[1];
  return { source: source || 'direct', medium: tok(raw.medium), campaign: tok(raw.campaign), referrer };
}

module.exports = { CommerceError, normalizeCode, evaluateCoupon, checkStock, cleanAttribution };
