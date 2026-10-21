/* Customers (segments, lifetime value) and Retention (cohorts) */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, inr, num, pct, fmtDate } = A;
  const $ = A.$;

  const TAGS = [['all', 'All'], ['vip', '★ VIP'], ['repeat', '↻ Repeat'], ['new', '✦ New (30d)'], ['lapsed', '⏾ Lapsed (60d+)']];
  const TAG_LOOK = { vip: ['good', '★ VIP'], repeat: ['info', '↻ Repeat'], new: ['info', '✦ New'], lapsed: ['warning', '⏾ Lapsed'] };
  let tag = 'all';

  A.register('customers', {
    title: 'Customers',
    init(el) {
      let timer;
      const search = h('input', { type: 'search', id: 'cu-q', placeholder: 'Search name, email, phone or city…', 'aria-label': 'Search customers', maxlength: '80' });
      const sort = h('select', { id: 'cu-sort', 'aria-label': 'Sort customers' },
        [['ltv', 'Highest spend'], ['orders', 'Most orders'], ['last', 'Most recent'], ['name', 'Name A–Z']].map(([v, t]) => h('option', { value: v, text: t })));
      const reload = () => { A.state.pages.customers = 1; A.views.customers.load().catch(e => A.showError(e.message)); };
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(reload, 300); });
      sort.addEventListener('change', reload);
      el.append(
        h('p', { class: 'muted', text: 'Everyone who has paid for an order. Segments are automatic: VIP = 3+ orders or ₹3,000+ spent; Lapsed = no order in 60+ days — your best win-back list.' }),
        h('div', { class: 'tiles tiles-compact', id: 'cu-tiles' }),
        h('div', { class: 'filters' }, search, sort,
          h('button', { class: 'btn btn-ghost', type: 'button', text: '⬇ Export CSV', onclick: () => { location.href = '/api/admin/export/customers.csv'; } })),
        h('div', { class: 'chips', id: 'cu-chips', role: 'group', 'aria-label': 'Segment' }),
        h('div', { class: 'card card-flush' }, h('div', { class: 'table-wrap', id: 'cu-table' }), h('div', { class: 'pager', id: 'cu-pager' })));
    },
    async load() {
      const p = new URLSearchParams({ tag, sort: $('cu-sort').value, page: A.state.pages.customers || 1, pageSize: 25 });
      if ($('cu-q').value.trim()) p.set('q', $('cu-q').value.trim());
      const d = await A.api('/api/admin/customers?' + p);
      A.mount('cu-tiles',
        A.tile('Customers', num(d.counts.all), 'have paid at least once'),
        A.tile('Repeat rate', pct(d.repeatRate), `${num(d.counts.repeat)} bought 2+ times`, null, { hint: 'Healthy consumable brands aim for 25%+ repeat within 90 days' }),
        A.tile('VIPs', num(d.counts.vip), '3+ orders or ₹3,000+'),
        A.tile('New (30 days)', num(d.counts.new), 'first order recently'),
        A.tile('Lapsed', num(d.counts.lapsed), 'win them back'));
      A.mount('cu-chips', ...TAGS.map(([k, label]) => h('button', {
        class: 'chip' + (k === tag ? ' active' : ''), type: 'button', 'aria-pressed': String(k === tag),
        text: `${label} ${num(d.counts[k])}`, onclick: () => { tag = k; A.state.pages.customers = 1; A.views.customers.load(); },
      })));
      A.mount('cu-table', A.table([
        { title: 'Customer', render: c => h('span', {}, c.name, h('span', { class: 'sub', text: c.email })) },
        { title: 'Segments', render: c => h('span', { class: 'badges' }, c.tags.map(t => A.pill(...TAG_LOOK[t]))) },
        { title: 'Location', render: c => `${c.city}, ${c.state}` },
        { title: 'Orders', num: true, render: c => num(c.orders) },
        { title: 'Net spend', num: true, render: c => inr(c.ltvPaise) },
        { title: 'Avg order', num: true, render: c => inr(c.aovPaise) },
        { title: 'Last order', render: c => h('span', {}, `${c.daysSinceLast === 0 ? 'today' : c.daysSinceLast + 'd ago'}`, h('span', { class: 'sub', text: fmtDate(c.lastOrder) })) },
        {
          title: '', render: c => h('span', { class: 'row-actions' },
            h('a', { class: 'btn btn-ghost btn-sm', target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp', href: `https://wa.me/${A.digits(c.phone)}?text=${encodeURIComponent(`Hi ${String(c.name).split(' ')[0]}, thank you for choosing House of Mangalya 🌿`)}` }),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Orders', onclick: () => { A.views.orders.setSearch(c.email); location.hash = '#orders'; } })),
        },
      ], d.customers, { empty: 'No customers match.' }));
      A.pager('cu-pager', d, 'customers', () => A.views.customers.load());
    },
  });

  A.register('retention', {
    title: 'Retention',
    init(el) {
      el.append(
        h('p', { class: 'muted', text: 'Of the customers who first bought in a given month (rows), what share bought again in the same month and in each month after? Darker = more customers came back. Repeat buyers are your cheapest revenue — most Indian D2C brands see 10–30% repeat; 25%+ within 90 days is a healthy sign for a consumable.' }),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Monthly cohorts' })), h('div', { class: 'table-wrap', id: 'rt-table' })),
        h('div', { class: 'card' }, h('h3', { text: 'How to read this' }),
          h('ul', { class: 'plain' },
            h('li', { text: 'Month 0 is always 100% — it is the month they first bought.' }),
            h('li', { text: '+1 is the share who bought again the very next month. For a 1 kg jar that lasts months, expect lower numbers than for a monthly-use product — consider a 250 g size or a subscription.' }),
            h('li', { text: 'Grey cells are months that have not happened yet.' }))));
    },
    async load() {
      const d = await A.api('/api/admin/cohorts');
      A.mount('rt-table', d.rows.length ? A.heatTable(d.rows, d.offsets) : h('p', { class: 'empty', text: 'Cohorts appear once you have paid orders.' }));
    },
  });
})();
