/* Orders, To-ship queue, abandoned-checkout recovery, and the order drawer */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, inr, num, fmtDate } = A;
  const $ = A.$;

  // ── Shared orders table ────────────────────────
  A.ordersTable = (orders, { compact = false, selection = null, onToggle = null } = {}) => {
    const columns = [];
    if (selection) {
      columns.push({
        title: '', render: o => h('input', {
          type: 'checkbox', 'aria-label': `Select ${o.id}`, checked: selection.has(o.id),
          onchange: e => { e.target.checked ? selection.add(o.id) : selection.delete(o.id); onToggle?.(); },
        }),
      });
    }
    columns.push(
      { title: 'Order', render: o => h('span', {}, h('span', { class: 'mono', text: o.id }), h('span', { class: 'sub', text: fmtDate(o.createdAt) })) },
      { title: 'Customer', render: o => h('span', {}, o.name, h('span', { class: 'sub', text: o.email })) },
      { title: 'Ship to', render: o => h('span', {}, o.city, h('span', { class: 'sub', text: o.state })) },
      { title: 'Units', num: true, render: o => num(o.units) },
      { title: 'Total', num: true, render: o => h('span', {}, inr(o.totalPaise), o.couponCode ? h('span', { class: 'sub', text: `${o.couponCode} −${inr(o.discountPaise)}` }) : null) },
      { title: 'Payment', render: o => h('span', {}, A.badge(A.PAYMENT, o.status), o.paymentMethod ? h('span', { class: 'sub', text: o.paymentMethod.toUpperCase() }) : null) },
      { title: 'Fulfilment', render: o => (o.status === 'paid' || o.status === 'refunded' ? h('span', {}, A.badge(A.FULFIL, o.fulfillment), o.trackingNumber ? h('span', { class: 'sub mono', text: o.trackingNumber }) : null) : h('span', { class: 'muted', text: '—' })) },
    );
    if (compact) columns.splice(2, 1); // drop "Ship to" in the dashboard's narrow card
    return A.table(columns, orders, { onRow: o => A.openOrder(o.id), empty: 'No orders match these filters' });
  };

  // ── Orders / To-ship (same engine, different presets) ──
  function ordersView(key, { title, preset }) {
    const selection = new Set();
    let pageOrders = [];
    const ids = { form: `${key}-filters`, table: `${key}-table`, pager: `${key}-pager`, bulk: `${key}-bulk` };

    const bulkBar = () => {
      const n = selection.size;
      A.mount(ids.bulk,
        h('strong', { text: `${n} selected` }),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '▣ Mark packed', onclick: () => bulkPack() }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '🧾 Invoices', onclick: () => printDocs('invoice') }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '📦 Packing slips', onclick: () => printDocs('slip') }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Clear', onclick: () => { selection.clear(); render(); } }));
      $(ids.bulk).hidden = n === 0;
    };
    const printDocs = type => {
      if (!selection.size) return;
      window.open(`print.html?type=${type}&ids=${[...selection].map(encodeURIComponent).join(',')}`, '_blank', 'noopener');
    };
    const bulkPack = async () => {
      const ok = await A.confirm('Mark as packed?', `${selection.size} selected order(s) that are still “Unfulfilled” will be marked packed. Others are skipped.`, 'Mark packed');
      if (!ok) return;
      await A.guard(async () => {
        const r = await A.post('/api/admin/orders/bulk/fulfillment', { ids: [...selection], status: 'packed' });
        A.toast(`${r.updated} marked packed${r.skipped ? `, ${r.skipped} skipped` : ''}`);
        selection.clear();
        A.refresh();
      });
    };

    function render() {
      const table = A.ordersTable(pageOrders, { selection, onToggle: bulkBar });
      A.mount(ids.table, table);
      const head = table.querySelector?.('thead tr');
      if (head && pageOrders.length) {
        const all = h('input', {
          type: 'checkbox', 'aria-label': 'Select all on this page', checked: pageOrders.every(o => selection.has(o.id)),
          onchange: e => { pageOrders.forEach(o => (e.target.checked ? selection.add(o.id) : selection.delete(o.id))); render(); },
        });
        head.firstChild.replaceChildren(all);
      }
      bulkBar();
    }

    function query() {
      const f = $(ids.form);
      const p = new URLSearchParams();
      if (f.elements.q.value.trim()) p.set('q', f.elements.q.value.trim());
      if (f.elements.payment.value) p.set('payment', f.elements.payment.value);
      if (f.elements.fulfillment.value) p.set('fulfillment', f.elements.fulfillment.value);
      if (f.elements.useRange.checked) { const r = A.currentRange(); p.set('from', r.from); p.set('to', r.to); }
      return p;
    }

    async function load() {
      const p = query();
      p.set('page', A.state.pages[key] || 1);
      p.set('pageSize', 25);
      const d = await A.api('/api/admin/orders?' + p);
      pageOrders = d.orders;
      render();
      A.pager(ids.pager, d, key, load);
    }

    function init(el) {
      const opt = (v, t) => h('option', { value: v, text: t });
      let timer;
      const form = h('form', { class: 'filters', id: ids.form, role: 'search', onsubmit: e => e.preventDefault() },
        h('input', { type: 'search', name: 'q', placeholder: 'Search order #, name, email, phone, payment ID, tracking…', 'aria-label': 'Search orders', maxlength: '80' }),
        h('select', { name: 'payment', 'aria-label': 'Payment status' }, opt('', 'All payments'), opt('paid', '✓ Paid'), opt('pending', '◷ Pending'), opt('authorized', '◐ Authorized'), opt('abandoned', '⊘ Abandoned'), opt('failed', '✕ Failed'), opt('refunded', '↺ Refunded')),
        h('select', { name: 'fulfillment', 'aria-label': 'Fulfilment status' }, opt('', 'All fulfilment'), opt('toship', 'To ship (unfulfilled + packed)'), opt('unfulfilled', 'Unfulfilled'), opt('packed', 'Packed'), opt('shipped', 'Shipped'), opt('delivered', 'Delivered'), opt('cancelled', 'Cancelled')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'useRange' }), ' In date range'),
        h('button', { type: 'button', class: 'btn btn-ghost', text: '⬇ Export CSV', onclick: () => { location.href = '/api/admin/export/orders.csv?' + query(); } }));
      form.addEventListener('input', e => {
        clearTimeout(timer);
        timer = setTimeout(() => { A.state.pages[key] = 1; load().catch(err => A.showError(err.message)); }, e.target.type === 'search' ? 300 : 0);
      });
      form.elements.payment.value = preset.payment || '';
      form.elements.fulfillment.value = preset.fulfillment || '';
      el.append(form, h('div', { class: 'bulkbar', id: ids.bulk, hidden: true }),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: ids.table }), h('div', { class: 'pager', id: ids.pager })));
    }
    return { title, range: true, init, load, setSearch: q => { const f = $(ids.form); f.elements.q.value = q; A.state.pages[key] = 1; } };
  }

  A.register('orders', ordersView('orders', { title: 'Orders', preset: {} }));
  A.register('fulfilment', ordersView('toship', { title: 'To ship', preset: { payment: 'paid', fulfillment: 'toship' } }));

  // ── Recover abandoned & failed checkouts ───────
  A.register('recover', {
    title: 'Recover sales',
    init(el) {
      const days = h('select', { id: 'rc-days', 'aria-label': 'How far back' },
        [3, 7, 14, 30].map(d => h('option', { value: d, text: `Last ${d} days`, selected: d === 7 })));
      days.addEventListener('change', () => A.views.recover.load());
      el.append(
        h('p', { class: 'muted', text: 'People who started checkout but never paid, or whose payment failed — and who have not bought since. A friendly message within a day or two wins back a good share of them. Open WhatsApp or email with a ready-to-edit message.' }),
        h('div', { class: 'toolbar' }, h('span', { class: 'muted', id: 'rc-summary' }), days),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'rc-table' })));
    },
    async load() {
      const d = await A.api(`/api/admin/abandoned?days=${$('rc-days').value}`);
      $('rc-summary').textContent = `${num(d.total)} to follow up · ${inr(d.valuePaise)} of carts`;
      const store = A.state.me.storeOrigin;
      const first = n => String(n || '').split(' ')[0];
      A.mount('rc-table', A.table([
        { title: 'Customer', render: r => h('span', {}, r.name, h('span', { class: 'sub', text: r.email })) },
        { title: 'Type', render: r => A.pill(r.kind === 'failed' ? 'critical' : 'neutral', r.kind === 'failed' ? '✕ Payment failed' : '⊘ Left at checkout') },
        { title: 'Cart', num: true, render: r => inr(r.totalPaise) },
        { title: 'When', render: r => h('span', {}, A.ago(r.createdAt), h('span', { class: 'sub', text: fmtDate(r.createdAt) })) },
        { title: 'Source', render: r => r.source || '—' },
        {
          title: 'Reach out', render: r => {
            const msg = `Hi ${first(r.name)}, this is House of Mangalya 🌿 We noticed your order of pure turmeric didn't go through. Need any help finishing it? You can complete it here: ${store}/checkout.html`;
            return h('span', { class: 'row-actions' },
              h('a', { class: 'btn btn-ghost btn-sm', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/${A.digits(r.phone)}?text=${encodeURIComponent(msg)}`, text: 'WhatsApp' }),
              h('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${r.email}?subject=${encodeURIComponent('Your House of Mangalya order')}&body=${encodeURIComponent(msg)}`, text: 'Email' }));
          },
        },
      ], d.rows, { onRow: r => A.openOrder(r.id), empty: 'No abandoned or failed checkouts in this period 🎉' }));
    },
  });

  // ── Order drawer ───────────────────────────────
  function closeDrawer() {
    $('order-drawer').hidden = true;
    $('drawer-overlay').hidden = true;
    A.state.openOrderId = null;
  }
  A.closeDrawer = closeDrawer;
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-overlay').addEventListener('click', closeDrawer);

  A.openOrder = async id => {
    A.state.openOrderId = id;
    $('drawer-title').textContent = id;
    $('drawer-badges').replaceChildren();
    A.mount('drawer-body', h('p', { class: 'muted', text: 'Loading…' }));
    $('order-drawer').hidden = false;
    $('drawer-overlay').hidden = false;
    $('drawer-close').focus();
    try {
      renderOrder(await A.api('/api/admin/orders/' + encodeURIComponent(id)));
    } catch (err) {
      A.mount('drawer-body', h('p', { class: 'form-error', text: err.message }));
    }
  };

  async function act(path, body, okMsg) {
    await A.guard(async () => {
      const d = await A.post(`/api/admin/orders/${encodeURIComponent(A.state.openOrderId)}/${path}`, body);
      renderOrder(d.order || d);
      A.toast(okMsg(d));
      A.refresh();
    });
  }

  function chatMessage(o) {
    const first = String(o.customer.name).split(' ')[0];
    if (o.fulfillment === 'shipped' && o.trackingNumber) return `Hi ${first}, your House of Mangalya order ${o.id} is on its way via ${o.courier || 'courier'} (tracking no. ${o.trackingNumber}). Thank you! 🌿`;
    if (o.fulfillment === 'delivered') return `Hi ${first}, your House of Mangalya order ${o.id} has been delivered. We hope you love it! Reply here if anything is not right. 🌿`;
    if (o.rawStatus === 'paid') return `Hi ${first}, thank you for your House of Mangalya order ${o.id}! We're packing it now and will share tracking soon. 🌿`;
    return `Hi ${first}, this is House of Mangalya about your order ${o.id}.`;
  }

  function renderOrder(o) {
    $('drawer-title').textContent = o.id;
    $('drawer-badges').replaceChildren(A.badge(A.PAYMENT, o.status), o.rawStatus === 'paid' ? A.badge(A.FULFIL, o.fulfillment) : '');
    const c = o.customer;
    const addressText = [c.name, c.address1, c.address2, `${c.city}, ${c.state} ${c.pincode}`, c.phone].filter(Boolean).join('\n');
    const sections = [];
    const openDoc = type => window.open(`print.html?type=${type}&ids=${encodeURIComponent(o.id)}`, '_blank', 'noopener');

    sections.push(h('div', { class: 'section' }, h('h4', { text: 'Items' }),
      h('ul', { class: 'items' },
        o.items.map(i => h('li', {}, h('span', { text: `${i.name} (${i.weight}) × ${i.qty}` }), h('span', { text: inr(i.lineTotalPaise) }))),
        h('li', { class: 'minor' }, h('span', { text: 'Subtotal' }), h('span', { text: inr(o.subtotalPaise) })),
        o.discountPaise ? h('li', { class: 'minor' }, h('span', { text: `Coupon ${o.couponCode}` }), h('span', { text: '−' + inr(o.discountPaise) })) : null,
        h('li', { class: 'minor' }, h('span', { text: `Shipping (${o.shippingMethod})` }), h('span', { text: o.shippingPaise ? inr(o.shippingPaise) : 'Free' })),
        h('li', { class: 'total' }, h('span', { text: 'Total' }), h('span', { text: inr(o.totalPaise) })),
        o.refundedPaise ? h('li', { class: 'minor' }, h('span', { text: `Refunded (${o.refundStatus})` }), h('span', { text: '−' + inr(o.refundedPaise) })) : null),
      o.rawStatus === 'paid' ? h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '🧾 GST invoice', onclick: () => openDoc('invoice') }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '📦 Packing slip', onclick: () => openDoc('slip') })) : null));

    const wa = `https://wa.me/${A.digits(c.phone)}?text=${encodeURIComponent(chatMessage(o))}`;
    sections.push(h('div', { class: 'section' }, h('h4', {}, 'Customer & shipping address', A.copyBtn(addressText)),
      A.kv([
        ['Name', c.name], ['Email', h('a', { href: `mailto:${c.email}`, text: c.email })], ['Phone', h('a', { href: `tel:${c.phone}`, text: c.phone })],
        ['Address', [c.address1, c.address2].filter(Boolean).join(', ')], ['City / State', `${c.city}, ${c.state}`], ['PIN code', c.pincode],
      ]),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-ghost btn-sm', href: wa, target: '_blank', rel: 'noopener noreferrer', text: '💬 WhatsApp customer' }),
        h('a', { class: 'btn btn-ghost btn-sm', href: `mailto:${c.email}?subject=${encodeURIComponent('Your House of Mangalya order ' + o.id)}&body=${encodeURIComponent(chatMessage(o))}`, text: '✉️ Email customer' }))));

    sections.push(h('div', { class: 'section' }, h('h4', { text: 'Payment' }),
      A.kv([
        ['Status', A.badge(A.PAYMENT, o.status)], ['Gateway', o.provider === 'mock' ? 'Test gateway' : 'Razorpay'],
        ['Gateway order', h('span', { class: 'mono', text: o.providerOrderId })], ['Payment ID', o.paymentId ? h('span', { class: 'mono', text: o.paymentId }) : '—'],
        ['Method', o.paymentMethod ? o.paymentMethod.toUpperCase() : '—'], o.invoiceNo ? ['Invoice no.', h('span', { class: 'mono', text: o.invoiceNo })] : null,
        o.refundId ? ['Refund', h('span', {}, h('span', { class: 'mono', text: o.refundId }), ` · ${o.refundStatus}`)] : null,
        o.attribution?.source ? ['Came from', [o.attribution.source, o.attribution.medium, o.attribution.campaign].filter(Boolean).join(' / ')] : null,
      ]),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '↻ Check status with gateway', onclick: () => act('sync', {}, d => `Gateway: ${d.gatewayPayments.length} payment(s) — ${d.result}`) }))));

    if (o.rawStatus === 'paid' && !o.refundId) {
      const sel = h('select', { id: 'f-status' }, Object.entries(A.FULFIL).filter(([k]) => k !== 'refunded').map(([k, [, label]]) => h('option', { value: k, text: label, selected: k === o.fulfillment })));
      const courier = h('select', { id: 'f-courier' }, h('option', { value: '', text: 'Select courier' }),
        ['Delhivery', 'BlueDart', 'India Post', 'DTDC', 'Ekart', 'Shiprocket', 'DHL', 'FedEx'].map(k => h('option', { value: k, text: k, selected: k === o.courier })));
      const tracking = h('input', { id: 'f-tracking', value: o.trackingNumber || '', maxlength: '60', placeholder: 'AWB / tracking no.' });
      sections.push(h('form', {
        class: 'section',
        onsubmit: e => { e.preventDefault(); act('fulfillment', { status: sel.value, courier: courier.value, trackingNumber: tracking.value.trim() }, () => 'Fulfilment updated'); },
      }, h('h4', { text: 'Fulfilment' }),
        h('div', { class: 'form-grid' },
          h('div', { class: 'full' }, h('label', { for: 'f-status', text: 'Status' }), sel),
          h('div', {}, h('label', { for: 'f-courier', text: 'Courier' }), courier),
          h('div', {}, h('label', { for: 'f-tracking', text: 'Tracking number' }), tracking)),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save fulfilment' }))));
    }

    const note = h('textarea', { id: 'f-note', maxlength: '1000', placeholder: 'Internal note — never shown to the customer' });
    note.value = o.adminNote || '';
    sections.push(h('form', { class: 'section', onsubmit: e => { e.preventDefault(); act('note', { note: note.value }, () => 'Note saved'); } },
      h('h4', {}, h('label', { for: 'f-note', text: 'Internal note' })), note,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'submit', text: 'Save note' }))));

    const t = o.timeline;
    sections.push(h('div', { class: 'section' }, h('h4', { text: 'Timeline (IST)' }),
      h('ul', { class: 'timeline' }, [['Checkout started', t.createdAt], ['Payment confirmed', t.paidAt], ['Shipped', t.shippedAt], ['Delivered', t.deliveredAt], ['Refunded', t.refundedAt]]
        .filter(([k, v]) => v || k !== 'Refunded')
        .map(([k, v]) => h('li', { class: v ? 'done' : null }, h('span', {}, k, h('span', { class: 'sub', text: v ? fmtDate(v) : 'Not yet' })))))));

    if (o.webhooks.length) {
      sections.push(h('div', { class: 'section' }, h('h4', { text: 'Gateway webhooks' }), A.table([
        { title: 'Received', render: w => fmtDate(w.received_at) }, { title: 'Event', render: w => h('span', { class: 'mono', text: w.event }) }, { title: 'Result', render: w => w.outcome || '—' },
      ], o.webhooks)));
    }
    if (o.audit.length) {
      sections.push(h('div', { class: 'section' }, h('h4', { text: 'Admin activity' }), A.table([
        { title: 'When', render: a => fmtDate(a.at) }, { title: 'Who', render: a => a.actor },
        { title: 'Action', wrap: true, render: a => `${a.action.replace('order.', '')}${a.detail ? ' — ' + a.detail : ''}` },
      ], o.audit)));
    }

    if (o.rawStatus === 'paid' && !o.refundId && o.paymentId) {
      const amount = h('input', { id: 'f-refund-amt', type: 'number', min: '1', step: '0.01', max: String(o.totalPaise / 100), value: String(o.totalPaise / 100) });
      const confirm = h('input', { id: 'f-refund-confirm', placeholder: o.id, autocomplete: 'off' });
      const btn = h('button', { class: 'btn btn-danger', type: 'submit', text: 'Issue refund', disabled: true });
      confirm.addEventListener('input', () => { btn.disabled = confirm.value.trim() !== o.id; });
      sections.push(h('form', {
        class: 'section danger-zone',
        onsubmit: e => {
          e.preventDefault();
          const paise = Math.round(Number(amount.value) * 100);
          act('refund', { confirm: confirm.value.trim(), amountPaise: paise }, () => `Refund of ${inr(paise)} issued`);
        },
      }, h('h4', { text: 'Refund' }),
        h('p', { text: 'Refunds go back to the customer’s original payment method through the gateway (usually 5–7 days). This cannot be undone.' }),
        h('div', { class: 'form-grid' },
          h('div', {}, h('label', { for: 'f-refund-amt', text: 'Amount (₹)' }), amount),
          h('div', {}, h('label', { for: 'f-refund-confirm', text: `Type ${o.id} to confirm` }), confirm)),
        h('div', { class: 'actions' }, btn)));
    }
    A.mount('drawer-body', ...sections);
  }
})();
