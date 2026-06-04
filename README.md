# oidc-webpush

> Self-hosted email → Web Push notification gateway with OIDC SSO

Transform any SMTP-capable application into instant push notifications on your phone and desktop. No cloud dependencies, no vendor lock-in, fully self-hosted.

---

## What is this?

**oidc-webpush** sits between your apps and your devices. Apps send emails via SMTP (the way they already know how), and users receive them as native Web Push notifications — on phones, tablets, laptops, and desktops — through their browser's PWA.

Every user authenticates through your existing **OIDC identity provider** (Authentik, Keycloak, Dex, Auth0, or any spec-compliant provider). No new passwords, no new accounts. The app learns each user's email address from their identity provider, and that's the address your other apps send notifications to.

**Key use cases:**
- Proxmox backup alerts on your phone
- CI/CD pipeline failures on your watch
- Home Assistant notifications on your desktop
- Server monitoring alerts, cron job outputs, anything that can send email

---

## Features

### Core
- **Built-in SMTP server** on port 2525 — no external mail relay needed
- **Web Push delivery** via VAPID to all enrolled devices
- **OIDC Single Sign-On** — works with any OpenID Connect provider
- **SQLite persistence** — one file, WAL mode, no external database
- **Single binary** — one Node.js process, minimal footprint

### Rules Engine
- Per-user filtering rules: match on `from`, `subject`, or `body`
- Actions: **mute** (drop silently), **priority** (1-5 urgency levels), **tag** (group notifications)
- Pattern matching: regex or plain substring
- Enable/disable rules without deleting them
- Tag rules with app names for organization

### AI Integration (Optional)
- **Local Ollama** integration for on-device AI inference
- **Smart filtering**: AI decides if a message is worth interrupting you for
- **Smart summarization**: 140-character summaries instead of raw email bodies
- **Bypass patterns**: Never filter out 2FA, verification, OTP, or alert keywords
- **Skip patterns**: Never send sensitive content (passwords, credit cards) to the AI
- Per-user opt-in/opt-out

### Admin Features
- **Admin impersonation**: View and manage any user's dashboard as if you were them
- **Per-app SMTP credentials**: Create named credentials (e.g. "Proxmox", "Immich") with auto-generated tokens
- **Unmatched events monitor**: See emails that couldn't be routed (typos, missing users)
- **User management**: Promote/demote admins (env-listed admins are permanent for recovery)

### Frontend
- **Single-page PWA** — installable on iOS, Android, and desktop
- **Vanilla JavaScript** — no build step, no framework bloat
- **Dark terminal aesthetic** — refined, distraction-free design
- **Manual refresh** — no distracting auto-polling

---

## Quick Start

### One-line install (recommended)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lucasrainett/oidc-webpush/main/install.sh)"
```

The script:
1. Detects your Linux distribution (Debian/Ubuntu/Fedora/Arch)
2. Installs Node.js 24 LTS and pnpm
3. Clones this repository to `/opt/oidc-webpush`
4. Installs dependencies and builds the TypeScript
5. Generates VAPID keys for Web Push
6. Prompts for OIDC provider configuration
7. Writes `.env` and creates a systemd service
8. Starts the service

**For unattended installs:**

```bash
export BASE_URL="https://notify.example.com"
export OIDC_ISSUER="https://sso.example.com"
export OIDC_CLIENT_ID="my-client-id"
export OIDC_CLIENT_SECRET="my-secret"
export ADMIN_EMAILS="admin@example.com"
export NONINTERACTIVE=1

bash -c "$(curl -fsSL https://raw.githubusercontent.com/lucasrainett/oidc-webpush/main/install.sh)"
```

### Update an existing installation

Simply run the same command again. It detects the existing installation, pulls latest code, rebuilds, runs any pending database migrations, and restarts the service. Your `.env` and database are preserved.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/lucasrainett/oidc-webpush/main/install.sh)"
```

### Manual install

```bash
git clone https://github.com/lucasrainett/oidc-webpush.git && cd oidc-webpush
pnpm install
pnpm run build
pnpm run gen-vapid    # save output to .env

cp .env.example .env
# Edit .env with your OIDC provider details and VAPID keys

node dist/app.js
```

---

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

### Flow

1. **App sends email** to `alice@example.com` via SMTP on port 2525
2. **SMTP server** authenticates the sender using per-app credentials
3. **Router** matches the `RCPT TO` address to a user (exact lowercase email)
4. **Rules engine** evaluates the user's rules (from/subject/body matching)
5. **AI triage** (if enabled) summarizes the email and decides relevance
6. **Web Push** fans out the notification to all of the user's enrolled devices
7. **Event logging** writes delivery status to SQLite for the dashboard

---

## Configuration

