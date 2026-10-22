/* ================================================
   HOUSE OF MANGALYA — Checkout
   The browser only sends product ids + quantities and the
   customer's details. Prices, totals and payment status are
   decided and verified on the server.
   ================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const form = $('checkout-form');
  if (!form) return;

  const payBtn = $('pay-btn');
  const payLabel = $('pay-btn-label');
  const formError = $('form-error');
  let config = null;
  let quote = null;
  let busy = false;
  let appliedCode = '';
  const couponInput = $('f-coupon');
  const couponMsg = $('coupon-msg');

  function setCouponMsg(text, ok) {
    couponMsg.textContent = text || '';
    couponMsg.className = 'coupon-msg' + (text ? (ok ? ' ok' : ' bad') : '');
  }
  const emailForQuote = () => {
    const v = (form.elements.email?.value || '').trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : '';
  };

  const inr = paise => '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2
  });

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.field = data.field;
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data };
  }

  function show(section) {
    for (const id of ['checkout-layout', 'checkout-empty', 'checkout-success']) $(id).hidden = id !== section;
  }

  function setBusy(on, label) {
    busy = on;
    payBtn.disabled = on || !quote;
    payLabel.textContent = label || (quote ? `Pay ${inr(quote.totalPaise)} securely` : 'Pay securely');
  }

  function showFormError(msg) {
    formError.textContent = msg || '';
    formError.hidden = !msg;
  }

  function clearFieldErrors() {
    form.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  }

  function setFieldError(field, msg) {
    const input = form.elements[field];
    const slot = form.querySelector(`[data-error-for="${CSS.escape(field)}"]`);
    if (slot) slot.textContent = msg;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  }

  // ── Order summary ──────────────────────────────
  function renderSummary() {
    const list = $('summary-lines');
    list.replaceChildren();
    if (!quote) return;
    for (const line of quote.lines) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${line.name} (${line.weight}) × ${line.qty}`;
      const price = document.createElement('span');
      price.textContent = inr(line.lineTotalPaise);
      li.append(name, price);
      list.appendChild(li);
    }
    $('sum-subtotal').textContent = inr(quote.subtotalPaise);
    $('sum-discount-row').hidden = !quote.discountPaise;
    $('sum-coupon-code').textContent = quote.couponCode ? `(${quote.couponCode})` : '';
    $('sum-discount').textContent = '−' + inr(quote.discountPaise || 0);
    $('sum-shipping').textContent = quote.shippingPaise === 0 ? 'Free' : inr(quote.shippingPaise);
    $('sum-total').textContent = inr(quote.totalPaise);
  }

  function selectedShipping() {
    return form.querySelector('input[name="shipping"]:checked')?.value || 'standard';
  }

  async function refreshQuote() {
    const items = Cart.get();
    if (items.length === 0) {
      quote = null;
      show('checkout-empty');
      return;
    }
    show('checkout-layout');
    let stockProblem = '';
    try {
      ({ data: quote } = await api('/api/checkout/quote', {
        items, shippingMethod: selectedShipping(), couponCode: appliedCode || undefined, email: emailForQuote() || undefined
      }));
      if (quote.couponError) {
        setCouponMsg(quote.couponError, false);
        appliedCode = '';
      } else if (appliedCode && quote.discountPaise) {
        setCouponMsg(`✓ ${quote.couponCode} applied — you save ${inr(quote.discountPaise)}`, true);
      }
      stockProblem = quote.stockError || '';
      showFormError(stockProblem);
    } catch (e) {
      quote = null;
      showFormError(e.message);
    }
    renderSummary();
    setBusy(false);
    if (stockProblem) payBtn.disabled = true;
  }

  async function applyCoupon() {
    const code = couponInput.value.trim().toUpperCase();
    if (!code) { appliedCode = ''; setCouponMsg(''); return refreshQuote(); }
    appliedCode = code;
    setCouponMsg('Checking…', true);
    await refreshQuote();
    if (!quote) setCouponMsg('');
  }
  $('coupon-apply').addEventListener('click', applyCoupon);
  couponInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } });
  // Per-customer coupon limits depend on the email, so re-check when it is filled in
  form.elements.email?.addEventListener('change', () => { if (appliedCode) refreshQuote(); });

  // ── Form ───────────────────────────────────────
  function readCustomer() {
    const v = name => (form.elements[name]?.value || '').trim();
    return {
      name: v('name'), email: v('email'), phone: v('phone'),
      address1: v('address1'), address2: v('address2'),
      city: v('city'), state: v('state'), pincode: v('pincode')
    };
  }

  function clientValidate() {
    for (const el of form.querySelectorAll('input, select')) {
      if (el.name === 'shipping') continue;
      if (!el.checkValidity()) {
        if (el.name === 'consent') { setFieldError('consent', 'Please accept the terms and privacy policy to continue'); return false; }
        const label = form.querySelector(`label[for="${el.id}"]`)?.childNodes[0]?.textContent.trim() || 'This field';
        setFieldError(el.name, el.validity.valueMissing ? `${label} is required` : `${label} is invalid`);
        return false;
      }
    }
    return true;
  }

  async function verify(response) {
    setBusy(true, 'Confirming payment…');
    try {
      const { status, data } = await api('/api/checkout/verify', {
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature
      });
      Cart.clear();
      try { localStorage.removeItem('hom_coupon'); } catch { /* ignore */ }
      $('success-order-id').textContent = data.orderId;
      if (status === 202) {
        $('success-message').textContent = data.message;
        $('success-total').parentElement.hidden = true;
      } else {
        $('success-email').textContent = data.email;
        $('success-total').textContent = inr(data.totalPaise);
      }
      show('checkout-success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      showFormError(`${e.message} If money was deducted, it will be refunded automatically — or email hello@houseofmangalya.com.`);
      setBusy(false);
    }
  }

  // ── Gateways ───────────────────────────────────
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the payment window. Check your connection and try again.'));
      document.head.appendChild(s);
    });
  }

  async function payWithRazorpay(order) {
    await loadRazorpay();
    const rzp = new window.Razorpay({
      key: order.keyId,
      order_id: order.providerOrderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: 'House of Mangalya',
      description: `Order ${order.orderId}`,
      image: new URL('assets/logo.png', location.href).href,
      prefill: order.prefill,
      notes: { order_id: order.orderId },
      theme: { color: '#C8963E' },
      handler: verify,
      modal: {
        confirm_close: true,
        ondismiss: () => { if (busy) setBusy(false); }
      }
    });
    rzp.on('payment.failed', resp => {
      showFormError(`Payment failed: ${resp?.error?.description || 'please try again or use another method.'}`);
      setBusy(false);
    });
    rzp.open();
  }

  function payWithMock(order) {
    const modal = $('mock-gateway');
    $('mock-amount').textContent = inr(order.amountPaise);
    modal.hidden = false;
    modal.querySelector('[data-mock="success"]').focus();

    const onClick = async e => {
      const outcome = e.target.closest('[data-mock]')?.dataset.mock;
      if (!outcome) return;
      modal.removeEventListener('click', onClick);
      modal.hidden = true;
      if (outcome === 'cancel') return setBusy(false);
      try {
        const { data } = await api('/api/checkout/mock-pay', { providerOrderId: order.providerOrderId, outcome });
        if (data.failed) {
          showFormError(`Payment failed: ${data.error}`);
          return setBusy(false);
        }
        await verify(data);
      } catch (err) {
        showFormError(err.message);
        setBusy(false);
      }
    };
    modal.addEventListener('click', onClick);
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy || !quote) return;
    clearFieldErrors();
    showFormError('');
    if (!clientValidate()) return;

    setBusy(true, 'Creating secure order…');
    try {
      const { data: order } = await api('/api/checkout/create-order', {
        items: Cart.get(),
        shippingMethod: selectedShipping(),
        customer: readCustomer(),
        couponCode: appliedCode || undefined,
        attribution: Attribution.get()
      });
      quote = order.quote;
      renderSummary();
      setBusy(true, 'Waiting for payment…');
      if (order.provider === 'mock') payWithMock(order);
      else await payWithRazorpay(order);
    } catch (err) {
      if (err.field === 'coupon') {
        setCouponMsg(err.message, false);
        appliedCode = '';
        refreshQuote();
      } else if (err.field) setFieldError(err.field, err.message);
      else showFormError(err.message);
      setBusy(false);
    }
  });

  form.addEventListener('input', e => {
    const slot = form.querySelector(`[data-error-for="${CSS.escape(e.target.name || '')}"]`);
    if (slot) slot.textContent = '';
    e.target.removeAttribute?.('aria-invalid');
  });

  document.addEventListener('cart:change', refreshQuote);

  // ── Init ───────────────────────────────────────
  (async () => {
    try {
      ({ data: config } = await api('/api/config'));
    } catch {
      show('checkout-layout');
      showFormError('Checkout is unavailable. If you are running locally, start the server with "npm start" and open http://localhost:3000.');
      return;
    }
    $('test-banner').hidden = !(config.provider === 'mock' || String(config.keyId).startsWith('rzp_test_'));

    const stateSel = form.elements.state;
    for (const s of config.states) stateSel.add(new Option(s, s));

    const opts = $('shipping-options');
    config.shipping.forEach((s, i) => {
      const label = document.createElement('label');
      label.className = 'shipping-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'shipping';
      input.value = s.id;
      input.checked = i === 0;
      input.addEventListener('change', refreshQuote);
      const text = document.createElement('span');
      text.className = 'shipping-option-text';
      const title = document.createElement('strong');
      title.textContent = s.label;
      const sub = document.createElement('small');
      sub.textContent = s.freeAbovePaise !== null ? `${inr(s.feePaise)} · Free above ${inr(s.freeAbovePaise)}` : inr(s.feePaise);
      text.append(title, sub);
      label.append(input, text);
      opts.appendChild(label);
    });

    // A code from the newsletter sign-up or a shared link (?coupon=CODE) is applied automatically
    try {
      const fromUrl = new URLSearchParams(location.search).get('coupon');
      const saved = fromUrl || localStorage.getItem('hom_coupon') || '';
      if (/^[A-Za-z0-9_-]{3,20}$/.test(saved)) { appliedCode = saved.toUpperCase(); couponInput.value = appliedCode; }
    } catch { /* storage blocked */ }
    await refreshQuote();
  })();
});
