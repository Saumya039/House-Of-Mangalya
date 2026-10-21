'use strict';
/* ================================================
   Strict input validation for customer details.
   Allow-list approach: unknown fields are dropped,
   every string is length-bounded and control-char free.
   ================================================ */

const INDIAN_STATES = Object.freeze([
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
]);

class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

function text(obj, field, label, { min = 1, max, optional = false, pattern }) {
  const raw = obj[field];
  if (raw === undefined || raw === null || raw === '') {
    if (optional) return '';
    throw new ValidationError(field, `${label} is required`);
  }
  if (typeof raw !== 'string') throw new ValidationError(field, `${label} is invalid`);
  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (CONTROL_CHARS.test(value)) throw new ValidationError(field, `${label} contains invalid characters`);
  if (value.length < min || value.length > max) {
    throw new ValidationError(field, `${label} must be ${min}–${max} characters`);
  }
  if (pattern && !pattern.test(value)) throw new ValidationError(field, `${label} is invalid`);
  return value;
}

function validateCustomer(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('customer', 'Customer details are required');
  }
  const name = text(input, 'name', 'Full name', { min: 2, max: 80, pattern: /^[\p{L}\p{M} .'-]+$/u });
  const email = text(input, 'email', 'Email', {
    min: 6, max: 254, pattern: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/,
  }).toLowerCase();

  let phone = text(input, 'phone', 'Mobile number', { min: 10, max: 16 }).replace(/[\s-]/g, '');
  phone = phone.replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  if (!/^[6-9]\d{9}$/.test(phone)) throw new ValidationError('phone', 'Enter a valid 10-digit Indian mobile number');

  const address1 = text(input, 'address1', 'Address', { min: 5, max: 120 });
  const address2 = text(input, 'address2', 'Address line 2', { max: 120, optional: true });
  const city = text(input, 'city', 'City', { min: 2, max: 60, pattern: /^[\p{L}\p{M} .'-]+$/u });
  const state = text(input, 'state', 'State', { min: 2, max: 60 });
  if (!INDIAN_STATES.includes(state)) throw new ValidationError('state', 'Select a valid state');
  const pincode = text(input, 'pincode', 'PIN code', { min: 6, max: 6, pattern: /^[1-9]\d{5}$/ });

  return { name, email, phone: `+91${phone}`, address1, address2, city, state, pincode };
}

function validateCartItems(input) {
  if (!Array.isArray(input)) throw new ValidationError('items', 'Cart is invalid');
  return input.map(i => ({
    id: typeof i?.id === 'string' ? i.id.slice(0, 64) : '',
    qty: typeof i?.qty === 'number' ? i.qty : NaN,
  }));
}

module.exports = { INDIAN_STATES, ValidationError, validateCustomer, validateCartItems };
