# oidc-webpush

Self-hosted email → push notification gateway with OIDC SSO.

Apps speak SMTP, users get Web Push on their phones and laptops. Every account
is tied to an OIDC identity, and each user's email address is what an app
sends to.

## One-line install

```bash
bash -c "$(curl -fsSL https://example.com/install.sh)"
```

Installs Node.js 24 LTS, pnpm, clones the repo, builds the app, generates
VAPID keys, writes `.env`, and starts a systemd service. Interactive
prompts cover public URL, OIDC provider details, admin emails, and Ollama
AI settings.

For unattended use, set env vars before piping (`BASE_URL`, `OIDC_*`,
`ADMIN_EMAILS`, etc.) and `NONINTERACTIVE=1`.

## Update

Simply run the same install command again on the target machine. It detects
the existing installation, pulls the latest code, rebuilds, runs any pending
DB migrations, and restarts the service. Your `.env` and database are
preserved.

## Manual install

```bash
git clone https://github.com/example/oidc-webpush && cd oidc-webpush
pnpm install
pnpm run build
pnpm run gen-vapid    # paste output into .env
cp .env.example .env  # then edit OIDC + VAPID + COOKIE_SECRET
node dist/app.js
```

## Architecture

```
┌──────────┐  OIDC   ┌────────────────────┐
│  OIDC    │◄────────┤   oidc-webpush     │
│ provider │         │   ┌──────────────┐ │
└──────────┘         │   │  Fastify     │ │ ── HTTP/PWA (3000)
[app] ───SMTP───────►│   │  SMTP server │ │ ── SMTP (2525)
                     │   │  Web Push    │─┼──► FCM / Mozilla autopush / APNs
                     │   │  SQLite      │ │
                     │   │  Ollama AI   │ │
                     │   └──────────────┘ │
                     └────────────────────┘
```

- **Fastify** + vanilla JS for the single-page UI and JSON API
- **`smtp-server`** for SMTP ingress, **`mailparser`** for parsing
- **`web-push`** for VAPID-authenticated push delivery
- **`better-sqlite3`** for persistence (one file, WAL mode)
- **`openid-client`** for OIDC SSO with PKCE
- **Ollama** (optional) for AI triage and summarization

## Routing model

Each OIDC user has an email. When an app sends to that email via the
built-in SMTP server, the recipient address is matched against the user table
(exact lowercase email) and the message is fanned out as a Web Push
notification to all of that user's registered devices.

Per-user rules (regex on `from`/`subject`/`body`) can mute, tag, or raise
priority before delivery. An optional Ollama AI integration can summarize
messages and filter noise.

Everything is logged to the `events` table and shown in the dashboard.

## OIDC setup

1. Create an OAuth2/OpenID provider with:
   - Client type: **Confidential**
   - Redirect URI: `https://notify.example.com/auth/callback`
   - Scopes: `openid profile email`
   - Signing key: any (RSA recommended)
2. Copy the **OpenID Configuration Issuer** URL — that's `OIDC_ISSUER`.
3. Copy client id and secret into `.env`.

## Sending notifications

Apps point their SMTP settings directly at oidc-webpush:

| Field      | Value                     |
|------------|---------------------------|
| SMTP host  | `notify.example.com`      |
| SMTP port  | `2525`                    |
| Auth       | required (admin-created per-app credentials) |
| From       | anything (shown in the notification) |
| To         | the recipient's OIDC email |

From the command line:

```bash
echo "Backup completed in 47 minutes" | \
  mail -s "[proxmox] backup ok" -r "sender@example.com" recipient@example.com \
       -S smtp=smtp://notify.example.com:2525
```

## Updating

```bash
bash -c "$(curl -fsSL https://example.com/install.sh)"
```

Or manually:

```bash
cd /opt/oidc-webpush
git pull
pnpm install --frozen-lockfile
pnpm run build
systemctl restart oidc-webpush
```

## License

MIT