All configuration is via environment variables in `.env`.

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_URL` | Public HTTPS URL where the app is reachable | `https://notify.example.com` |
| `OIDC_ISSUER` | Your OIDC provider's issuer URL | `https://sso.example.com` |
| `OIDC_CLIENT_ID` | OAuth2 client ID | `oidc-webpush` |
| `OIDC_CLIENT_SECRET` | OAuth2 client secret | `secret...` |
| `COOKIE_SECRET` | Random 32+ byte hex string for session encryption | Generate with `openssl rand -hex 32` |

### Web Push (VAPID)

| Variable | Description | Default |
|----------|-------------|---------|
| `VAPID_PUBLIC` | VAPID public key | Auto-generated if blank |
| `VAPID_PRIVATE` | VAPID private key | Auto-generated if blank |
| `VAPID_SUBJECT` | Contact email for push service | `mailto:admin@localhost` |

If `VAPID_PUBLIC` or `VAPID_PRIVATE` is blank on startup, the app generates keys and prints them in a visible banner. **Save these to your `.env` and restart.** Rotating keys invalidates all existing subscriptions.

### Admin

| Variable | Description | Example |
|----------|-------------|---------|
| `ADMIN_EMAILS` | Comma-separated admin emails | `admin@example.com,ops@example.com` |

These users are automatically granted admin on first login and **cannot be demoted** through the UI. This is your break-glass recovery path.

### AI / Ollama (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `OLLAMA_URL` | Ollama API URL | `http://localhost:11434` |
| `OLLAMA_MODEL` | Model name | `llama3.2:3b` |
| `OLLAMA_TIMEOUT_MS` | Request timeout | `5000` |
| `OLLAMA_MAX_CONCURRENCY` | Concurrent AI requests | `2` |
| `OLLAMA_QUEUE_TIMEOUT_MS` | Max time to wait in queue | `120000` |
| `AI_BYPASS_PATTERNS` | Always deliver emails matching these | `2fa\|verification\|otp\|alert` |
| `AI_SKIP_PATTERNS` | Never send matching content to AI | `password\|reset\|credit card` |
| `AI_FILTER_DEFAULT` | Default for new users' AI filtering | `true` |

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `HOST` | HTTP bind address | `0.0.0.0` |
| `SMTP_PORT` | SMTP port | `2525` |
| `SMTP_HOST` | SMTP bind address | `0.0.0.0` |
| `DB_PATH` | SQLite database file | `./data/oidc-webpush.db` |
| `LOG_LEVEL` | Fastify log level | `info` |

---

## Using oidc-webpush

### Configuring your OIDC Provider

1. Create an OAuth2/OpenID provider with:
   - **Client type**: Confidential
   - **Redirect URI**: `https://notify.example.com/auth/callback`
   - **Scopes**: `openid profile email`
   - **Signing key**: RSA recommended
2. Copy the **OpenID Configuration Issuer** URL to `OIDC_ISSUER`
3. Copy client ID and secret to `.env`

### Enrolling a Device

1. Open the web app in your browser
2. Log in via your OIDC provider
3. Click **"enable on this device"**
4. Allow notification permissions when prompted
5. The device appears in your Devices list

### Creating Rules

1. In the Rules section, click **"+ add rule"**
2. Select what to match: `from`, `subject`, or `body`
3. Enter a pattern: `/regex/` or plain text (substring match)
4. Choose action: `priority`, `mute`, or `tag`
5. Optionally assign an app name for organization
6. Toggle "enabled" on/off as needed

### Sending Notifications from Apps

Configure any SMTP-capable app to send to your user's email address:

| Field | Value |
|-------|-------|
| SMTP host | `notify.example.com` (or your server IP) |
| SMTP port | `2525` |
| Authentication | Required — use admin-created credentials |
| From | Anything (shown in notification) |
| To | The recipient's OIDC email address |

**Example from command line:**

```bash
echo "Backup completed in 47 minutes" | \
  mail -s "[proxmox] backup ok" -r "sender@example.com" alice@example.com \
       -S smtp=smtp://notify.example.com:2525
```

### Admin: Creating SMTP Credentials

1. Log in as an admin
2. Scroll to the **SMTP Credentials** section
3. Select the user who should receive these emails
4. Name the credential (e.g. "Proxmox Backup")
5. Copy the username (`cred_xxx`) and password (`sk_xxx`) — shown **once only**
6. Paste these into your app's SMTP settings

### Admin: Impersonating Users

1. Select a user from the **"view as user"** dropdown
2. The page reloads showing that user's devices, rules, and events
3. A banner shows "Viewing as alice@example.com [return to admin view]"
4. You can create rules, send test pushes, or manage devices on their behalf

---

## API Reference

