# Production runbook — Vercel + Neon (Postgres)

The site runs as static pages on Vercel's CDN plus one serverless function (`api/index.js`) for
checkout, tracking and the admin API. Orders, customers, stock, admin sessions and rate limits live in
**Neon Postgres** (Singapore, the closest region to India). Nothing is stored in server memory, so any
instance can serve any request.

```
Customer ─▶ Vercel CDN (pages)  ─▶ /api/* ─▶ Vercel Function (sin1) ─▶ Neon Postgres (ap-southeast-1)
                                               └─▶ Razorpay (orders, payments, refunds, webhooks)
Owner    ─▶ https://<site>/admin/  (password + authenticator code)
```

## Environments

| | Preview (branches) | Production (`main`) |
|---|---|---|
| Database | Neon branch `preview` (test data) | Neon branch `main` (live data) |
| Payments | test-mode gateway (no real money) | Razorpay **live** keys |
| Access | private (Vercel sign-in) | public |

Production refuses to start unless it is safe: live gateway keys, webhook secret, https site address,
Postgres URL and two-factor for the admin are all required. If something is missing the API answers
`503` and the reason is in **Vercel → Logs** (never shown to visitors).

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Production | Preview | Notes |
|---|---|---|---|
| `DATABASE_URL` | Neon `main` pooled URL | Neon `preview` pooled URL | mark **Sensitive**; use `sslmode=verify-full` |
| `RAZORPAY_KEY_ID` | `rzp_live_…` | `rzp_test_…` (optional) | |
| `RAZORPAY_KEY_SECRET` | live secret | test secret | **Sensitive** |
| `RAZORPAY_WEBHOOK_SECRET` | random 48-hex string | — | must equal the secret in Razorpay → Webhooks |
| `PUBLIC_ORIGIN` | `https://your-site` | — | exact public address, https |
| `ADMIN_USERNAME` | `admin` | `admin` | |
| `ADMIN_PASSWORD_HASH` | scrypt hash | same | from `npm run admin:password -- --generate --totp --print-env` |
| `ADMIN_TOTP_SECRET` | base32 secret | same | required in production |
| `DEFAULT_STOCK` | `200` | `200` | starting stock, adjust in Admin → Inventory |

Never put these in git. `.env` files are ignored by git and by Vercel uploads.

## Razorpay setup
1. Dashboard → **Account & Settings → API Keys** → generate live keys (secret is shown once).
2. **Webhooks → Add**: URL `https://<site>/api/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`,
   events `payment.captured, payment.failed, payment.authorized, order.paid, refund.processed, refund.failed`.
3. **Payment settings** → enable auto-capture.

## Deploying and updating
- Push to a branch → Vercel builds a private **preview**. Merge to `main` → **production**.
- `vercel.json` is generated: after changing security headers run `npm run build:vercel` (a test fails if it is stale).
- Run `npm test` before merging (35+ tests, runs against real Postgres semantics via PGlite).

## Smoke test after every production deploy
1. `https://<site>/api/health` → `{"ok":true}`.
2. Open the product page, add to cart, start checkout: the Razorpay window must open.
3. Place a small real order, ship it from Admin, print the invoice, then **refund** it.
4. Admin → Payment events shows the webhook; Admin → Dashboard shows the order.

## Operating it
- **Admin:** `https://<site>/admin/` — password + 6-digit authenticator code; sessions expire after 30 min idle.
  Five wrong attempts lock the IP for 15 minutes (shared across all instances).
- **Monitoring:** point a free uptime monitor (UptimeRobot, Better Stack) at `/api/health` every 5 minutes;
  it also keeps the database warm. Enable email alerts. Check Vercel → Logs for errors.
- **Backups:** Neon keeps point-in-time history only for a short window on the free plan (6 hours here).
  Run `npm run backup` weekly (needs `DATABASE_URL` in `.env`) and keep the file private — it contains
  customer addresses. Consider Neon's paid plan for longer history.
- **Rotate secrets** (every few months, or immediately if one is exposed): Neon → reset role password →
  update `DATABASE_URL`; `npm run admin:password -- --generate --totp --print-env` → update the two admin
  variables; Razorpay → regenerate keys / webhook secret; then redeploy.
- **Plans:** Vercel's free Hobby plan is for non-commercial use — a shop should use Pro. Neon free scales to zero
  after idle time (first request after a quiet spell is ~1 s slower).

## Troubleshooting
| Symptom | Check |
|---|---|
| API returns 503 | Vercel → Logs: the startup message names the missing/invalid variable |
| Payment paid at Razorpay but order unpaid | Admin → open the order → **Check status with gateway**; check the webhook URL/secret |
| Admin sign-in rejected | wrong code (wait for the next one, each works once), phone clock off, or locked for 15 min |
| `ERR_TOO_MANY_REDIRECTS` | clear the site's cookies/cache |

## Rollback
Vercel → Deployments → pick the last good deployment → **Promote to Production** (instant). Database
migrations are additive and backward compatible.

---

## Alternative: your own server
The same code runs on any machine with Node 22.13+ and a Postgres database: set `DATABASE_URL`,
`NODE_ENV=production` and the variables above, run `node server/index.js` behind Caddy/nginx
(`deploy/Caddyfile`, `deploy/mangalya.service` are provided). The admin then listens on
`127.0.0.1:3001` and is reached through an SSH tunnel.
