/* Growth: marketing & attribution, coupons, profit & unit economics */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, inr, num, pct, fmtDate } = A;
  const $ = A.$;
  const todayStr = () => A.state.me.today;

  // ── Marketing ──────────────────────────────────
  A.register('marketing', {
    title: 'Marketing',
    range: true,
    init(el) {
      const day = h('input', { type: 'date', id: 'mk-day', required: true });
      const channel = h('input', { id: 'mk-channel', placeholder: 'instagram, google, facebook…', maxlength: '30', required: true, list: 'mk-channels' });
      const amount = h('input', { id: 'mk-amount', type: 'number', min: '1', step: '1', placeholder: 'Amount ₹', required: true });
      const note = h('input', { id: 'mk-note', placeholder: 'Note (optional)', maxlength: '120' });
      const form = h('form', { class: 'inline-form', onsubmit: async e => {
        e.preventDefault();
        await A.guard(async () => {
          await A.post('/api/admin/ad-spend', { day: day.value, channel: channel.value, amount: amount.value, note: note.value });
          amount.value = ''; note.value = '';
          A.toast('Spend added');
          A.views.marketing.load();
        });
      } },
      h('label', { class: 'sr-only', for: 'mk-day', text: 'Date' }), day, channel, h('datalist', { id: 'mk-channels' }, ['instagram', 'google', 'facebook', 'youtube', 'whatsapp', 'influencer'].map(v => h('option', { value: v }))),
      amount, note, h('button', { class: 'btn btn-primary', type: 'submit', text: '+ Add spend' }));

      const builder = (() => {
        const src = h('input', { id: 'ub-source', placeholder: 'source e.g. instagram', value: 'instagram' });
        const med = h('input', { id: 'ub-medium', placeholder: 'medium e.g. paid', value: 'paid' });
        const camp = h('input', { id: 'ub-campaign', placeholder: 'campaign e.g. diwali', value: 'diwali' });
        const out = h('code', { class: 'url-out', id: 'ub-out' });
        const upd = () => {
          const u = new URL('/product.html', A.state.me.storeOrigin);
          const clean = v => v.trim().toLowerCase().replace(/[^a-z0-9_. -]/g, '').slice(0, 40);
          if (clean(src.value)) u.searchParams.set('utm_source', clean(src.value));
          if (clean(med.value)) u.searchParams.set('utm_medium', clean(med.value));
          if (clean(camp.value)) u.searchParams.set('utm_campaign', clean(camp.value));
          out.textContent = u.href;
        };
        [src, med, camp].forEach(i => i.addEventListener('input', upd));
        setTimeout(upd, 0);
        return h('div', { class: 'card' }, h('h3', { text: 'Tag your links' }),
          h('p', { class: 'muted', text: 'Put a tagged link in every Instagram bio/ad, WhatsApp broadcast and email. The store remembers where each customer came from, so this page can show which channel really makes money.' }),
          h('div', { class: 'form-grid three' }, src, med, camp), h('div', { class: 'url-row' }, out, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(out.textContent); A.toast('Link copied'); } catch { A.toast('Copy failed'); } } })));
      })();

      el.append(
        h('div', { class: 'tiles tiles-compact', id: 'mk-tiles' }),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Where orders come from' }), h('span', { class: 'muted', text: 'Revenue = paid orders' })), h('div', { class: 'table-wrap', id: 'mk-sources' })),
        h('div', { class: 'grid-2' },
          h('div', { class: 'card' }, h('h3', { text: 'Campaigns' }), h('div', { class: 'table-wrap', id: 'mk-campaigns' })),
          builder),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Ad spend log' }), h('span', { class: 'muted', text: 'Enter what you spend so CAC and ROAS are real' })), form,
          h('div', { class: 'table-wrap', id: 'mk-spend' })));
      day.value = todayStr();
    },
    async load() {
      const d = await A.api(`/api/admin/marketing?${A.rangeQuery()}`);
      const t = d.totals;
      A.mount('mk-tiles',
        A.tile('Ad spend', inr(t.spendPaise), 'in this range'),
        A.tile('New customers', num(t.newCustomers), 'first-time buyers'),
        A.tile('Cost to acquire (CAC)', t.cacPaise === null ? '—' : inr(t.cacPaise), t.cacPaise === null ? 'add spend below' : 'spend ÷ new customers', null, { hint: 'Compare with break-even CAC on the Profit page' }),
        A.tile('Return on ad spend', t.roas === null ? '—' : t.roas.toFixed(1) + '×', t.roas === null ? 'add spend below' : '₹ revenue per ₹1 spent'),
        A.tile('Revenue (all sources)', inr(t.revenuePaise), 'paid orders'));
      const names = { direct: 'Direct / typed', unknown: 'Earlier orders (untracked)' };
      A.mount('mk-sources', A.table([
        { title: 'Source', render: s => names[s.source] || A.titleCase(s.source) },
        { title: 'Checkouts', num: true, render: s => num(s.checkouts) },
        { title: 'Paid', num: true, render: s => num(s.paid) },
        { title: 'Conversion', num: true, render: s => pct(s.conversion) },
        { title: 'Revenue', num: true, render: s => inr(s.revenuePaise) },
        { title: 'Spend', num: true, render: s => (s.spendPaise ? inr(s.spendPaise) : '—') },
        { title: 'ROAS', num: true, render: s => (s.roas === null ? '—' : s.roas.toFixed(1) + '×') },
      ], d.sources, { empty: 'No orders in this range yet.' }));
      A.mount('mk-campaigns', A.table([
        { title: 'Campaign', render: c => c.campaign }, { title: 'Source', render: c => c.source },
        { title: 'Paid', num: true, render: c => num(c.paid) }, { title: 'Revenue', num: true, render: c => inr(c.revenuePaise) },
      ], d.campaigns, { empty: 'Tag a link with utm_campaign to see campaigns here.' }));
      A.mount('mk-spend', A.table([
        { title: 'Date', render: s => A.dayLabel(s.day) }, { title: 'Channel', render: s => A.titleCase(s.channel) },
        { title: 'Amount', num: true, render: s => inr(s.amount_paise) }, { title: 'Note', render: s => s.note || '' },
        { title: '', render: s => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Delete', onclick: async () => {
          if (!(await A.confirm('Delete this entry?', `${A.titleCase(s.channel)} · ${inr(s.amount_paise)} on ${A.dayLabel(s.day)}`, 'Delete'))) return;
          await A.guard(async () => { await A.post(`/api/admin/ad-spend/${s.id}/delete`); A.views.marketing.load(); });
        } }) },
      ], d.spend, { empty: 'No spend logged yet.' }));
    },
  });

  // ── Coupons ────────────────────────────────────
  A.register('coupons', {
    title: 'Coupons',
    init(el) {
      const f = {};
      const mk = (key, label, attrs, opts) => { f[key] = A.field(label, { attrs: { name: key, ...attrs }, ...opts }); return f[key]; };
      const kind = A.field('Type', { tag: 'select', attrs: { name: 'kind' }, options: [h('option', { value: 'percent', text: 'Percent off' }), h('option', { value: 'flat', text: 'Flat ₹ off' })] });
      const form = h('form', { class: 'card', onsubmit: async e => {
        e.preventDefault();
        const body = { kind: kind.input.value };
        for (const k of Object.keys(f)) body[k] = f[k].input.value;
        await A.guard(async () => {
          await A.post('/api/admin/coupons', body);
          A.toast(`Coupon ${body.code.toUpperCase()} created`);
          form.reset();
          A.views.coupons.load();
        });
      } },
      h('h3', { text: 'New coupon' }),
      h('div', { class: 'form-grid three' },
        mk('code', 'Code', { maxlength: '20', required: true, placeholder: 'DIWALI25', autocomplete: 'off' }).el,
        kind.el,
        mk('value', 'Value (% or ₹)', { type: 'number', min: '1', step: '1', required: true }).el,
        mk('minSubtotal', 'Minimum order (₹)', { type: 'number', min: '0', step: '1', placeholder: 'none' }).el,
        mk('maxDiscount', 'Max discount (₹)', { type: 'number', min: '1', step: '1', placeholder: 'no cap' }).el,
        mk('usageLimit', 'Total uses', { type: 'number', min: '1', step: '1', placeholder: 'unlimited' }).el,
        mk('perCustomerLimit', 'Uses per customer', { type: 'number', min: '1', step: '1', placeholder: 'unlimited' }).el,
        mk('startsAt', 'Starts', { type: 'date' }).el,
        mk('expiresAt', 'Ends', { type: 'date' }).el,
        mk('description', 'Note to self', { maxlength: '120' }, { full: true }).el),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit', text: 'Create coupon' })));
      el.append(h('p', { class: 'muted', text: 'Customers enter these at checkout. The discount comes off before the free-shipping check (so ₹999 is judged after the coupon). A coupon counts as “used” only when the payment succeeds.' }),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'cp-table' })), form);
    },
    async load() {
      const d = await A.api('/api/admin/coupons');
      A.mount('cp-table', A.table([
        { title: 'Code', render: c => h('span', {}, h('span', { class: 'mono strong', text: c.code }), c.description ? h('span', { class: 'sub', text: c.description }) : null) },
        { title: 'Offer', render: c => h('span', {}, c.kind === 'percent' ? `${c.value}% off` : `${inr(c.value)} off`, h('span', { class: 'sub', text: [c.minSubtotalPaise ? `min ${inr(c.minSubtotalPaise)}` : null, c.maxDiscountPaise ? `max ${inr(c.maxDiscountPaise)}` : null].filter(Boolean).join(' · ') || 'no limits' })) },
        { title: 'Used', num: true, render: c => `${num(c.used)}${c.usageLimit ? ' / ' + num(c.usageLimit) : ''}` },
        { title: 'Discount given', num: true, render: c => inr(c.discountGivenPaise) },
        { title: 'Valid', render: c => (c.startsAt || c.expiresAt ? `${c.startsAt ? fmtDate(c.startsAt).split(',')[0] : 'now'} → ${c.expiresAt ? fmtDate(c.expiresAt).split(',')[0] : 'no end'}` : 'always') },
        { title: 'Status', render: c => (c.expired ? A.pill('neutral', '⊘ Expired') : c.active ? A.pill('good', '✓ Active') : A.pill('neutral', '⏸ Paused')) },
        { title: '', render: c => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: c.active ? 'Pause' : 'Resume', onclick: () => A.guard(async () => { await A.post(`/api/admin/coupons/${c.code}/active`, { active: !c.active }); A.views.coupons.load(); }) }) },
      ], d.coupons, { empty: 'No coupons yet.' }));
    },
  });

  // ── Profit & unit economics ────────────────────
  A.register('profit', {
    title: 'Profit',
    range: true,
    init(el) {
      el.append(
        h('div', { class: 'banner banner-warn', id: 'pf-setup', hidden: true },
          'Add your cost per jar, courier and packaging in ', h('a', { href: '#settings', text: 'Settings' }), ' to see real profit. Until then these numbers are revenue-only.'),
        h('div', { class: 'tiles tiles-compact', id: 'pf-tiles' }),
        h('div', { class: 'grid-2' },
          h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Where each rupee goes' }), h('span', { class: 'muted', text: 'estimate' })), h('div', { id: 'pf-waterfall' })),
          h('div', { class: 'card' }, h('h3', { text: 'Per order' }), h('div', { id: 'pf-perorder' }))),
        h('p', { class: 'muted small', text: 'Estimate based on the costs you entered. GST is shown at the rate in Settings (packaged turmeric is commonly 5% — confirm with your CA). Gateway fee is not refunded when an order is refunded; courier cost is incurred on returns too. This is a management view, not an accounting statement.' }));
    },
    async load() {
      const e = await A.api(`/api/admin/economics?${A.rangeQuery()}`);
      $('pf-setup').hidden = e.configured;
      A.mount('pf-tiles',
        A.tile('Revenue (ex-GST)', inr(e.revenueExTaxPaise), `${inr(e.grossPaise)} collected − ${inr(e.refundedPaise)} refunds − GST`),
        A.tile('Contribution', inr(e.contributionPaise), `${pct(e.contributionMargin)} margin after product, packing, courier & gateway`),
        A.tile('Estimated profit', inr(e.profitPaise), `after ${inr(e.spendPaise)} ads and ${inr(e.fixedPaise)} fixed costs`, null, { hint: 'Contribution − ad spend − fixed costs (pro-rated)' }),
        A.tile('Break-even CAC', e.breakEvenCacPaise === null ? '—' : inr(e.breakEvenCacPaise), 'max you can pay per new customer'),
        A.tile('Orders kept', num(e.keptOrders), `${num(e.orders)} paid · ${num(e.units)} jars`));

      const rows = [
        ['Collected from customers', e.grossPaise, 'base'], ['Refunded', -e.refundedPaise, 'cost'], ['GST to pay', -e.gstPaise, 'cost'],
        ['Product cost (COGS)', -e.cogsPaise, 'cost'], ['Packaging', -e.packagingPaise, 'cost'], ['Courier', -e.courierPaise, 'cost'], ['Payment gateway fees', -e.gatewayPaise, 'cost'],
        ['Contribution', e.contributionPaise, 'sub'], ['Advertising', -e.spendPaise, 'cost'], ['Fixed costs', -e.fixedPaise, 'cost'], ['Estimated profit', e.profitPaise, 'total'],
      ];
      const max = Math.max(...rows.map(r => Math.abs(r[1])), 1);
      A.mount('pf-waterfall', h('div', { class: 'waterfall' }, rows.map(([label, v, kind]) => {
        const fill = h('div', { class: `wf-fill wf-${kind}${v < 0 && kind === 'total' ? ' wf-neg' : ''}` });
        fill.style.width = Math.max(1, (Math.abs(v) / max) * 100) + '%';
        return h('div', { class: `wf-row wf-row-${kind}` }, h('span', { class: 'wf-label', text: label }), h('div', { class: 'wf-track' }, fill), h('span', { class: 'wf-value', text: (v < 0 ? '−' : '') + inr(Math.abs(v)) }));
      })));
      A.mount('pf-perorder', e.perOrder ? A.kv([
        ['Revenue (ex-GST)', inr(e.perOrder.revenueExTaxPaise)], ['Contribution', inr(e.perOrder.contributionPaise)],
        ['Break-even CAC', inr(e.breakEvenCacPaise)], ['Jars per order', (e.units / e.keptOrders).toFixed(2)],
      ]) : h('p', { class: 'empty', text: 'No orders in this range.' }));
    },
  });
})();
