/* ================================================
   HOUSE OF MANGALYA — Admin core
   Shared helpers, API client, tables, toasts, router hooks.
   All DOM is built with textContent (never innerHTML), so
   customer-entered text can't inject markup.
   ================================================ */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const A = (window.Admin = {
    $,
    state: { me: null, csrf: '', view: 'dashboard', range: { days: 30, from: '', to: '' }, pages: {}, openOrderId: null },
    views: {},
    register(name, def) { A.views[name] = def; },
  });

  // ── DOM builder ────────────────────────────────
  function h(tag, props, ...children) {
    const el = tag.startsWith('svg:')
      ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4))
      : document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  A.h = h;
  A.mount = (target, ...nodes) => (typeof target === 'string' ? $(target) : target).replaceChildren(...nodes);

  // ── Formatting ─────────────────────────────────
  A.inr = (paise, compact) => {
    const v = (paise || 0) / 100;
    const r = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    if (compact && r >= 1e7) return sign + '₹' + (r / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + 'Cr';
    if (compact && r >= 1e5) return sign + '₹' + (r / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 }) + 'L';
    if (compact && r >= 1e3) return sign + '₹' + (r / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 }) + 'k';
    // Paise only where they matter: small amounts with a fractional part
    const decimals = r < 10000 && r % 1 ? 2 : 0;
    return sign + '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };
  A.num = x => (x || 0).toLocaleString('en-IN');
  A.pct = (x, d = 1) => ((x || 0) * 100).toLocaleString('en-IN', { maximumFractionDigits: d }) + '%';
  const dtf = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  A.fmtDate = iso => (iso ? dtf.format(new Date(iso)) : '—');
  A.dayLabel = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  A.addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  A.titleCase = s => String(s || '').replace(/(^|[\s-])\w/g, c => c.toUpperCase());
  A.ago = iso => {
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m / 60)}h ago`;
    return `${Math.floor(m / 1440)}d ago`;
  };
  A.digits = s => String(s || '').replace(/\D/g, '');

  // ── Status badges (colour + icon + label, never colour alone) ──
  A.PAYMENT = {
    paid: ['good', '✓ Paid'], pending: ['info', '◷ Pending'], authorized: ['warning', '◐ Authorized'],
    abandoned: ['neutral', '⊘ Abandoned'], failed: ['critical', '✕ Failed'], refunded: ['serious', '↺ Refunded'],
  };
  A.FULFIL = {
    unfulfilled: ['warning', '○ Unfulfilled'], packed: ['info', '▣ Packed'], shipped: ['info', '➜ Shipped'],
    delivered: ['good', '✓ Delivered'], cancelled: ['neutral', '⊘ Cancelled'], refunded: ['serious', '↺ Refunded'],
  };
  A.badge = (map, key) => {
    const [tone, label] = map[key] || ['neutral', A.titleCase(key || 'unknown')];
    return h('span', { class: `badge badge-${tone}`, text: label });
  };
  A.pill = (tone, text) => h('span', { class: `badge badge-${tone}`, text });

  // ── Feedback ───────────────────────────────────
  let toastTimer;
  A.toast = msg => {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
  };
  A.showError = msg => {
    const b = $('global-error');
    b.textContent = msg || '';
    b.hidden = !msg;
  };

  // ── API ────────────────────────────────────────
  A.api = async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = A.state.csrf;
    }
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/login')) {
      A.onSignedOut?.('Your session has expired. Please sign in again.');
      throw new Error('Signed out');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };
  A.post = (path, body) => A.api(path, { method: 'POST', body: body || {} });
  /** Run an async action; toast the error instead of throwing. */
  A.guard = async fn => {
    try { return await fn(); } catch (e) {
      if (e.message !== 'Signed out') A.toast('⚠ ' + e.message);
      return undefined;
    }
  };

  // ── Date range ─────────────────────────────────
  A.currentRange = () => {
    const today = A.state.me.today;
    const r = A.state.range;
    if (r.days) return { from: A.addDays(today, -(r.days - 1)), to: today };
    return { from: r.from || A.addDays(today, -29), to: r.to || today };
  };
  A.rangeQuery = () => {
    const r = A.currentRange();
    return `from=${r.from}&to=${r.to}`;
  };

  // ── Building blocks ────────────────────────────
  A.table = (columns, rows, { onRow, empty = 'Nothing here yet', rowClass } = {}) => {
    if (!rows.length) return h('p', { class: 'empty', text: empty });
    return h('table', {},
      h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.num ? 'num' : null, text: c.title })))),
      h('tbody', {}, rows.map(r => {
        const tr = h('tr', { class: [onRow && 'clickable', rowClass?.(r)].filter(Boolean).join(' ') || null, tabindex: onRow ? '0' : null },
          columns.map(c => h('td', { class: [c.num && 'num', c.wrap && 'wrap'].filter(Boolean).join(' ') || null }, c.render(r))));
        if (onRow) {
          tr.addEventListener('click', e => { if (!e.target.closest('a,button,input,label')) onRow(r); });
          tr.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('a,button,input')) onRow(r); });
        }
        return tr;
      })));
  };

  A.pager = (target, data, key, reload) => {
    if (data.pages <= 1) return A.mount(target);
    const go = p => { A.state.pages[key] = p; reload(); };
    A.mount(target,
      h('span', { text: `Page ${data.page} of ${data.pages} · ${A.num(data.total)} total` }),
      h('div', {},
        h('button', { class: 'btn btn-ghost', disabled: data.page <= 1, onclick: () => go(data.page - 1), text: '← Prev' }),
        h('button', { class: 'btn btn-ghost', disabled: data.page >= data.pages, onclick: () => go(data.page + 1), text: 'Next →' })));
  };

  A.barList = (target, rows, { label = r => r.k, value = r => r.revenuePaise, fmt = r => A.inr(r.revenuePaise), labelNode } = {}) => {
    if (!rows.length) return A.mount(target, h('p', { class: 'empty', text: 'No data in this range' }));
    const max = Math.max(...rows.map(value), 1);
    A.mount(target, h('div', { class: 'barlist' }, rows.map(r => {
      const fill = h('div', { class: 'barlist-fill' });
      fill.style.width = Math.max(2, (value(r) / max) * 100) + '%';
      return h('div', { class: 'barlist-row' },
        labelNode ? labelNode(r) : h('span', { class: 'barlist-label', text: label(r), title: label(r) }),
        h('span', { class: 'barlist-value', text: fmt(r) }),
        h('div', { class: 'barlist-track' }, fill));
    })));
  };

  A.kv = pairs => h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v ?? '—')]));

  A.copyBtn = text => h('button', {
    class: 'copy', type: 'button', text: 'Copy',
    onclick: async e => {
      try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Failed'; }
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    },
  });

  /** KPI tile. delta: {text, up} | null. spark: array of numbers. */
  A.tile = (label, value, sub, dlt, { href, spark, hint } = {}) => h(href ? 'a' : 'div', { class: 'tile', href, title: hint },
    h('div', { class: 'tile-label', text: label }),
    h('div', { class: 'tile-value', text: value }),
    h('div', { class: 'tile-sub' },
      dlt ? h('span', { class: `delta ${dlt.up ? 'delta-up' : 'delta-down'}`, text: dlt.text + ' ' }) : null, sub || ''),
    spark ? A.sparkline(spark) : null);

  A.delta = (cur, prev, { points } = {}) => {
    if (points) {
      const d = (cur - prev) * 100;
      if (!prev && !cur) return null;
      return { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts`, up: d >= 0 };
    }
    if (!prev) return cur ? { text: '▲ new', up: true } : null;
    const d = (cur - prev) / prev;
    return { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}%`, up: d >= 0 };
  };

  /** Form field helper: returns {el, input}. */
  A.field = (label, props = {}, { full = false, hint } = {}) => {
    const id = 'f-' + Math.random().toString(36).slice(2, 8);
    const input = props.tag === 'select'
      ? h('select', { id, ...props.attrs }, props.options || [])
      : h(props.tag || 'input', { id, ...props.attrs });
    return { input, el: h('div', { class: full ? 'full' : null }, h('label', { for: id, text: label }), input, hint ? h('small', { class: 'muted', text: hint }) : null) };
  };

  // ── Tooltip ────────────────────────────────────
  const tip = $('tooltip');
  A.showTip = (evt, title, rows) => {
    tip.replaceChildren(h('strong', { text: title }), ...rows.map(([k, v]) => h('div', { class: 'row' }, h('span', { text: k }), h('span', { text: v }))));
    tip.hidden = false;
    const pad = 14;
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    let x = evt.clientX + pad;
    let y = evt.clientY - hgt - pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y < 8) y = evt.clientY + pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  A.hideTip = () => { tip.hidden = true; };

  // ── Confirm dialog (replaces window.confirm) ───
  A.confirm = (title, message, okLabel = 'Confirm') => new Promise(resolve => {
    const done = v => { overlay.remove(); resolve(v); };
    const ok = h('button', { class: 'btn btn-primary', type: 'button', text: okLabel, onclick: () => done(true) });
    const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true', onclick: e => { if (e.target === overlay) done(false); } },
      h('div', { class: 'modal' }, h('h3', { text: title }), h('p', { text: message }),
        h('div', { class: 'actions' }, ok, h('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: () => done(false) }))));
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
    document.body.append(overlay);
    ok.focus();
  });
})();
