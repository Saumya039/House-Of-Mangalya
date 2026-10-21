/* Printable GST invoices and packing slips. Built with textContent only. */
(() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const type = q.get('type') === 'slip' ? 'slip' : 'invoice';
  const ids = (q.get('ids') || '').split(',').filter(Boolean).slice(0, 40);
  const $ = id => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const inr = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = iso => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

  // Indian-system amount in words
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const below100 = n => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''));
  const below1000 = n => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + below100(n % 100) : '') : below100(n));
  function words(paise) {
    let r = Math.floor(paise / 100);
    const ps = paise % 100;
    if (r === 0 && ps === 0) return 'Zero Rupees Only';
    const parts = [];
    for (const [div, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
      if (r >= div) { parts.push(below1000(Math.floor(r / div)) + ' ' + name); r %= div; }
    }
    if (r > 0) parts.push(below1000(r));
    return `${parts.join(' ')} Rupees${ps ? ' and ' + below100(ps) + ' Paise' : ''} Only`;
  }

  function party(title, lines) {
    return h('div', { class: 'party' }, h('h4', { text: title }), lines.filter(Boolean).map(l => h('div', { text: l })));
  }

  function invoice(d) {
    const s = d.seller;
    const b = d.buyer;
    const half = d.gstPct / 2;
    const rows = d.lines.map((l, i) => {
      const rate = Math.round((l.unitPaise * 100) / (100 + d.gstPct));
      return h('tr', {}, h('td', { text: String(i + 1) }), h('td', { text: l.name }), h('td', { text: d.hsn }), h('td', { class: 'n', text: String(l.qty) }),
        h('td', { class: 'n', text: inr(rate) }), h('td', { class: 'n', text: l.discountPaise ? '−' + inr(Math.round((l.discountPaise * 100) / (100 + d.gstPct))) : '—' }),
        h('td', { class: 'n', text: inr(l.taxablePaise) }), h('td', { class: 'n', text: `${d.gstPct}%` }), h('td', { class: 'n', text: inr(l.taxPaise) }), h('td', { class: 'n', text: inr(l.payablePaise) }));
    });
    const taxRows = d.intraState
      ? [['CGST @ ' + half + '%', d.cgstPaise], ['SGST @ ' + half + '%', d.sgstPaise]]
      : [['IGST @ ' + d.gstPct + '%', d.igstPaise]];
    return h('section', { class: 'doc' },
      h('header', { class: 'doc-head' },
        h('div', {}, h('h1', { text: s.name || 'Your business name' }), h('div', { class: 'muted', text: s.address || 'Add your address in Settings' }),
          s.gstin ? h('div', { text: `GSTIN: ${s.gstin}` }) : h('div', { class: 'warn', text: 'GSTIN not set' }), s.fssai ? h('div', { text: `FSSAI Lic. No.: ${s.fssai}` }) : null,
          [s.phone, s.email].filter(Boolean).join(' · ') ? h('div', { class: 'muted', text: [s.phone, s.email].filter(Boolean).join(' · ') }) : null),
        h('div', { class: 'title-box' }, h('h2', { text: 'TAX INVOICE' }),
          h('div', {}, 'Invoice no: ', h('strong', { text: d.invoiceNumber })), h('div', { text: `Date: ${date(d.invoiceDate)}` }), h('div', { text: `Order: ${d.order.id}` }))),
      h('div', { class: 'parties' },
        party('Bill to / Ship to', [b.name, b.address1, b.address2, `${b.city}, ${b.state} ${b.pincode}`, `Phone: ${b.phone}`, `Email: ${b.email}`]),
        party('Supply details', [`Place of supply: ${b.state}`, `Payment: ${d.order.paymentMethod ? d.order.paymentMethod.toUpperCase() : 'Online'} (paid)`, d.order.paymentId ? `Ref: ${d.order.paymentId}` : null, `Delivery: ${d.order.shippingMethod}`, d.order.couponCode ? `Coupon: ${d.order.couponCode}` : null])),
      h('table', { class: 'lines' },
        h('thead', {}, h('tr', {}, ['#', 'Description', 'HSN', 'Qty', 'Rate (ex-GST)', 'Discount', 'Taxable value', 'GST', 'GST amt', 'Total'].map((t, i) => h('th', { class: i > 2 ? 'n' : '', text: t })))),
        h('tbody', {}, rows)),
      h('div', { class: 'totals' },
        h('table', {},
          h('tr', {}, h('td', { text: 'Taxable value' }), h('td', { class: 'n', text: inr(d.taxablePaise) })),
          taxRows.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'n', text: inr(v) }))),
          h('tr', { class: 'grand' }, h('td', { text: 'Invoice total' }), h('td', { class: 'n', text: inr(d.totalPaise) })))),
      h('p', { class: 'words' }, h('strong', { text: 'Amount in words: ' }), words(d.totalPaise)),
      h('p', { class: 'muted small', text: `Prices include GST. ${d.note || ''}`.trim() }),
      h('footer', { class: 'doc-foot' }, h('div', { class: 'muted small', text: 'This is a computer-generated invoice and does not require a signature.' }), h('div', { class: 'sign' }, 'For ', h('strong', { text: s.name || 'the seller' }))));
  }

  function slip(d) {
    const b = d.buyer;
    return h('section', { class: 'doc slip' },
      h('header', { class: 'doc-head' },
        h('div', {}, h('h1', { text: 'PACKING SLIP' }), h('div', { class: 'muted', text: `Invoice ${d.invoiceNumber}` })),
        h('div', { class: 'title-box' }, h('div', { class: 'big', text: d.order.id }), h('div', { text: date(d.invoiceDate) }))),
      h('div', { class: 'shipto' }, h('h4', { text: 'SHIP TO' }), h('div', { class: 'big', text: b.name }), h('div', { text: b.address1 }), b.address2 ? h('div', { text: b.address2 }) : null,
        h('div', { text: `${b.city}, ${b.state} — ${b.pincode}` }), h('div', { class: 'big', text: `☎ ${b.phone}` })),
      h('div', { class: 'parties' },
        party('Delivery', [d.order.shippingMethod === 'express' ? 'EXPRESS (2–3 days)' : 'Standard (5–7 days)', d.order.courier ? `Courier: ${d.order.courier}` : 'Courier: —', d.order.trackingNumber ? `AWB: ${d.order.trackingNumber}` : 'AWB: —']),
        party('From', [d.seller.name, d.seller.address, d.seller.phone])),
      h('table', { class: 'lines' }, h('thead', {}, h('tr', {}, h('th', { text: 'Item' }), h('th', { class: 'n', text: 'Qty' }), h('th', { text: 'Packed ✓' }))),
        h('tbody', {}, d.lines.filter(l => !l.name.startsWith('Delivery')).map(l => h('tr', {}, h('td', { text: l.name }), h('td', { class: 'n big', text: String(l.qty) }), h('td', { text: '☐' }))))),
      d.order.note ? h('p', { class: 'note-box' }, h('strong', { text: 'Note: ' }), d.order.note) : null,
      h('p', { class: 'center', text: 'Thank you for choosing pure, stone-ground turmeric 🌿' }));
  }

  async function main() {
    $('print-btn').addEventListener('click', () => window.print());
    if (!ids.length) { $('status').textContent = 'No orders selected.'; return; }
    try {
      const res = await fetch('/api/admin/invoices?ids=' + ids.map(encodeURIComponent).join(','), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { $('status').textContent = 'Please sign in to the admin portal first, then reopen this page.'; return; }
      if (!res.ok) { $('status').textContent = data.error || 'Could not load documents.'; return; }
      const docs = data.documents;
      $('docs').replaceChildren(...docs.map(type === 'slip' ? slip : invoice));
      $('status').textContent = `${docs.length} ${type === 'slip' ? 'packing slip' : 'invoice'}${docs.length > 1 ? 's' : ''} ready`;
      document.title = type === 'slip' ? 'Packing slips' : 'Invoices';
      const missing = type === 'invoice' && docs.some(d => !d.seller.gstin || !d.seller.name);
      const refunded = docs.some(d => d.isRefunded);
      const msgs = [missing && 'Business name / GSTIN missing — add them in Settings before sending invoices to customers.', refunded && 'Includes a refunded order — a credit note is needed for refunded invoices (confirm with your CA).'].filter(Boolean);
      if (msgs.length) { $('notice').textContent = msgs.join('  '); $('notice').hidden = false; }
    } catch {
      $('status').textContent = 'Could not reach the server.';
    }
  }
  main();
})();
