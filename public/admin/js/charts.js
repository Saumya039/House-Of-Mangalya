/* ================================================
   HOUSE OF MANGALYA — Admin charts (plain SVG)
   One y-axis, thin marks, rounded bar ends on the
   baseline, hover crosshair + tooltip, data table
   fallbacks. Colours come from CSS tokens so light
   and dark both validate.
   ================================================ */
(() => {
  'use strict';
  const A = window.Admin;
  const { h } = A;

  /** Smallest axis max whose 4 gridline steps are round numbers. */
  function niceMax(v) {
    if (v <= 4) return 4;
    const raw = v / 4;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= raw) return m * p * 4;
    return 40 * p;
  }

  function frame(container, maxValue, fmtTick, labels, rightPad = 12) {
    const W = Math.max(container.clientWidth, 260);
    const H = container.clientHeight || 200;
    const m = { top: 10, right: rightPad, bottom: 24, left: 52 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const ymax = niceMax(maxValue);
    const svg = h('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    for (let i = 0; i <= 4; i++) {
      const val = (ymax / 4) * i;
      const y = m.top + ih - (val / ymax) * ih;
      svg.append(h('svg:line', { class: i === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: y, y2: y }));
      svg.append(h('svg:text', { class: 'tick', x: m.left - 8, y: y + 4, 'text-anchor': 'end', text: fmtTick(val) }));
    }
    const n = labels.length;
    const step = iw / Math.max(n, 1);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
    labels.forEach((lab, i) => {
      if (!lab) return;
      if (i % every !== 0 && i !== n - 1) return;
      if (i !== n - 1 && n - 1 - i < every / 2 && i % every === 0 && i !== 0) return;
      svg.append(h('svg:text', { class: 'tick', x: m.left + step * i + step / 2, y: H - 6, 'text-anchor': 'middle', text: lab }));
    });
    return { svg, W, H, m, iw, ih, ymax, step, y: v => m.top + ih - (v / ymax) * ih };
  }

  const empty = (container, msg = 'No data in this range') => container.replaceChildren(h('div', { class: 'chart-empty', text: msg }));

  /** Single-series bars. data: [{label, value, tipTitle, tipRows}] */
  A.barChart = (container, data, fmtTick, ariaLabel) => {
    container.replaceChildren();
    if (!data.length || data.every(d => !d.value)) return empty(container);
    const f = frame(container, Math.max(...data.map(d => d.value)), fmtTick, data.map(d => d.label));
    f.svg.setAttribute('aria-label', ariaLabel);
    const bw = Math.max(2, Math.min(f.step * 0.68, 36));
    const bars = data.map((d, i) => {
      const x = f.m.left + f.step * i + (f.step - bw) / 2;
      const y = f.y(d.value);
      const base = f.m.top + f.ih;
      const hgt = base - y;
      if (hgt <= 0) return null;
      const r = Math.min(4, bw / 2, hgt);
      const bar = h('svg:path', { class: 'bar', d: `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z` });
      f.svg.append(bar);
      return bar;
    });
    data.forEach((d, i) => {
      const hit = h('svg:rect', { class: 'hit', x: f.m.left + f.step * i, y: f.m.top, width: f.step, height: f.ih });
      hit.addEventListener('mousemove', e => {
        bars.forEach((b, j) => b && b.classList.toggle('dim', j !== i));
        A.showTip(e, d.tipTitle, d.tipRows);
      });
      hit.addEventListener('mouseleave', () => { bars.forEach(b => b && b.classList.remove('dim')); A.hideTip(); });
      f.svg.append(hit);
    });
    container.append(f.svg);
  };

  /** Up to two series with a hover crosshair. series: [{name, values, cls: 1|2}] */
  A.lineChart = (container, labels, series, tipTitles, ariaLabel) => {
    container.replaceChildren();
    const all = series.flatMap(s => s.values);
    if (!labels.length || all.every(v => !v)) return empty(container);
    const f = frame(container, Math.max(...all), v => A.num(Math.round(v)), labels, 78);
    f.svg.setAttribute('aria-label', ariaLabel);
    const xAt = i => f.m.left + f.step * i + f.step / 2;
    for (const s of series) {
      f.svg.append(h('svg:path', { class: `line-${s.cls}`, d: s.values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${f.y(v).toFixed(1)}`).join(' ') }));
    }
    const ends = series.map(s => ({ s, y: f.y(s.values[s.values.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) f.svg.append(h('svg:text', { class: 'direct-label', x: xAt(labels.length - 1) + 8, y: e.y + 4, text: e.s.name }));
    const cross = h('svg:line', { class: 'crosshair', y1: f.m.top, y2: f.m.top + f.ih, visibility: 'hidden' });
    const dots = series.map(s => h('svg:circle', { class: `dot-${s.cls}`, r: 4.5, visibility: 'hidden' }));
    f.svg.append(cross, ...dots);
    const hit = h('svg:rect', { class: 'hit', x: f.m.left, y: f.m.top, width: f.iw, height: f.ih });
    hit.addEventListener('mousemove', e => {
      const rect = f.svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (f.W / rect.width);
      const i = Math.min(labels.length - 1, Math.max(0, Math.floor((px - f.m.left) / f.step)));
      const x = xAt(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      series.forEach((s, k) => { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', f.y(s.values[i])); dots[k].setAttribute('visibility', 'visible'); });
      A.showTip(e, tipTitles[i], series.map(s => [s.name, A.num(s.values[i])]));
    });
    hit.addEventListener('mouseleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(d => d.setAttribute('visibility', 'hidden'));
      A.hideTip();
    });
    f.svg.append(hit);
    container.append(f.svg);
  };

  /** Tiny trend line for KPI tiles (decorative; the number carries the meaning). */
  A.sparkline = values => {
    const w = 120;
    const hgt = 28;
    const max = Math.max(...values, 1);
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(hgt - 3 - (v / max) * (hgt - 6)).toFixed(1)}`).join(' ');
    return h('svg:svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true', preserveAspectRatio: 'none' },
      h('svg:path', { class: 'spark-line', d }));
  };

  /** Progress bar (goal tracking). ratio 0..1+ */
  A.progress = (ratio, label) => {
    const fill = h('div', { class: 'progress-fill' });
    fill.style.width = Math.min(100, Math.max(0, ratio * 100)) + '%';
    return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-label': label }, fill);
  };

  /** Cohort heatmap table: single hue, intensity = value. */
  A.heatTable = (rows, offsets) => {
    const cell = (pct, count) => {
      const td = h('td', { class: 'heat-cell', title: pct === null ? '' : `${count} customer${count === 1 ? '' : 's'}` });
      if (pct === null) { td.textContent = ''; td.classList.add('heat-empty'); return td; }
      td.textContent = A.pct(pct, 0);
      td.style.setProperty('--heat', String(Math.max(0.06, Math.min(1, pct))));
      if (pct > 0.55) td.classList.add('heat-strong');
      return td;
    };
    return h('table', { class: 'heat' },
      h('thead', {}, h('tr', {}, h('th', { text: 'First order' }), h('th', { class: 'num', text: 'Customers' }), offsets.map(o => h('th', { class: 'num', text: o === 0 ? 'Month 0' : `+${o}` })))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('td', { text: r.month }), h('td', { class: 'num', text: A.num(r.size) }), r.pct.map((p, i) => cell(p, r.retained[i]))))));
  };
})();