All endpoints return JSON except `/api/vapid-public-key` (plain text) and static files.

### Auth
- `GET /auth/login` — Redirects to OIDC provider
- `GET /auth/callback` — OIDC callback, sets session cookie
- `POST /auth/logout` — Clears session

### User
- `GET /api/me` — `{ email, display_name, is_admin, impersonating }`

### Devices
- `GET /api/devices` — List subscriptions
- `POST /api/subscribe` — Create/refresh subscription
- `DELETE /api/devices/:id` — Remove subscription

### Rules
- `GET /api/rules` — List rules
- `POST /api/rules` — Create rule
- `DELETE /api/rules/:id` — Delete rule
- `PATCH /api/rules/:id` — Toggle enabled

### Events
- `GET /api/events?after=<id>` — List events (incremental with `after`)

### Test
- `POST /api/test` — Send test push to all devices

### Admin
- `GET /api/admin/users` — List all users with stats
- `GET /api/admin/events/unmatched` — Emails to unknown recipients
- `POST /api/admin/users/:sub/admin` — Promote/demote admin
- `POST /api/admin/impersonate` — Start/stop impersonation

### SMTP Credentials (Admin)
- `GET /api/admin/credentials` — List all credentials
- `POST /api/admin/credentials` — Create credential (returns password once)
- `PATCH /api/admin/credentials/:id` — Toggle enabled
- `DELETE /api/admin/credentials/:id` — Delete

---

## Security

- **Authentication**: OIDC only. No local accounts, no API keys for browser access.
- **Sessions**: Server-side SQLite storage, 7-day expiry, HttpOnly `SameSite=Lax` cookies.
- **SMTP**: Mandatory authentication with Argon2id-hashed per-app credentials. No unauthenticated mail accepted.
- **CSRF**: Protected by `SameSite=Lax` cookies + OIDC state/nonce. No additional CSRF tokens.
- **Push**: VAPID-authenticated Web Push. Keys are permanent — treat them like TLS certificates.
- **AI Privacy**: All AI inference happens on your local Ollama instance. No data leaves your network. Sensitive content can be excluded via `AI_SKIP_PATTERNS`.
- **Admin Recovery**: Env-listed admins (`ADMIN_EMAILS`) are permanent. If the database is corrupted, you can always recover admin access.

---

## Troubleshooting

### "Missing required env var: BASE_URL"
The app exits on startup if required environment variables are missing. Check your `.env` file.

### "VAPID keys missing" banner
The app auto-generates VAPID keys if they're not in `.env`. Copy the printed keys into `.env` and restart.

### SMTP connection refused
- Verify the app is running and listening on the SMTP port (`ss -tlnp | grep 2525`)
- Check firewall rules
- Ensure the sending app uses the correct hostname and port

### Push notifications not arriving
1. Check the Events section in the dashboard — look for `failed` or `no_devices` status
2. Verify the device is enrolled (Devices section)
3. Check browser console for Service Worker errors
4. On iOS: ensure the PWA is installed ("Add to Home Screen")

### "invalid credentials" on SMTP
- Verify you're using a credential created by an admin
- Check that the credential hasn't been disabled or deleted
- Ensure the username and password are copied correctly (no extra whitespace)

### AI not working
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Check `OLLAMA_URL` points to the correct host
- The app falls back to direct delivery if Ollama is unreachable — check Events for `ai_suppressed` entries

---

## Development

```bash
git clone https://github.com/lucasrainett/oidc-webpush.git
cd oidc-webpush
pnpm install
pnpm run dev        # tsx watch mode
```

### Tech Stack
- **Backend**: Fastify 5, TypeScript, ES modules
- **Database**: better-sqlite3 with WAL mode
- **Auth**: openid-client with PKCE
- **SMTP**: smtp-server + mailparser
- **Push**: web-push with VAPID
- **Frontend**: Vanilla JavaScript, no build step
- **AI**: Ollama API with local models

### Project Structure
```
src/
  app.ts        # Bootstrap
  config.ts     # Environment configuration
  db.ts         # SQLite schema and queries
  types.ts      # TypeScript interfaces
  auth.ts       # OIDC client and session management
  routes.ts     # HTTP API handlers
  smtp.ts       # SMTP server and email processing
  push.ts       # Web Push delivery
  rules.ts      # Rules engine
  ai.ts         # Ollama integration
  utils.ts      # Helpers (esc, relTime, prompt builder)
public/
  index.html    # Single-page dashboard
  client.js     # Vanilla JS frontend
  sw.js         # Service Worker for push
  style.css     # Dark terminal aesthetic
  manifest.json # PWA manifest
```

---

## License

MIT

---

> Built for self-hosters. No cloud required. No data leaves your network unless you want it to.
