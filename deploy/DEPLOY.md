# Going live — step by step

Time needed: about 2 hours, plus waiting for Razorpay KYC and DNS.
You need: a domain, a small Linux server (VPS), a Razorpay account, and this repository.

> The site is a Node.js server with a database file, so it needs a normal server (a VPS).
> Static hosts (GitHub Pages, Netlify) and serverless platforms (Vercel, Cloudflare Pages) cannot run it.

## 0. Before you start — launch blockers
Run `npm run preflight` on your laptop with your production values in `.env`. It must say **0 blocking issues**.
Also decide the content items in the PDF's Appendix A (certificate number, review count, health claims, origin story).

## 1. Buy a domain
Any registrar (GoDaddy, Namecheap, Cloudflare, BigRock). Use the same name as `PUBLIC_ORIGIN`.

## 2. Create the server
- Ubuntu 24.04 LTS, 1 vCPU / 1–2 GB RAM is plenty to start.
- Choose a data-centre close to your customers (Mumbai or Bangalore if offered).
  Providers with Indian regions include AWS Lightsail, DigitalOcean, Linode/Akamai and Google Cloud — check current availability and price.
- Add **your SSH key** during creation; do not use password login.

## 3. Secure the server (first login as root)
```bash
adduser --disabled-password --gecos "" mangalya
apt update && apt -y upgrade
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
# optional but wise: disable SSH password login and root login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl reload ssh
```
Ports 3000 and 3001 stay **closed** to the internet. The store is reached through Caddy; the admin only through an SSH tunnel.

## 4. Install Node.js (22.13 or newer) and Caddy
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs
apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
node --version   # must be v22.13 or higher
```

## 5. Put the code on the server
```bash
mkdir -p /opt/mangalya && chown mangalya:mangalya /opt/mangalya
su - mangalya -c "git clone https://github.com/Saumya039/House-Of-Mangalya.git /opt/mangalya"   # or upload with scp/rsync
mkdir -p /opt/mangalya/data /opt/mangalya/backups && chown -R mangalya:mangalya /opt/mangalya
```
(There is nothing to `npm install` — no third-party packages.)
Do **not** copy your laptop's `data/` folder: production starts with a clean database.

## 6. Configure secrets
```bash
su - mangalya
cd /opt/mangalya
cp .env.production.example .env && chmod 600 .env
nano .env                      # fill in the domain, Razorpay keys, webhook secret
npm run admin:password -- --generate     # prints the admin password ONCE and stores only its hash
npm run preflight              # must show no blocking issues
```
Razorpay: Dashboard → Account & Settings → API Keys (use **live** keys once KYC is approved).
Webhook: Dashboard → Webhooks → URL `https://YOUR-DOMAIN/api/webhooks/razorpay`, events
`payment.captured, payment.failed, payment.authorized, order.paid, refund.processed, refund.failed`,
and put the secret you choose in `RAZORPAY_WEBHOOK_SECRET`. Also enable **auto-capture**.

## 7. Run it as a service
```bash
cp /opt/mangalya/deploy/mangalya.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now mangalya
systemctl status mangalya --no-pager      # should say "active (running)"
journalctl -u mangalya -n 20 --no-pager   # should show the store and admin lines
```

## 8. Point the domain and turn on HTTPS
1. At your registrar create **A records** for `@` and `www` → the server's IP address.
2. Edit `/opt/mangalya/deploy/Caddyfile` (your domain), then:
```bash
cp /opt/mangalya/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
```
Caddy fetches a free HTTPS certificate automatically once DNS has propagated (minutes to a few hours).

## 9. Test before announcing
- Open `https://YOUR-DOMAIN` — pages, images, cart.
- Place a **real small order** with a live card/UPI (a ₹ test with a low-priced coupon is fine), check it in the admin, ship it, print the invoice, then **refund it**.
- Admin → Payment events should show the webhook arriving.
- Run `npm run preflight` once more.

## 10. Open the admin (from your laptop)
```bash
ssh -L 3001:127.0.0.1:3001 mangalya@YOUR-SERVER-IP
```
Leave that window open, then browse to http://localhost:3001 . The admin is never exposed to the internet.

## 11. Keep it healthy
```bash
# daily backup at 02:30 (as the mangalya user:  crontab -e)
30 2 * * * cd /opt/mangalya && /usr/bin/node scripts/backup.js >> backups/backup.log 2>&1
```
Copy `/opt/mangalya/backups/` off the server regularly (it holds customer addresses — keep it private).

Update the site later:
```bash
su - mangalya -c "cd /opt/mangalya && git pull" && systemctl restart mangalya
```

## Rollback / trouble
- Site down: `journalctl -u mangalya -n 50 --no-pager`. The server refuses to start with an unsafe configuration and prints why.
- HTTPS not issued: DNS not propagated yet, or ports 80/443 blocked.
- Bad deploy: `git checkout <previous-commit>` then `systemctl restart mangalya`.
- Payments confirmed at Razorpay but showing unpaid: Admin → open the order → *Check status with gateway*.
