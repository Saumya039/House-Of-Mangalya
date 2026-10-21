/* Customer order tracking. DOM built with textContent only. */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('track-form');
  if (!form) return;
  const err = document.getElementById('t-error');
  const out = document.getElementById('t-result');
  const btn = document.getElementById('t-btn');

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const fmt = iso => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
  const inr = p => '₹' + (p / 100).toLocaleString('en-IN');

  const STEPS = [['Order placed', o => o.placedAt], ['Payment confirmed', o => o.paidAt],
    ['Packed', o => (['packed', 'shipped', 'delivered'].includes(o.fulfillment) ? o.paidAt : null)],
    ['Shipped', o => o.shippedAt || (['shipped', 'delivered'].includes(o.fulfillment) ? o.paidAt : null)],
    ['Delivered', o => o.deliveredAt || (o.fulfillment === 'delivered' ? o.shippedAt : null)]];

  function render(o) {
    out.replaceChildren(
      el('h2', '', `Order ${o.orderId}`),
      el('p', 'track-sub', `Placed ${fmt(o.placedAt)} · ${o.items.map(i => `${i.name} (${i.weight}) × ${i.qty}`).join(', ')} · ${inr(o.totalPaise)}`));
    if (o.fulfillment === 'refunded') {
      out.append(el('p', 'track-note', 'This order has been refunded to your original payment method. Refunds can take a few days to show in your account.'));
      return;
    }
    const list = el('ol', 'track-steps');
    STEPS.forEach(([label, get], i) => {
      const when = get(o);
      const li = el('li', when ? 'done' : '');
      li.append(el('strong', '', label), el('span', '', when ? fmt(when) : i === 2 && o.fulfillment === 'unfulfilled' ? 'We are preparing your jar' : 'Not yet'));
      list.append(li);
    });
    out.append(list);
    if (o.trackingNumber) {
      out.append(el('p', 'track-note', `Shipped with ${o.courier || 'our courier partner'} — tracking number ${o.trackingNumber}. Use it on the courier’s website for live location.`));
    } else {
      out.append(el('p', 'track-note', `Orders are dispatched within 1–2 business days. ${o.shippingMethod === 'express' ? 'Express delivery takes 2–3 business days.' : 'Standard delivery takes 5–7 business days.'}`));
    }
    out.append(el('p', 'track-note', 'Need help? Email hello@houseofmangalya.com with your order number.'));
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    out.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await fetch('/api/orders/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: form.elements.orderId.value, email: form.elements.email.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      render(data);
      out.hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Track order';
    }
  });
});
