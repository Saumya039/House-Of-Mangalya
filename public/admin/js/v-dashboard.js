/* Dashboard: today, goal & forecast, action center, KPIs, charts, breakdowns */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, inr, num, pct } = A;
  const $ = A.$;

  let redraw = null;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hourName = hr => `${((hr + 11) % 12) + 1} ${hr < 12 ? 'AM' : 'PM'}`;

  const LEVEL = { critical: ['critical', '● Urgent'], warning: ['warning', '▲ Attention'], info: ['info', 'ℹ Info'] };

  function init(el) {
    const card = (title, ...body) => h('div', { class: 'card' }, h('h3', { text: title }), ...body);
    el.append(
      h('div', { class: 'grid-3', id: 'd-strip' }),
      h('div', { class: 'card', id: 'd-alerts-card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Needs your attention' })), h('div', { id: 'd-alerts' })),
      h('p', { class: 'range-label muted', id: 'd-range-label' }),
      h('div', { class: 'tiles', id: 'd-tiles' }),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', { text: 'Revenue by day' }), h('span', { class: 'muted', id: 'd-revenue-total' })),
          h('div', { class: 'chart', id: 'd-chart-revenue' }),
          h('details', { class: 'table-toggle' }, h('summary', { text: 'Show as table' }), h('div', { id: 'd-table-revenue' }))),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', { text: 'Orders by day' }),
            h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'swatch swatch-1' }), 'Checkouts started'), h('span', {}, h('i', { class: 'swatch swatch-2' }), 'Paid'))),
          h('div', { class: 'chart', id: 'd-chart-orders' }))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Fulfilment queue' }), h('a', { href: '#fulfilment', class: 'link', text: 'Open queue →' })),
        h('div', { class: 'tiles tiles-compact', id: 'd-queue' })),
      h('div', { class: 'grid-3' },
        card('Payment status', h('div', { id: 'd-status' })), card('Payment methods', h('div', { id: 'd-methods' })),
        card('Delivery choice', h('div', { id: 'd-shipping' })), card('Top states', h('div', { id: 'd-states' })),
        card('Top cities', h('div', { id: 'd-cities' })), card('Products', h('div', { id: 'd-products' }))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'When customers buy' }), h('span', { class: 'muted', id: 'd-peak-day' })), h('div', { class: 'chart chart-short', id: 'd-chart-weekday' })),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Hour of day (IST)' }), h('span', { class: 'muted', id: 'd-peak-hour' })), h('div', { class: 'chart chart-short', id: 'd-chart-hours' }))),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Top customers' }), h('a', { href: '#customers', class: 'link', text: 'All →' })), h('div', { id: 'd-top-customers' })),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Recent orders' }), h('a', { href: '#orders', class: 'link', text: 'All orders →' })), h('div', { id: 'd-recent' }))));
  }

  function renderStrip(ov, a) {
    const t = ov.today;
    const y = ov.yesterday;
    const f = a.forecast;
    const dlt = A.delta(t.revenuePaise, y.revenuePaise);
    const goal = f.goalPaise
      ? [A.progress(f.goalProgress || 0, 'Progress to monthly goal'), h('p', { class: 'muted small', text: `${pct(f.goalProgress || 0, 0)} of ${inr(f.goalPaise, true)} goal · day ${f.dayOfMonth}/${f.daysInMonth}` })]
      : [h('p', { class: 'muted small' }, 'Set a monthly goal in ', h('a', { href: '#settings', text: 'Settings' }), ' to track progress.')];
    A.mount('d-strip',
      h('div', { class: 'card strip-card' }, h('div', { class: 'tile-label', text: 'Today so far' }),
        h('div', { class: 'tile-value', text: inr(t.revenuePaise) }),
        h('div', { class: 'tile-sub' }, dlt ? h('span', { class: `delta ${dlt.up ? 'delta-up' : 'delta-down'}`, text: dlt.text + ' ' }) : null, `${num(t.paid)} paid · ${num(t.orders)} checkouts · yesterday ${inr(y.revenuePaise)}`)),
      h('div', { class: 'card strip-card' }, h('div', { class: 'tile-label', text: 'This month' }),
        h('div', { class: 'tile-value', text: inr(f.monthToDatePaise) }),
        ...goal, h('p', { class: 'muted small', text: `On track for about ${inr(f.monthProjectedPaise, true)} (estimate from the last 14 days)` })),
      h('div', { class: 'card strip-card' }, h('div', { class: 'tile-label', text: 'Daily run-rate' }),
        h('div', { class: 'tile-value', text: inr(Math.round(f.runRatePaise / 100) * 100) + ' / day' }),
        h('div', { class: 'tile-sub', text: `≈ ${inr(f.projected30Paise, true)} over the next 30 days at this pace` }),
        h('p', { class: 'muted small', text: 'Average of the last 14 complete days. A projection, not a promise.' })));
  }

  function renderAlerts(ov) {
    if (!ov.alerts.length) return A.mount('d-alerts', h('p', { class: 'ok-note', text: '✓ Nothing needs attention right now.' }));
    A.mount('d-alerts', h('ul', { class: 'alerts' }, ov.alerts.map(al => h('li', { class: `alert alert-${al.level}` },
      A.pill(...LEVEL[al.level]),
      h('div', { class: 'alert-text' }, h('strong', { text: al.title }), h('span', { class: 'muted', text: al.detail })),
      al.link ? h('a', { class: 'btn btn-ghost btn-sm', href: al.link, text: 'Open →' }) : null))));
  }

  async function load() {
    const [a, ov, recent] = await Promise.all([
      A.api(`/api/admin/analytics?${A.rangeQuery()}`),
      A.api('/api/admin/overview'),
      A.api('/api/admin/orders?pageSize=8'),
    ]);
    const s = a.summary;
    const p = a.previous;
    $('d-range-label').textContent = `${A.dayLabel(a.range.from)} – ${A.dayLabel(a.range.to)} (${a.range.days} day${a.range.days > 1 ? 's' : ''}, IST) · changes vs ${A.dayLabel(a.previousRange.from)} – ${A.dayLabel(a.previousRange.to)}`;

    renderStrip(ov, a);
    renderAlerts(ov);

    const daily = a.daily;
    A.mount('d-tiles',
      A.tile('Net revenue', inr(s.netPaise), `${inr(s.grossPaise)} gross · ${inr(s.refundedPaise)} refunded`, A.delta(s.netPaise, p.netPaise), { spark: daily.map(d => d.revenuePaise) }),
      A.tile('Paid orders', num(s.paid), `${num(s.failed)} failed payments`, A.delta(s.paid, p.paid), { href: '#orders', spark: daily.map(d => d.paid) }),
      A.tile('Avg. order value', inr(s.aovPaise), `${num(s.unitsSold)} jars sold`, A.delta(s.aovPaise, p.aovPaise)),
      A.tile('Checkout conversion', pct(s.conversion), `${num(s.paid)} of ${num(s.ordersAll)} checkouts`, A.delta(s.conversion, p.conversion, { points: true })),
      A.tile('Customers', num(s.customers), `${num(s.repeatCustomers)} ordered more than once`, A.delta(s.customers, p.customers), { href: '#customers' }),
      A.tile('Abandoned checkouts', num(s.abandoned), `${inr(s.abandonedPaise)} left unpaid`, null, { href: '#recover' }),
      A.tile('Discounts given', inr(a.discounts.discountPaise), `${num(a.discounts.couponOrders)} orders used a coupon`, null, { href: '#coupons' }),
      A.tile('New subscribers', num(s.newSubscribers), `${num(s.totalSubscribers)} total`, A.delta(s.newSubscribers, p.newSubscribers), { href: '#subscribers' }));

    let buckets = daily.map(d => ({ ...d, label: A.dayLabel(d.day), title: A.dayLabel(d.day) }));
    if (daily.length > 92) {
      buckets = [];
      for (let i = 0; i < daily.length; i += 7) {
        const c = daily.slice(i, i + 7);
        buckets.push({ label: A.dayLabel(c[0].day), title: `Week of ${A.dayLabel(c[0].day)}`, revenuePaise: c.reduce((n, d) => n + d.revenuePaise, 0), paid: c.reduce((n, d) => n + d.paid, 0), orders: c.reduce((n, d) => n + d.orders, 0) });
      }
    }
    $('d-revenue-total').textContent = `${inr(s.grossPaise)} from ${num(s.paid)} paid orders`;
    A.mount('d-table-revenue', h('div', { class: 'table-wrap scroll-y' }, A.table(
      [{ title: 'Period', render: b => b.title }, { title: 'Checkouts', num: true, render: b => num(b.orders) }, { title: 'Paid', num: true, render: b => num(b.paid) }, { title: 'Revenue', num: true, render: b => inr(b.revenuePaise) }],
      buckets.slice().reverse())));

    const best = a.weekdays.reduce((bi, w, i, arr) => (w.orders > arr[bi].orders ? i : bi), 0);
    $('d-peak-day').textContent = a.weekdays[best].orders ? `Best day: ${WEEKDAYS[best]}` : '';
    const peak = a.hours.indexOf(Math.max(...a.hours));
    $('d-peak-hour').textContent = Math.max(...a.hours) ? `Peak: ${hourName(peak)}–${hourName((peak + 1) % 24)}` : '';

    redraw = () => {
      A.barChart($('d-chart-revenue'), buckets.map(b => ({ label: b.label, value: b.revenuePaise, tipTitle: b.title, tipRows: [['Revenue', inr(b.revenuePaise)], ['Paid orders', num(b.paid)]] })), v => inr(v, true), 'Revenue per day');
      A.lineChart($('d-chart-orders'), buckets.map(b => b.label),
        [{ name: 'Checkouts', values: buckets.map(b => b.orders), cls: 1 }, { name: 'Paid', values: buckets.map(b => b.paid), cls: 2 }],
        buckets.map(b => b.title), 'Checkouts started and paid orders per day');
      A.barChart($('d-chart-weekday'), a.weekdays.map((w, i) => ({ label: WEEKDAYS[i], value: w.orders, tipTitle: WEEKDAYS[i], tipRows: [['Paid orders', num(w.orders)], ['Revenue', inr(w.revenuePaise)]] })), v => num(Math.round(v)), 'Paid orders by weekday');
      A.barChart($('d-chart-hours'), a.hours.map((n, hr) => ({ label: hr % 3 === 0 ? hourName(hr).replace(' ', '') : '', value: n, tipTitle: `${hourName(hr)} – ${hourName((hr + 1) % 24)}`, tipRows: [['Paid orders', num(n)]] })), v => num(Math.round(v)), 'Paid orders by hour of day');
    };
    redraw();

    const q = a.fulfillmentQueue;
    A.mount('d-queue', ...Object.entries(A.FULFIL).filter(([k]) => k !== 'refunded').map(([k, [, label]]) =>
      A.tile(label, num(q[k] || 0), k === 'unfulfilled' ? 'need packing' : k === 'packed' ? 'ready to hand over' : '', null, { href: k === 'unfulfilled' || k === 'packed' ? '#fulfilment' : undefined })));

    const order = ['paid', 'pending', 'authorized', 'abandoned', 'failed', 'refunded'];
    A.barList('d-status', a.statusBreakdown.slice().sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k)), {
      value: r => r.n, fmt: r => `${num(r.n)} · ${inr(r.valuePaise, true)}`, labelNode: r => h('span', {}, A.badge(A.PAYMENT, r.k)),
    });
    const methodNames = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', mock: 'Test gateway' };
    A.barList('d-methods', a.paymentMethods, { label: r => methodNames[r.k] || r.k, fmt: r => `${num(r.n)} · ${inr(r.revenuePaise, true)}` });
    A.barList('d-shipping', a.shippingMethods, { value: r => r.n, fmt: r => `${num(r.n)} orders` });
    A.barList('d-states', a.states, { fmt: r => `${inr(r.revenuePaise, true)} · ${num(r.n)}` });
    A.barList('d-cities', a.cities, { fmt: r => `${inr(r.revenuePaise, true)} · ${num(r.n)}` });
    A.barList('d-products', a.products, { label: r => r.name, fmt: r => `${num(r.units)} units · ${inr(r.revenuePaise, true)}` });

    A.mount('d-top-customers', A.table([
      { title: 'Customer', render: c => h('span', {}, c.name, h('span', { class: 'sub', text: c.email })) },
      { title: 'Orders', num: true, render: c => num(c.orders) },
      { title: 'Spend', num: true, render: c => inr(c.spendPaise) },
    ], a.topCustomers.slice(0, 5), { empty: 'No paid orders in this range' }));
    A.mount('d-recent', h('div', { class: 'table-wrap' }, A.ordersTable(recent.orders, { compact: true })));
  }

  A.register('dashboard', { title: 'Dashboard', range: true, init, load, redraw: () => redraw && redraw() });
})();
