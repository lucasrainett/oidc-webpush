# notify-app

Self-hosted email → push notification gateway with Authentik SSO.

Apps speak SMTP, users get Web Push on their phones and laptops. Every account
is tied to an Authentik identity, and each user's email address is what an app
sends to.

## One-line install on Proxmox

```bash
bash -c "$(curl -fsSL https://forge.mgtd.net/lr/notify-app/raw/branch/main/install.sh)"
```

Creates an unprivileged Debian 12 LXC, installs Node.js, builds the app, generates
VAPID keys, writes `/opt/notify/.env`, and starts a systemd service. Interactive
prompts cover container sizing, network/VLAN, public URL, and Authentik OIDC
client details.

For unattended use, set env vars before piping (`CTID`, `BASE_URL`, `OIDC_*`,
etc. — see the script header) and `NONINTERACTIVE=1`.

## Manual install

```bash
git clone https://forge.mgtd.net/lr/notify-app && cd notify-app
npm ci
npm run build
npm run gen-vapid    # paste output into .env
cp .env.example .env # then edit OIDC + VAPID + COOKIE_SECRET
node dist/app.js
```

## Docker

```bash
docker build -t notify-app .
docker run --env-file .env -p 3000:3000 -p 2525:2525 -v $PWD/data:/app/data notify-app
```

## Architecture

```
┌──────────┐  OIDC   ┌────────────────────┐
│Authentik │◄────────┤   notify-app       │
└──────────┘         │   ┌──────────────┐ │
                     │   │  Fastify     │ │ ── HTTP/PWA (3000)
[app] ───SMTP───────►│   │  SMTP server │ │ ── SMTP (2525)
                     │   │  Web Push    │─┼──► FCM / Mozilla autopush / APNs
                     │   │  SQLite      │ │
                     │   └──────────────┘ │
                     └────────────────────┘
```

- **Fastify** + htmx for the single-page UI and HTML-fragment API
- **`smtp-server`** for SMTP ingress, **`mailparser`** for parsing
- **`web-push`** for VAPID-authenticated push delivery
- **`better-sqlite3`** for persistence (one file, WAL mode)
- **`openid-client`** for Authentik SSO with PKCE

## Routing model

Each Authentik user has an email. When an app sends to that email via the
built-in SMTP server, the recipient address is matched against the user table
(exact email first, then local-part match) and the message is fanned out as a
Web Push notification to all of that user's registered devices.

Per-user rules (regex on `from`/`subject`/`body`) can mute, tag, or raise
priority before delivery. Everything is logged to the `events` table and shown
in the dashboard.

## Authentik setup

1. Create an OAuth2/OpenID provider with:
   - Client type: **Confidential**
   - Redirect URI: `https://notify.mgtd.net/auth/callback`
   - Scopes: `openid profile email`
   - Signing key: any (RSA recommended)
2. Bind it to a new Application named `notify`.
3. The provider page shows an **OpenID Configuration Issuer** — that's
   `OIDC_ISSUER`.
4. Copy client id and secret into `.env`.

## Traefik route (example)

```yaml
http:
  routers:
    notify:
      rule: "Host(`notify.mgtd.net`)"
      entryPoints: [websecure]
      service: notify
      tls: {certResolver: cloudflare}
  services:
    notify:
      loadBalancer:
        servers: [{ url: "http://10.148.1.x:3000" }]
```

forwardAuth at Traefik is **not required** — notify-app does its own OIDC.
Adding it would force an extra Authentik round-trip without security benefit.

## Sending notifications

Apps point their SMTP settings directly at notify-app — no relay needed:

| Field      | Value                     |
|------------|---------------------------|
| SMTP host  | `notify.mgtd.net` (or LXC IP) |
| SMTP port  | `2525`                    |
| Auth       | optional (`SMTP_AUTH_USER` / `SMTP_AUTH_PASS` in `.env`) |
| From       | anything (shown in the notification) |
| To         | the recipient's Authentik email |

Routing is purely by the recipient address. `[email protected]` → Alice's
devices. Admin alerts can go to a shared address (e.g. create a synthetic
"admin" Authentik user, or add multiple users to a topic — see the rules
engine).

From the command line:

```bash
echo "Backup completed in 47 minutes" | \
  mail -s "[proxmox] backup ok" -r "[email protected]" [email protected] \
       -S smtp=smtp://notify.mgtd.net:2525
```

## Updating

```bash
pct exec <CTID> -- bash -c '
  cd /opt/notify
  runuser -u notify -- git pull
  runuser -u notify -- npm ci --no-audit --no-fund
  runuser -u notify -- npm run build
  systemctl restart notify
'
```

## License

MIT
