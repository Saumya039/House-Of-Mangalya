'use strict';
/* ================================================
   Product catalog & pricing — the ONLY source of truth
   for what a customer pays. Prices from the browser are
   never trusted. All money is integer paise.
   ================================================ */

const PRODUCTS = Object.freeze({
  'turmeric-1kg': Object.freeze({
    id: 'turmeric-1kg',
    name: 'Single-Origin Turmeric Powder',
    weight: '1 kg',
    pricePaise: 500_00,
    img: 'assets/product.jpg',
  }),
});

// From the published Shipping Policy (faq.html)
const SHIPPING = Object.freeze({
  standard: Object.freeze({ label: 'Standard (5–7 business days)', feePaise: 80_00, freeAbovePaise: 999_00 }),
  express: Object.freeze({ label: 'Express (2–3 business days)', feePaise: 150_00, freeAbovePaise: null }),
});

const MAX_QTY_PER_ITEM = 20;
const MAX_LINE_ITEMS = 10;
const CURRENCY = 'INR';

class PricingError extends Error {}

/**
 * @param {Array<{id:string, qty:number}>} rawItems
 * @param {string} shippingMethod
 * @param {number} [discountPaise] already validated by server/commerce.js; clamped to the subtotal here
 */
function priceOrder(rawItems, shippingMethod, discountPaise = 0) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new PricingError('Your cart is empty');
  if (rawItems.length > MAX_LINE_ITEMS) throw new PricingError('Too many items in cart');

  const shipping = Object.hasOwn(SHIPPING, shippingMethod) ? SHIPPING[shippingMethod] : null;
  if (!shipping) throw new PricingError('Invalid shipping method');

  const merged = new Map();
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') throw new PricingError('Invalid cart item');
    const { id, qty } = item;
    if (typeof id !== 'string' || !Object.hasOwn(PRODUCTS, id)) throw new PricingError('Unknown product in cart');
    if (!Number.isInteger(qty) || qty < 1) throw new PricingError('Invalid quantity');
    merged.set(id, (merged.get(id) || 0) + qty);
  }

  const lines = [];
  let subtotalPaise = 0;
  for (const [id, qty] of merged) {
    if (qty > MAX_QTY_PER_ITEM) {
      throw new PricingError(`Maximum ${MAX_QTY_PER_ITEM} per product — contact us for bulk orders`);
    }
    const p = PRODUCTS[id];
    const lineTotalPaise = p.pricePaise * qty;
    subtotalPaise += lineTotalPaise;
    lines.push({ id, name: p.name, weight: p.weight, qty, unitPaise: p.pricePaise, lineTotalPaise });
  }

  const discount = Math.max(0, Math.min(Number.isInteger(discountPaise) ? discountPaise : 0, subtotalPaise));
  const payablePaise = subtotalPaise - discount;
  // Free-shipping threshold is judged on what the customer actually pays for goods
  const shippingPaise =
    shipping.freeAbovePaise !== null && payablePaise > shipping.freeAbovePaise ? 0 : shipping.feePaise;

  return {
    currency: CURRENCY,
    lines,
    subtotalPaise,
    discountPaise: discount,
    shippingMethod,
    shippingLabel: shipping.label,
    shippingPaise,
    totalPaise: payablePaise + shippingPaise,
  };
}

function publicCatalog() {
  return {
    currency: CURRENCY,
    maxQtyPerItem: MAX_QTY_PER_ITEM,
    products: Object.values(PRODUCTS).map(p => ({ ...p })),
    shipping: Object.entries(SHIPPING).map(([id, s]) => ({ id, ...s })),
  };
}

module.exports = { PRODUCTS, SHIPPING, MAX_QTY_PER_ITEM, CURRENCY, PricingError, priceOrder, publicCatalog };
