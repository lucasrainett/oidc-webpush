# oidc-webpush

> Self-hosted email → Web Push notification gateway with OIDC SSO

Transform any SMTP-capable application into instant push notifications on your phone and desktop. No cloud dependencies, no vendor lock-in, fully self-hosted.

---

## What is this?

**oidc-webpush** sits between your apps and your devices. Apps send emails via SMTP (the way they already know how), and users receive them as native Web Push notifications — on phones, tablets, laptops, and desktops — through their browser's PWA.

Every user authenticates through your existing **OIDC identity provider** (Authentik, Keycloak, Dex, Auth0, or any spec-compliant provider). No new passwords, no new accounts.

**Key use cases:**
- Proxmox backup alerts on your phone
- CI/CD pipeline failures on your desktop
- Home Assistant notifications everywhere
- Server monitoring alerts, cron job outputs — anything that can send email

---

## Features

### Core
- **Built-in SMTP server** on port 2525 — no external mail relay needed
- **Web Push delivery** via VAPID to all enrolled devices
- **OIDC Single Sign-On** — works with any OpenID Connect provider
- **SQLite persistence** — one file, WAL mode, no external database
- **Single Node.js process** — minimal footprint

### Rules Engine
- Per-user filtering rules: match on `from`, `subject`, or `body`
- Actions: **mute** (drop silently), **priority** (1–5 urgency), **tag** (group notifications)
- Pattern matching: regex or plain substring
- Enable/disable rules without deleting them
- **Rule tester**: validate a rule against a sample message before saving
- Up/down reordering of rules

### AI Integration (Optional)
- **Local Ollama** integration — all inference stays on your server
- **Smart filtering**: AI decides if a message is worth interrupting you for
- **Smart summarization**: concise summaries instead of raw email bodies
- **Bypass patterns**: never filter out 2FA, OTP, or alert keywords
- **Skip patterns**: never send sensitive content to the AI
- Per-user opt-in/opt-out via the settings panel

### Admin Features
- **Admin impersonation**: view and manage any user's dashboard as if you were them
- **Per-app SMTP credentials**: named credentials (e.g. "Proxmox", "Immich") with auto-generated tokens
- **Optional credential restriction**: lock a credential to a specific recipient user
- **Unmatched events monitor**: see emails that couldn't be routed
- **User management**: promote/demote admins (env-listed admins are permanent)

### Frontend
- **Single-page PWA** — installable on iOS, Android, and desktop
- **Vanilla JavaScript** — no build step, no framework
- **Dark terminal aesthetic** — refined, distraction-free
- **Per-device delivery status** — see exactly which device received each notification
- **Event detail page** — tap a notification to view full content and mute the sender

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

Run the same command again — it detects the existing installation, pulls the latest code, rebuilds, runs any pending database migrations, and restarts the service. Your `.env` and database are preserved.

### Manual install

```bash
git clone https://github.com/lucasrainett/oidc-webpush.git && cd oidc-webpush
pnpm install
pnpm run gen-icons   # generate PWA icons
pnpm run build
pnpm run gen-vapid   # save output to .env

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
                     │   │  Web Push    │─┼──► FCM / Mozilla / APNs
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
7. **Event logging** writes per-device delivery status to SQLite

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
| `COOKIE_SECRET` | Random 32+ byte hex string for session encryption | `openssl rand -hex 32` |

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
| `ADMIN_EMAILS` | Comma-separated admin emails | `admin@example.com` |

These users are automatically granted admin on first login and **cannot be demoted** through the UI.

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
| `AI_FILTER_DEFAULT` | Default AI filtering for new users | `true` |

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `HOST` | HTTP bind address | `0.0.0.0` |
| `SMTP_PORT` | SMTP port | `2525` |
| `SMTP_HOST` | SMTP bind address | `0.0.0.0` |
| `DB_PATH` | SQLite database file | `./data/oidc-webpush.db` |
| `LOG_LEVEL` | Fastify log level | `info` |
| `SMTP_ENDPOINT` | Human-readable SMTP address shown in dashboard | `notify.example.com:2525` |
| `EVENT_RETENTION_DAYS` | Delete events older than N days (0 = keep forever) | `0` |

---

## Usage

### Configuring your OIDC Provider

1. Create an OAuth2/OpenID client with:
   - **Client type**: Confidential
   - **Redirect URI**: `https://notify.example.com/auth/callback`
   - **Scopes**: `openid profile email`
