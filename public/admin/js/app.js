/* ================================================
   HOUSE OF MANGALYA — Admin app shell
   Boot, sign-in, router, date range, theme,
   command palette (Ctrl/⌘+K), live order alerts.
   ================================================ */
(() => {
  'use strict';
  const A = window.Admin;
  const { h, $ } = A;
  const S = A.state;

  // ── Sign-in / out ──────────────────────────────
  function showLogin(msg) {
    S.me = null;
    $('app-view').hidden = true;
    A.closeDrawer?.();
    $('login-view').hidden = false;
    const err = $('login-error');
    err.textContent = msg || '';
    err.hidden = !msg;
    $('login-pass').value = '';
    $('login-code').value = '';
    // Ask whether two-factor is required so the code box only appears when it is
    fetch('/api/admin/login-info', { credentials: 'same-origin' }).then(r => r.json()).then(i => { $('login-code-row').hidden = !i.twoFactor; }).catch(() => {});
    ($('login-user').value ? $('login-pass') : $('login-user')).focus();
  }
  A.onSignedOut = showLogin;

  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await A.api('/api/admin/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value, code: $('login-code').value } });
      $('login-pass').value = '';
      $('login-code').value = '';
      await boot();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
  $('logout-btn').addEventListener('click', async () => {
    await A.api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin('Signed out.');
  });

  // ── Theme ──────────────────────────────────────
  const THEMES = ['auto', 'light', 'dark'];
  const ICON = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  let theme = 'auto';
  try { theme = THEMES.includes(localStorage.getItem('hom_admin_theme')) ? localStorage.getItem('hom_admin_theme') : 'auto'; } catch { /* storage blocked */ }
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('theme-btn').textContent = ICON[theme];
    A.views[S.view]?.redraw?.();
  }
  $('theme-btn').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('hom_admin_theme', theme); } catch { /* ignore */ }
    applyTheme();
  });
  applyTheme();

  // ── Date range ─────────────────────────────────
  function loadRangePref() {
    try {
      const saved = JSON.parse(localStorage.getItem('hom_admin_range') || 'null');
      if (saved && typeof saved === 'object') S.range = { days: Number(saved.days) || 0, from: saved.from || '', to: saved.to || '' };
    } catch { /* ignore */ }
  }
  const saveRangePref = () => { try { localStorage.setItem('hom_admin_range', JSON.stringify(S.range)); } catch { /* ignore */ } };
  function syncRangeUi() {
    const r = A.currentRange();
    $('range-from').value = r.from;
    $('range-to').value = r.to;
    $('range-from').max = $('range-to').max = S.me.today;
    document.querySelectorAll('#range-picker > button').forEach(b => {
      const on = Number(b.dataset.days) === S.range.days;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  document.querySelectorAll('#range-picker > button').forEach(b => b.addEventListener('click', () => {
    S.range = { days: Number(b.dataset.days), from: '', to: '' };
    saveRangePref(); syncRangeUi(); A.refresh();
  }));
  for (const id of ['range-from', 'range-to']) {
    $(id).addEventListener('change', () => {
      if (!$('range-from').value || !$('range-to').value) return;
      S.range = { days: 0, from: $('range-from').value, to: $('range-to').value };
      saveRangePref(); syncRangeUi(); A.refresh();
    });
  }
  $('refresh-btn').addEventListener('click', () => A.refresh());

  // ── Router ─────────────────────────────────────
  function buildViews() {
    const host = $('views');
    host.replaceChildren(...Object.keys(A.views).map(name => h('section', { class: 'view', id: `view-${name}`, hidden: true })));
  }

  function route() {
    const wanted = location.hash.slice(1);
    S.view = Object.hasOwn(A.views, wanted) ? wanted : 'dashboard';
    const def = A.views[S.view];
    A.closeDrawer?.();
    $('view-title').textContent = def.title;
    document.title = `${def.title} · Mangalya Admin`;
    document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.view === S.view));
    document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== `view-${S.view}`; });
    $('range-picker').hidden = !def.range;
    $('sidebar').classList.remove('open');
    if (!def._inited) { def.init($(`view-${S.view}`)); def._inited = true; }
    A.refresh();
  }
  window.addEventListener('hashchange', route);
  $('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  A.refresh = () => {
    A.showError('');
    const def = A.views[S.view];
    def.load().catch(err => { if (err.message !== 'Signed out') A.showError(err.message); });
    pollOverview(false);
  };

  // ── Live badges + new-order alerts ─────────────
  let lastPaid = null;
  async function pollOverview(announce = true) {
    if (!S.me) return;
    try {
      const ov = await A.api('/api/admin/overview');
      const ship = $('nav-toship');
      ship.textContent = ov.toShip;
      ship.hidden = !ov.toShip;
      const crit = ov.alerts.filter(a => a.level === 'critical').length;
      const dash = $('nav-alerts');
      dash.textContent = crit;
      dash.hidden = !crit;
      document.title = `${ov.toShip ? `(${ov.toShip}) ` : ''}${A.views[S.view].title} · Mangalya Admin`;
      if (announce && lastPaid !== null && ov.today.paid > lastPaid) {
        A.toast(`🎉 New paid order! Today: ${A.inr(ov.today.revenuePaise)} from ${ov.today.paid} orders`);
        if (!$('order-drawer').hidden || document.activeElement?.matches('input,textarea,select')) { /* don't disrupt editing */ } else A.views[S.view].load?.().catch(() => {});
      }
      lastPaid = ov.today.paid;
    } catch { /* offline or signed out — handled by api() */ }
  }
  setInterval(() => { if (document.visibilityState === 'visible') pollOverview(true); }, 45_000);

  window.addEventListener('resize', (() => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(() => A.views[S.view]?.redraw?.(), 150); };
  })());

  // ── Command palette ────────────────────────────
  const PAGES = [
    ['dashboard', 'Dashboard'], ['orders', 'Orders'], ['fulfilment', 'To ship'], ['recover', 'Recover sales'], ['customers', 'Customers'],
    ['retention', 'Retention cohorts'], ['marketing', 'Marketing & attribution'], ['coupons', 'Coupons'], ['profit', 'Profit & unit economics'],
    ['inventory', 'Inventory'], ['payments', 'Payment events'], ['subscribers', 'Subscribers'], ['settings', 'Settings'], ['audit', 'Audit log'],
  ];
  let paletteEl = null;
  function closePalette() { paletteEl?.remove(); paletteEl = null; }
  function openPalette() {
    if (paletteEl || !S.me) return;
    let items = [];
    let sel = 0;
    const input = h('input', { type: 'search', placeholder: 'Jump to a page, order number, customer, email…', 'aria-label': 'Search everything', autocomplete: 'off' });
    const list = h('ul', { class: 'palette-list', role: 'listbox' });
    const run = it => { closePalette(); it.go(); };
    const draw = () => {
      list.replaceChildren(...items.map((it, i) => h('li', { role: 'option', class: i === sel ? 'sel' : null, 'aria-selected': String(i === sel), onclick: () => run(it) },
        h('span', { class: 'pl-kind', text: it.kind }), h('span', { class: 'pl-label' }, it.label, it.sub ? h('span', { class: 'sub', text: it.sub }) : null))));
      if (!items.length) list.replaceChildren(h('li', { class: 'empty', text: 'No matches' }));
    };
    const pages = q => PAGES.filter(([, t]) => t.toLowerCase().includes(q.toLowerCase())).map(([k, t]) => ({ kind: 'Page', label: t, go: () => { location.hash = '#' + k; } }));
    let timer;
    const search = async () => {
      const q = input.value.trim();
      items = pages(q);
      sel = 0; draw();
      if (q.length < 2) return;
      try {
        const r = await A.api('/api/admin/search?q=' + encodeURIComponent(q));
        if (input.value.trim() !== q) return;
        items = [
          ...r.orders.map(o => ({ kind: 'Order', label: o.id, sub: `${o.name} · ${A.inr(o.totalPaise)} · ${o.status}`, go: () => A.openOrder(o.id) })),
          ...r.customers.map(c => ({ kind: 'Customer', label: c.name, sub: `${c.email} · ${c.orders} orders`, go: () => { A.views.orders.setSearch?.(c.email); location.hash = '#orders'; } })),
          ...pages(q)];
        sel = 0; draw();
      } catch { /* ignore */ }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePalette();
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
    });
    paletteEl = h('div', { class: 'modal-overlay palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search', onclick: e => { if (e.target === paletteEl) closePalette(); } },
      h('div', { class: 'modal palette-box' }, input, list, h('p', { class: 'muted small', text: '↑↓ to move · Enter to open · Esc to close' })));
    document.body.append(paletteEl);
    items = pages('');
    draw();
    input.focus();
  }
  $('search-btn').addEventListener('click', openPalette);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteEl ? closePalette() : openPalette(); }
    else if (e.key === '/' && !document.activeElement?.matches('input,textarea,select') && S.me) { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape' && !$('order-drawer').hidden && !paletteEl) A.closeDrawer();
  });

  // ── Boot ───────────────────────────────────────
  async function boot() {
    try {
      S.me = await A.api('/api/admin/me');
    } catch {
      return showLogin();
    }
    S.csrf = S.me.csrf;
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who').textContent = `(${S.me.user})`;
    $('test-badge').hidden = !S.me.testMode;
    $('store-link').href = S.me.storeOrigin;
    loadRangePref();
    syncRangeUi();
    if (!$('views').childElementCount) buildViews();
    route();
  }

  // /me answers 401 when signed out; probe directly so the “session expired” message doesn't flash on first load
  fetch('/api/admin/me', { credentials: 'same-origin' }).then(r => (r.ok ? boot() : showLogin()), () => showLogin('Cannot reach the server.'));
})();
