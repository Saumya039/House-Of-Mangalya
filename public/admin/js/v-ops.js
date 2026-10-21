/* Operations: inventory, payment events, subscribers, settings, audit log */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, inr, num, fmtDate } = A;

  // ── Inventory ──────────────────────────────────
  const STOCK = { in: ['good', '✓ In stock'], low: ['warning', '▲ Low stock'], out: ['critical', '✕ Out of stock'] };

  A.register('inventory', {
    title: 'Inventory',
    init(el) {
      el.append(
        h('p', { class: 'muted', text: 'The store checks this before every order and shows “Only N left” on the product page. Stock goes down automatically when a payment succeeds. Record deliveries from your farm/packer here and do a physical count now and then.' }),
        h('div', { id: 'iv-cards', class: 'inventory-grid' }));
    },
    async load() {
      const d = await A.api('/api/admin/inventory');
      A.mount('iv-cards', ...d.items.map(item => card(item)));
    },
  });

  function card(item) {
    const reload = () => A.views.inventory.load();
    const run = body => A.guard(async () => { await A.post(`/api/admin/inventory/${encodeURIComponent(item.productId)}/adjust`, body); A.toast('Stock updated'); reload(); });

    const recvQty = h('input', { type: 'number', step: '1', min: '1', max: '100000', placeholder: 'Units', 'aria-label': 'Units received' });
    const recvWhy = h('input', { placeholder: 'e.g. batch from farm', maxlength: '80', 'aria-label': 'Reason' });
    const countQty = h('input', { type: 'number', step: '1', min: '0', max: '1000000', placeholder: 'Counted', 'aria-label': 'Counted stock' });
    const threshold = h('input', { type: 'number', step: '1', min: '0', max: '10000', value: String(item.lowThreshold), 'aria-label': 'Low-stock alert level' });

    return h('div', { class: 'card inv-card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h3', { text: item.name }), h('span', { class: 'muted', text: `${item.weight} · ${item.productId}` })), A.badge(STOCK, item.status)),
      h('div', { class: 'inv-stock' }, h('span', { class: 'inv-number', text: num(item.stock) }), h('span', { class: 'muted', text: item.stock < 0 ? 'oversold — resolve with the customers affected' : 'units on hand' })),
      h('div', { class: 'inv-forms' },
        h('form', { class: 'inline-form', onsubmit: e => { e.preventDefault(); run({ mode: 'delta', value: Number(recvQty.value), reason: recvWhy.value }); } },
          recvQty, recvWhy, h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: '+ Receive stock' })),
        h('form', { class: 'inline-form', onsubmit: async e => {
          e.preventDefault();
          if (await A.confirm('Set stock count?', `Replace the current ${item.stock} with ${countQty.value}? The difference is logged.`, 'Set count')) run({ mode: 'set', value: Number(countQty.value), reason: 'physical count' });
        } }, countQty, h('button', { class: 'btn btn-ghost btn-sm', type: 'submit', text: 'Set exact count' })),
        h('form', { class: 'inline-form', onsubmit: e => {
          e.preventDefault();
          A.guard(async () => { await A.post(`/api/admin/inventory/${encodeURIComponent(item.productId)}/threshold`, { value: Number(threshold.value) }); A.toast('Alert level saved'); reload(); });
        } }, h('label', { class: 'muted small', text: 'Warn me at' }), threshold, h('button', { class: 'btn btn-ghost btn-sm', type: 'submit', text: 'Save' }))),
      h('h4', { class: 'small-h', text: 'Recent movements' }),
      h('div', { class: 'table-wrap scroll-y' }, A.table([
        { title: 'When', render: l => fmtDate(l.at) }, { title: 'Change', num: true, render: l => (l.delta > 0 ? '+' : '') + num(l.delta) },
        { title: 'Balance', num: true, render: l => num(l.stock_after) }, { title: 'Why', render: l => l.reason || '' },
        { title: 'Order', render: l => (l.order_id ? h('a', { href: '#', class: 'mono', text: l.order_id, onclick: e => { e.preventDefault(); A.openOrder(l.order_id); } }) : '') },
      ], item.history, { empty: 'No movements yet.' })));
  }

  // ── Payment events ─────────────────────────────
  const OUTCOME = {
    'marked-paid': ['good', '✓ Marked paid'], 'marked-failed': ['critical', '✕ Marked failed'], 'marked-authorized': ['warning', '◐ Authorized'],
    'amount-mismatch': ['critical', '⚠ Amount mismatch'], 'unknown-order': ['neutral', '? Unknown order'], ignored: ['neutral', '— Ignored'],
    'refund-processed': ['serious', '↺ Refund processed'], 'refund-failed': ['critical', '✕ Refund failed'], 'refund-pending': ['info', '◷ Refund pending'],
  };
  A.register('payments', {
    title: 'Payment events',
    init(el) {
      el.append(h('p', { class: 'muted', text: 'Signed webhook events from the payment gateway. “Amount mismatch” means the gateway reported a different amount than the order — never auto-confirmed. Use this to reconcile payments.' }),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'pe-table' }), h('div', { class: 'pager', id: 'pe-pager' })));
    },
    async load() {
      const d = await A.api(`/api/admin/webhooks?page=${A.state.pages.payments || 1}&pageSize=50`);
      A.mount('pe-table', A.table([
        { title: 'Received', render: w => fmtDate(w.received_at) }, { title: 'Event', render: w => h('span', { class: 'mono', text: w.event }) },
        { title: 'Result', render: w => A.badge(OUTCOME, w.outcome) }, { title: 'Gateway order', render: w => h('span', { class: 'mono', text: w.provider_order_id || '—' }) },
        { title: 'Payment', render: w => h('span', { class: 'mono', text: w.payment_id || '—' }) }, { title: 'Amount', num: true, render: w => (w.amount_paise === null ? '—' : inr(w.amount_paise)) },
      ], d.rows, { empty: 'No webhook events yet. Add the webhook URL in your Razorpay dashboard.' }));
      A.pager('pe-pager', d, 'payments', () => A.views.payments.load());
    },
  });

  // ── Subscribers ────────────────────────────────
  A.register('subscribers', {
    title: 'Subscribers',
    init(el) {
      el.append(h('div', { class: 'toolbar' }, h('span', { class: 'muted', id: 'sb-count' }), h('button', { class: 'btn btn-ghost', type: 'button', text: '⬇ Export CSV', onclick: () => { location.href = '/api/admin/export/subscribers.csv'; } })),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'sb-table' }), h('div', { class: 'pager', id: 'sb-pager' })));
    },
    async load() {
      const d = await A.api(`/api/admin/subscribers?page=${A.state.pages.subscribers || 1}&pageSize=50`);
      A.$('sb-count').textContent = `${num(d.total)} subscriber${d.total === 1 ? '' : 's'} · each is offered the WELCOME10 coupon on sign-up`;
      A.mount('sb-table', A.table([
        { title: 'Email', render: s => h('a', { href: `mailto:${s.email}`, text: s.email }) }, { title: 'Subscribed', render: s => fmtDate(s.created_at) },
      ], d.rows, { empty: 'No subscribers yet' }));
      A.pager('sb-pager', d, 'subscribers', () => A.views.subscribers.load());
    },
  });

  // ── Settings ───────────────────────────────────
  const GROUPS = [
    ['Business & invoice details', 'Printed on GST invoices and packing slips.', [
      ['biz_name', 'Business name', {}], ['gstin', 'GSTIN', { placeholder: '27ABCDE1234F1Z5', maxlength: 15 }], ['fssai', 'FSSAI licence no. (14 digits)', { maxlength: 14, inputmode: 'numeric' }],
      ['biz_state', 'State (for CGST/SGST vs IGST)', { select: true }], ['biz_phone', 'Phone', {}], ['biz_email', 'Email', { type: 'email' }],
      ['biz_address', 'Registered address', { textarea: true, full: true }], ['invoice_prefix', 'Invoice prefix', { maxlength: 8 }], ['hsn_code', 'HSN code', { inputmode: 'numeric' }],
      ['gst_pct', 'GST rate (%) — prices include GST', { type: 'number', step: '0.1' }], ['invoice_note', 'Invoice footer note', { full: true }],
    ]],
    ['Costs (for the Profit page)', 'Only you see these. Leave at 0 to skip profit estimates.', [
      ['cogs_per_unit', 'Cost per 1 kg jar (₹)', { type: 'number', step: '0.01' }], ['packaging_per_order', 'Packaging per order (₹)', { type: 'number', step: '0.01' }],
      ['courier_per_order', 'Average courier cost per order (₹)', { type: 'number', step: '0.01' }], ['fixed_costs_monthly', 'Fixed monthly costs (₹)', { type: 'number', step: '1' }],
      ['gateway_fee_pct', 'Payment gateway fee (%)', { type: 'number', step: '0.01' }], ['gateway_gst_pct', 'GST on gateway fee (%)', { type: 'number', step: '0.1' }],
    ]],
    ['Goals', 'Shown as a progress bar on the dashboard.', [['target_monthly_revenue', 'Monthly revenue goal (₹)', { type: 'number', step: '1' }]]],
  ];

  A.register('settings', {
    title: 'Settings',
    init(el) {
      const inputs = {};
      const form = h('form', { onsubmit: async e => {
        e.preventDefault();
        const body = {};
        for (const [k, i] of Object.entries(inputs)) body[k] = i.value;
        await A.guard(async () => { await A.post('/api/admin/settings', body); A.toast('Settings saved'); });
      } });
      for (const [title, hint, fields] of GROUPS) {
        const grid = h('div', { class: 'form-grid' });
        for (const [key, label, opts] of fields) {
          const { select, textarea, full, ...attrs } = opts;
          const f = A.field(label, { tag: select ? 'select' : textarea ? 'textarea' : 'input', attrs: { name: key, ...attrs, ...(textarea ? { rows: '2', maxlength: '240' } : {}) }, options: select ? [h('option', { value: '', text: 'Select state' }), ...(A.state.me.states || []).map(s => h('option', { value: s, text: s }))] : undefined }, { full });
          inputs[key] = f.input;
          grid.append(f.el);
        }
        form.append(h('div', { class: 'card' }, h('h3', { text: title }), h('p', { class: 'muted small', text: hint }), grid));
      }
      form.append(h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save settings' })));
      el.append(form, h('div', { class: 'card' }, h('h3', { text: 'Backups' }),
        h('p', { class: 'muted', text: 'Orders, customers and stock live in one file: data/orders.db. Run  npm run backup  to save a timestamped copy to the backups/ folder (also git-ignored). Schedule it daily and copy the folder somewhere safe — it contains customer addresses.' })));
      A.views.settings._inputs = inputs;
    },
    async load() {
      const { settings } = await A.api('/api/admin/settings');
      for (const [k, i] of Object.entries(A.views.settings._inputs)) i.value = settings[k] ?? '';
    },
  });

  // ── Audit log ──────────────────────────────────
  A.register('audit', {
    title: 'Audit log',
    init(el) {
      el.append(h('p', { class: 'muted', text: 'Every sign-in, export, order change, refund, coupon and stock edit is recorded here and cannot be edited from the portal.' }),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'au-table' }), h('div', { class: 'pager', id: 'au-pager' })));
    },
    async load() {
      const d = await A.api(`/api/admin/audit?page=${A.state.pages.audit || 1}&pageSize=50`);
      const tone = a => (a.startsWith('login.failed') || a === 'login.locked' ? 'critical' : a.includes('refund') ? 'serious' : a.startsWith('export') || a.startsWith('invoice') ? 'warning' : 'info');
      A.mount('au-table', A.table([
        { title: 'When', render: a => fmtDate(a.at) }, { title: 'Who', render: a => a.actor },
        { title: 'Action', render: a => h('span', { class: `badge badge-${tone(a.action)}`, text: a.action }) },
        { title: 'Order', render: a => (a.order_id ? h('a', { href: '#', class: 'mono', text: a.order_id, onclick: e => { e.preventDefault(); A.openOrder(a.order_id); } }) : '—') },
        { title: 'Details', wrap: true, render: a => a.detail || '' }, { title: 'IP', render: a => h('span', { class: 'mono', text: a.ip || '' }) },
      ], d.rows));
      A.pager('au-pager', d, 'audit', () => A.views.audit.load());
    },
  });
})();