2. Copy the **Issuer URL** to `OIDC_ISSUER`
3. Copy client ID and secret to `.env`

### Enrolling a Device

1. Open the web app and log in
2. Click **"enable on this device"**
3. Allow notification permissions when prompted

### Creating Rules

1. Click **"+ add rule"** in the Rules section
2. Choose match field (`subject`, `from`, `body`), enter a pattern, pick an action
3. Use **"test rule"** to verify the rule matches what you expect before saving

### Sending Notifications from Apps

Configure any SMTP-capable app:

| Field | Value |
|-------|-------|
| SMTP host | your server hostname |
| SMTP port | `2525` |
| Authentication | Required — use admin-created credentials |
| To | The recipient's OIDC email address |

### Creating SMTP Credentials (Admin)

1. Scroll to the **SMTP Credentials** section
2. Click **"+ add credential"**, give it a name (e.g. "Proxmox Backup")
3. Optionally restrict it to a specific recipient user
4. Copy the username and password — shown **once only**

---

## API

All endpoints return JSON except `/api/vapid-public-key` (plain text) and static files.

### Auth
- `GET /auth/login` — redirects to OIDC provider
- `GET /auth/callback` — OIDC callback, sets session cookie
- `POST /auth/logout` — clears session

### User
- `GET /api/me` — `{ email, display_name, is_admin, impersonating, smtp_endpoint, smtp_port }`
- `GET /api/prefs` — `{ use_ai_filter, use_ai_summary }`
- `PATCH /api/prefs` — update AI preferences

### Devices
- `GET /api/devices` — list subscriptions
- `POST /api/subscribe` — create/refresh subscription
- `DELETE /api/devices/:id` — remove subscription

### Rules
- `GET /api/rules` — list rules
- `POST /api/rules` — create rule
- `POST /api/rules/test` — test a message against current rules
- `DELETE /api/rules/:id` — delete rule
- `PATCH /api/rules/:id` — toggle enabled
- `PATCH /api/rules/:id/move` — reorder (`{ direction: "up" | "down" }`)

### Events
- `GET /api/events?after=<id>&before=<id>&status=<status>&credential=<name>` — list events
- `GET /api/events/:publicId` — event detail including per-device delivery status
- `POST /api/test` — send test push

### Admin
- `GET /api/admin/users` — list all users with stats
- `GET /api/admin/events/unmatched` — emails to unknown recipients
- `POST /api/admin/users/:sub/admin` — promote/demote admin
- `POST /api/admin/impersonate` — start/stop impersonation
- `GET /api/admin/credentials` — list all credentials
- `POST /api/admin/credentials` — create credential
- `PATCH /api/admin/credentials/:id` — toggle enabled
- `DELETE /api/admin/credentials/:id` — delete

---

## Security

- **Authentication**: OIDC only. No local accounts.
- **Sessions**: Server-side SQLite storage, 7-day expiry, HttpOnly `SameSite=Lax` cookies.
- **SMTP**: Mandatory authentication with Argon2id-hashed credentials. No unauthenticated mail accepted.
- **Push**: VAPID-authenticated Web Push. Treat VAPID keys like TLS certificates.
- **AI Privacy**: All inference on your local Ollama instance. No data leaves your network.

---

## Development

```bash
git clone https://github.com/lucasrainett/oidc-webpush.git
cd oidc-webpush
pnpm install
pnpm run gen-icons   # generate public/icons/*.png
pnpm run dev         # tsx watch mode
```

### Tech Stack
- **Backend**: Fastify 5, TypeScript, ES modules
- **Database**: better-sqlite3, WAL mode
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
  db.ts         # SQLite schema, migrations, queries
  types.ts      # TypeScript interfaces
  auth.ts       # OIDC client and session management
  routes.ts     # HTTP API handlers
  smtp.ts       # SMTP server and email processing
  push.ts       # Web Push delivery
  rules.ts      # Rules engine
  ai.ts         # Ollama integration
  utils.ts      # Helpers
public/
  index.html    # Single-page dashboard
  client.js     # Vanilla JS frontend
  sw.js         # Service Worker for push
  style.css     # Dark terminal aesthetic
  manifest.json # PWA manifest
  event.html    # Notification detail / mute page
scripts/
  gen-icons.mjs # SVG → PNG icon generation
  gen-vapid.mjs # VAPID key generation helper
```

---

## License

MIT

---

> Built for self-hosters. No cloud required. No data leaves your network unless you want it to.
