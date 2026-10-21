# House of Mangalya 🌿

> **Pure. Sacred. Powerful. — Rooted in Heritage. Backed by Science.**

Welcome to the official website repository for **House of Mangalya**, a luxury direct-to-consumer wellness brand specializing in pure, single-origin turmeric with 5.5% high-curcumin strength, cold stone-ground and organic certified.

---

## ✦ Brand Story & Founders

- **Rudra Palande** — *Founder & Business Head*  
  Hailing from Kokan, Ratnagiri, where his family has nurtured ancestral turmeric farming traditions for generations. Cybersecurity scholar at Symbiosis Skills and Professional University.
  
- **Saumya Shah** — *Co-Founder & Operations Head*  
  Cybersecurity scholar at Symbiosis Skills and Professional University, leading digital traceability, quality compliance, and end-to-end supply chain logistics.

---

## ✦ Website Architecture & Pages

The site is built with a responsive luxury editorial design system:

| Page | File | Description |
|---|---|---|
| **Homepage** | [`index.html`](public/index.html) | Hero with dynamic gold particles, rotating taglines, brand promise, story, product spotlight, testimonials, and journal previews. |
| **Product Page** | [`product.html`](public/product.html) | Interactive product showcase, stone-ground matka packaging, benefits, dosage guide, lab certifications, and full cart functionality. |
| **Our Story** | [`about.html`](public/about.html) | Kokan roots, supply chain journey, founder & co-founder profiles, lab testing principles, and farm-direct sourcing values. |
| **Journal** | [`blog.html`](public/blog.html) | 8 SEO-optimized editorial guides spanning recipes (golden milk), Ayurvedic rituals, curcumin absorption science, and haldi skincare. |
| **Checkout** | [`checkout.html`](public/checkout.html) | Secure checkout: contact & address form, delivery options, server-priced summary, Razorpay payment. |
| **Track order · Policies** | [`track.html`](public/track.html), [`shipping-returns.html`](public/shipping-returns.html), [`privacy.html`](public/privacy.html), [`terms.html`](public/terms.html) | Customer order tracking and the legal pages. |
| **FAQ & Policies** | [`faq.html`](public/faq.html) | Interactive categorized accordion addressing quality, lab reports, shipping, returns, and B2B/bulk orders. |

---

## ✦ Tech Stack & Features

- **Frontend:** Semantic HTML5, CSS3 Custom Properties (Variables), Vanilla Modern JavaScript (ES6+).
- **Design System:** Palette of Golden Turmeric (`#C8963E`), Terracotta Earth (`#8B4A2B`), Cream (`#FAF5E9`), and Deep Soil Brown (`#2C1A0E`).
- **Cart & Checkout:** `localStorage` cart (ids + quantities only) with drawer UI, and a secure server-verified Razorpay checkout (`checkout.html`).
- **Animations:** IntersectionObserver scroll reveals, animated number counters, hero canvas particle simulation.
- **Responsive:** Mobile-first responsive layouts with custom hamburger navigation.

---

## ✦ Checkout & Payments

Checkout is a custom flow (our own page, form, order records and backend) on top of **Razorpay**, a licensed, PCI-DSS Level 1 payment gateway. Customers enter card/UPI details only inside Razorpay's secure window, so **no payment data ever reaches our server** — we are out of PCI card-data scope.

```
Browser                       Our server (server/)                 Razorpay
  │ items {id, qty} + address ─▶ validate, price from catalog ──────▶ create order
  │ ◀──────────── order_id ───┤  store order (status: created)
  │ ── pays in Razorpay popup ─────────────────────────────────────▶
  │ ── payment_id + signature ▶ verify HMAC-SHA256 (constant-time)
  │                           │ re-fetch payment: status + amount ─▶
  │ ◀──── confirmation ───────┤  mark paid
  │                           ◀──── signed webhook (backup path) ───┘
```

**Security controls**

| Threat | Control |
|---|---|
| Price tampering | Browser sends only product id + qty; server prices from `server/catalog.js` |
| Forged "payment success" | HMAC signature check **and** server-to-server re-fetch of payment status/amount |
| Webhook spoofing / replay | Signature over raw body; event ids stored, duplicates ignored |
| Paid order downgraded | Status transitions guarded in SQL — `paid` is terminal |
| XSS | Strict CSP (no inline scripts), cart rendered with `textContent`, input allow-lists |
| CSRF / clickjacking | Origin + `Sec-Fetch-Site` checks, JSON-only API, `frame-ancestors 'none'` |
| Abuse / DoS | Per-IP rate limits, 16 KB body cap, request timeouts |
| Path traversal | Static files served only from `public/`, dotfiles and unknown types blocked |
| SQL injection | Parameterised queries only |
| Secret leaks | Secrets only in `.env` (git-ignored); logs contain no PII or signatures |
| Supply chain | **Zero npm dependencies** — Node built-ins only |
| Misconfiguration | Server refuses to start in production with mock payments, http origin or no webhook secret |

## ✦ Running Locally

Requires **Node.js 22.13+** (no `npm install` needed — there are no dependencies).

```bash
git clone https://github.com/Saumya039/House-Of-Mangalya.git
cd House-Of-Mangalya
cp .env.example .env
npm start
```

Open http://localhost:3000. With no Razorpay keys the site runs in **mock payment mode** — a test popup lets you simulate success/decline. To use the real Razorpay test checkout, add your `rzp_test_` keys to `.env`.

```bash
npm test     # security, checkout and admin test suite
```

## ✦ Admin Portal

A private back office on its **own port** (default `http://localhost:3001`), bound to `127.0.0.1` so it is never reachable from the internet unless you deliberately configure it.

```bash
npm run admin:password      # set the admin password (only an scrypt hash is stored in .env)
npm start                   # store on :3000, admin on :3001
npm run seed:demo           # optional: load DEMO- orders to explore the dashboard
npm run seed:demo -- --clear
npm run backup              # timestamped snapshot of the database into backups/
npm test                    # 30 security & business-logic tests
```

Press **Ctrl/⌘ + K** anywhere to jump to a page, order or customer.

| Area | What you get |
|---|---|
| **Dashboard** | Today vs yesterday, month-to-date vs your revenue goal, run-rate forecast, **action center** (orders waiting >48 h, low/out of stock, failed payments, missing webhooks…), 8 KPI tiles with trends vs the previous period, revenue/orders charts, best weekday & hour, payment status/methods, top states/cities/products/customers |
| **Orders** | Search by order #, name, email, phone, payment ID, tracking; filters; CSV export; **bulk** mark-packed, print invoices, print packing slips |
| **Order detail** | Items, discount, address (copy), payment & gateway IDs, traffic source, timeline, webhook history, audit trail; fulfilment with courier + tracking; internal notes; **WhatsApp / email** the customer with a ready message; **GST invoice** and **packing slip**; gateway status check; full or partial **refund** (type the order number to confirm) |
| **To ship** | Queue of paid orders awaiting packing/shipping |
| **Recover sales** | Abandoned and failed checkouts with one-click WhatsApp/email follow-up |
| **Customers** | Everyone who paid, with lifetime value, repeat rate and automatic segments (VIP, Repeat, New, Lapsed); CSV export |
| **Retention** | Monthly cohort heatmap: how many first-time buyers come back |
| **Marketing** | Revenue, conversion and ROAS by traffic source (UTM-tagged links), campaign table, ad-spend log → real **CAC**; link builder |
| **Coupons** | Percent/flat codes with minimum order, cap, dates, total and per-customer limits; usage and discount cost |
| **Profit** | Revenue ex-GST → COGS, packaging, courier, gateway fees → contribution → ads & fixed costs → profit; per-order economics and break-even CAC |
| **Inventory** | Live stock (store shows “Only N left” / blocks overselling), receive stock, count, low-stock alerts, movement history |
| **Payment events · Subscribers · Audit log · Settings** | Signed webhooks with outcome, newsletter list, who-did-what log, business/GST/cost settings |

**Security** — scrypt password hash; 256-bit session tokens in `HttpOnly; SameSite=Strict` cookies (the server keeps only their SHA-256); 30-min idle / 8-h absolute expiry; lockout after 5 failed logins; CSRF token on every change; strict CSP with no inline scripts or styles; `noindex`; CSV formula-injection protection; every write is audited; optional IP allow-list. On a server, reach it through an SSH tunnel: `ssh -L 3001:127.0.0.1:3001 you@server`.

**Customer-facing extras** — coupon field at checkout (`WELCOME10` is created automatically and handed out by the newsletter sign-up), live stock on the product page, **Track Your Order** page (needs order number + email, reveals no address), Privacy / Terms / Shipping & Returns pages, a branded 404, `robots.txt`, `sitemap.xml` and product structured data.

> The policy pages are drafted from your FAQ and the way checkout actually works. **Have a lawyer/CA review them** and fill in your registered business details in Admin → Settings before going live.

## ✦ Going Live Checklist

Step-by-step server guide: [`deploy/DEPLOY.md`](deploy/DEPLOY.md). Run `npm run preflight` — it lists anything that would block a launch.


1. Complete Razorpay KYC and generate **live** keys; put them in the host's environment (not in git).
2. Set `NODE_ENV=production`, `PUBLIC_ORIGIN=https://houseofmangalya.com`, `PAYMENT_PROVIDER=razorpay`.
3. In Razorpay Dashboard → Webhooks, add `https://<domain>/api/webhooks/razorpay` with events `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`, `refund.processed`, `refund.failed`, and set `RAZORPAY_WEBHOOK_SECRET`.
4. Enable **auto-capture** in Razorpay payment settings.
5. Host behind HTTPS (Render, Railway, a VPS with nginx/Caddy…). Set `TRUST_PROXY=true` only behind your own proxy.
6. Run `npm run admin:password` on the server, keep `ADMIN_HOST=127.0.0.1`, and run `npm run seed:demo -- --clear` if you ever loaded demo data.
7. Schedule `npm run backup` daily and copy `backups/` off the machine; `data/orders.db` — it contains customer addresses (personal data under India's DPDP Act).

> Note: this site now needs a Node server for checkout. Static hosting (e.g. GitHub Pages) will serve the pages but checkout will not work.

## ✦ License

This project is licensed under the [MIT License](LICENSE).
