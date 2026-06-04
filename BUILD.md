# oidc-webpush — Build Specification

> **This document is the single source of truth.** Any AI reading this must implement exactly what is written. If the implementation diverges, it is wrong.

---

## 1. Project Identity

- **Name**: `oidc-webpush` everywhere — package.json name, repo paths, systemd service, UI title, comments.
- **Scope**: Self-hosted email → Web Push notification gateway. One Node.js process, no external mail relay.
- **Repository root**: `/Users/lr3884/Documents/GIT/oidc-webpush`

---

## 2. Tech Stack (Exact Versions)

```json
{
  "name": "oidc-webpush",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/app.ts",
    "start": "node dist/app.js",
    "typecheck": "tsc --noEmit",
    "gen-vapid": "node -e \"const w=require('web-push');const k=w.generateVAPIDKeys();console.log('VAPID_PUBLIC='+k.publicKey);console.log('VAPID_PRIVATE='+k.privateKey)\""
  }
}
```

**Dependencies:**
- `fastify` ^5.2.1
- `@fastify/cookie` ^11.0.2
- `@fastify/formbody` ^8.0.2
- `@fastify/static` ^8.1.1
- `better-sqlite3` ^11.7.0
- `mailparser` ^3.7.2
- `nanoid` ^5.0.9
- `openid-client` ^5.7.1
- `smtp-server` ^3.13.6
- `web-push` ^3.6.7
- `@node-rs/argon2` (or `argon2`) for credential hashing

**DevDependencies:**
- `@types/better-sqlite3` ^7.6.12
- `@types/mailparser` ^3.4.5
- `@types/node` ^22.10.5
- `@types/smtp-server` ^3.5.10
- `@types/web-push` ^3.6.4
- `tsx` ^4.19.2
- `typescript` ^5.7.3

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "public"]
}
```

---

## 3. Directory Structure

```
oidc-webpush/
├── package.json
├── package-lock.json (or pnpm-lock.yaml)
├── tsconfig.json
├── install.sh          # one-liner curl-to-bash installer
├── .env.example        # template for required env vars
├── .gitignore
├── src/
│   ├── app.ts          # bootstrap: init DB, start Fastify, start SMTP
│   ├── config.ts       # env var parsing, defaults, validation
│   ├── db.ts           # SQLite connection, schema creation, migrations
│   ├── types.ts        # TypeScript interfaces (User, Subscription, Rule, Event, Session, Credential, etc.)
│   ├── auth.ts         # OIDC client setup, login/callback/logout handlers
│   ├── routes.ts       # all HTTP API route handlers (Fastify)
│   ├── smtp.ts         # SMTPServer setup, onAuth, onData
│   ├── push.ts         # web-push wrapper, sendPush(), auto-prune
│   ├── rules.ts        # evalRules() engine
│   ├── ai.ts           # Ollama integration, prompt template, semaphore
│   └── utils.ts        # esc(), relTime(), etc.
├── public/
│   ├── index.html
│   ├── style.css
│   ├── client.js       # vanilla JS, fetch() API calls, DOM manipulation
│   ├── sw.js           # service worker
│   └── manifest.json
└── data/               # created at runtime, gitignored
    └── oidc-webpush.db
```

**Rules:**
- Backend is TypeScript under `src/`, compiled to `dist/`.
- Frontend is vanilla JavaScript in `public/`. **NO htmx, NO React, NO Vue, NO Svelte.**
- `public/` is served as static files by Fastify (`@fastify/static`).
- No frontend build step. No bundler.

---

## 4. Database Schema

Use `better-sqlite3` with WAL mode and foreign keys.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  sub          TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT PRIMARY KEY,
  user_sub    TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id            TEXT PRIMARY KEY,
  user_sub      TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  match_field   TEXT NOT NULL,  -- 'from', 'subject', 'body'
  match_pattern TEXT NOT NULL,
  action        TEXT NOT NULL,  -- 'mute', 'priority', 'tag'
  action_value  TEXT,           -- NULL for mute, numeric string for priority, label for tag
  enabled       INTEGER NOT NULL DEFAULT 1,
  app_name      TEXT,             -- user-defined label from credential list
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  user_sub        TEXT,
  from_addr       TEXT,
  to_addr         TEXT,
  subject         TEXT,
  matched_rule    TEXT,
  action_taken    TEXT,
  delivered_count INTEGER DEFAULT 0,
  failed_count    INTEGER DEFAULT 0,
  status          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_sub   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, key)
);

CREATE TABLE IF NOT EXISTS smtp_credentials (
  id             TEXT PRIMARY KEY,
  user_sub       TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  message_count  INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_sub, ts DESC);
CREATE INDEX IF NOT EXISTS idx_rules_user   ON rules(user_sub, position);
CREATE INDEX IF NOT EXISTS idx_subs_user    ON subscriptions(user_sub);
```

**Migration bootstrap:**
On first startup, check `SELECT MAX(version) FROM schema_version`.
If no row exists, run all `CREATE TABLE IF NOT EXISTS` above, then `INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`.

**DB code style:**
- Use a thin repository layer (plain functions, not a class).
- All queries are prepared statements cached in a `queries` object.
- Do NOT use ORM. Raw SQL only.

---

## 5. Environment Variables

All required vars fail fast on startup if missing.

```bash
# Server
BASE_URL=https://notify.example.com      # public HTTPS URL
PORT=3000
HOST=0.0.0.0

# SMTP
SMTP_PORT=2525
SMTP_HOST=0.0.0.0

# OIDC
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=replace-me
OIDC_CLIENT_SECRET=replace-me

# VAPID (Web Push)
VAPID_PUBLIC=                          # optional; auto-gen if blank
VAPID_PRIVATE=                         # optional; auto-gen if blank
VAPID_SUBJECT=mailto:admin@localhost

# Session
COOKIE_SECRET=                         # 32+ hex chars

# Storage
DB_PATH=./data/oidc-webpush.db

# Admin
ADMIN_EMAILS=admin@example.com       # comma-separated, case-insensitive

# AI / Ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
OLLAMA_TIMEOUT_MS=5000
OLLAMA_MAX_CONCURRENCY=2
OLLAMA_QUEUE_TIMEOUT_MS=120000
AI_BYPASS_PATTERNS=2fa|verification|otp|alert
AI_SKIP_PATTERNS=password|reset|credit card
AI_FILTER_DEFAULT=true               # default for new users' use_ai_filter

# Logging
LOG_LEVEL=info
```

**Auto-generate VAPID:**
If `VAPID_PUBLIC` or `VAPID_PRIVATE` is blank on startup:
1. Generate keys using `web-push`.
2. Print to stdout in a **very visible banner** with `=== SAVE THESE KEYS ===`.
3. **Do NOT** write them to `.env` automatically — admin must copy them.
4. Exit with error code until they are provided.

---

## 6. Authentication & Authorization

### OIDC Flow
- Use `openid-client` v5.
- `Issuer.discover(config.oidc.issuer)` at startup.
- Client config: `client_id`, `client_secret`, `redirect_uris=["${BASE_URL}/auth/callback"]`, `response_types=['code']`.
- PKCE: generate `state`, `nonce`, `codeVerifier`, `codeChallenge` per login attempt.
- Store PKCE data in-memory Map keyed by random UUID. Expire entries after 10 minutes. Clean with `setInterval(60000)`.
- Set short-lived cookie `oidc_state` (HttpOnly, SameSite=Lax, maxAge=600) holding the UUID key.

### Session
- After successful OIDC callback:
  - Upsert user into `users` table.
  - If user's email matches `ADMIN_EMAILS`, set `is_admin=1` (permanent, never downgraded by UI).
  - Create session: `sid = randomUUID()`, `expires_at = now + 7 * 86400000`.
  - Set cookie `sid` (HttpOnly, SameSite=Lax, maxAge=7 * 86400).
- Session cleanup: `setInterval(() => db.exec('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]), 3600000)`.

### Auth Gate (Fastify preHandler hook)
```
PUBLIC_PATHS = {'/manifest.json', '/sw.js', '/client.js', '/style.css', '/favicon.ico', '/healthz'}
If req.url starts with '/auth/' or is in PUBLIC_PATHS or starts with '/icons/': allow.
Else:
  Lookup session by sid cookie.
  If expired or missing: redirect to /auth/login for GET /, else 401.
  Lookup user by session.user_sub.
  If user missing: 401.
  Attach user to req.user for downstream handlers.
```

### Admin Check
```typescript
function isAdmin(user: User): boolean {
  if (user.is_admin) return true;
  // env check is for initial bootstrap only; after first login, is_admin is set in DB
  return false;
}
```
- Env-listed admins get `is_admin=1` on first login and retain it permanently.
- Other admins can be promoted/demoted via UI by existing admins.

### Admin Impersonation
- Admin sees a "View as user" dropdown on `/`.
- Selecting a user sets a session flag `impersonating_user_sub`.
- All subsequent API calls use that user's data until admin clicks "Return to admin view".
- A banner shows: "Viewing as alice@example.com [Return to admin view]".

---

## 7. SMTP Server

### Server Setup
- Port `config.smtpPort`, host `config.smtpHost`.
- **NO STARTTLS. NO unauthenticated mode.**
- `authOptional: false`, `disabledCommands: ['STARTTLS', 'AUTH']` is WRONG — we need AUTH.
- Actually: `disabledCommands: ['STARTTLS']`. Auth is REQUIRED.

### onAuth
```typescript
onAuth(auth, session, cb) {
  const cred = db.prepare('SELECT * FROM smtp_credentials WHERE id = ?').get(auth.username);
  if (!cred || !cred.enabled) return cb(new Error('invalid credentials'));
  const ok = await argon2Verify(cred.password_hash, auth.password);
  if (!ok) return cb(new Error('invalid credentials'));
  // Update stats
  db.prepare('UPDATE smtp_credentials SET last_used_at = ?, message_count = message_count + 1 WHERE id = ?').run(Date.now(), cred.id);
  return cb(null, { user: cred.user_sub });  // store owner sub in session
}
```

### onData
```typescript
async onData(stream, session, cb) {
  try {
    const parsed = await simpleParser(stream);
    for (const rcpt of session.envelope.rcptTo) {
      const recipient = rcpt.address.toLowerCase().trim();
      const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(recipient);
      if (!user) {
        db.prepare('INSERT INTO events (...)').run(Date.now(), null, parsed.from?.text, recipient, parsed.subject, null, null, 0, 0, 'no_user');
        continue;
      }
      await handleEmail(parsed, recipient, user, session.user); // session.user is the credential owner sub
    }
    cb();
  } catch (err) {
    cb(err);
  }
}
```

**Important:** `session.user` from onAuth is the credential owner (the admin/user who created the credential). The `RCPT TO` address determines the actual recipient user. These may be the same person or different. The credential owner is used for stats/labeling only; delivery is always to the `RCPT TO` user.

### handleEmail Logic
```typescript
async function handleEmail(parsed: ParsedMail, recipient: string, user: User, credentialOwnerSub: string) {
  const from = parsed.from?.text ?? '';
  const subject = parsed.subject ?? '(no subject)';
  const body = parsed.text ?? (parsed.html ? String(parsed.html) : '');

  const rules = db.prepare('SELECT * FROM rules WHERE user_sub = ? AND enabled = 1 ORDER BY position ASC').all(user.sub);
  const matched = evalRules(rules, { from, subject, body });

  if (matched?.action === 'mute') {
    logEvent('muted', user.sub, from, recipient, subject, matched.id, 'mute', 0, 0);
    return;
  }

  // AI processing
  let aiResult = null;
  const aiEnabled = getUserPref(user.sub, 'use_ai_filter', config.aiFilterDefault);
  const aiSummaryEnabled = getUserPref(user.sub, 'use_ai_summary', 'true');

  if (aiEnabled !== 'false' && !matchesSkipPattern(body, subject)) {
    aiResult = await callOllama(subject, from, body);
  }

  if (aiResult && aiResult.relevant === false) {
    logEvent('ai_suppressed', user.sub, from, recipient, subject, matched?.id ?? null, 'ai_skip', 0, 0);
    return;
  }

  let pushBody = body;
  let priority = matched?.action === 'priority' ? Number(matched.action_value) || 3 : 3;
  let tag = matched?.action === 'tag' ? matched.action_value : null;

  if (aiResult && aiResult.summary) {
    pushBody = aiResult.summary;
    if (aiResult.priority) priority = aiResult.priority;
  } else {
    pushBody = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  const subs = db.prepare('SELECT * FROM subscriptions WHERE user_sub = ?').all(user.sub);
  let delivered = 0, failed = 0;
  await Promise.all(subs.map(async s => {
    const r = await sendPush(s, { title: subject.slice(0, 100), body: pushBody.slice(0, 500), from, priority, tag, ts: Date.now() });
    if (r.ok) delivered++; else failed++;
  }));

  const status = subs.length === 0 ? 'no_devices' : delivered > 0 ? 'delivered' : 'failed';
  logEvent(status, user.sub, from, recipient, subject, matched?.id ?? null, matched?.action ?? null, delivered, failed);
}
```

---

## 8. Rules Engine

```typescript
interface EmailCtx { from: string; subject: string; body: string; }

function evalRules(rules: Rule[], email: EmailCtx): Rule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    const haystack = email[r.match_field] ?? '';
    let matches = false;
    try {
      matches = new RegExp(r.match_pattern, 'i').test(haystack);
    } catch {
      matches = haystack.toLowerCase().includes(r.match_pattern.toLowerCase());
    }
    if (matches) return r;
  }
  return null;
}
```

**Actions:**
- `mute`: drop silently, log event with `status='muted'`.
- `priority`: numeric 1-5. Default if invalid or missing is 3.
- `tag`: string label. Passed to Service Worker as `options.tag`.

**`app_name` column:**
- When creating a rule, user selects from a combobox of all credential `name` values created by admin for this user.
- Optional. Can be NULL.

---

## 9. Web Push

### VAPID Setup
```typescript
webpush.setVapidDetails(config.vapid.subject, config.vapid.public, config.vapid.private);
```

### sendPush
```typescript
async function sendPush(sub: Subscription, payload: object): Promise<{ ok: boolean; statusCode?: number }> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err: any) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(sub.endpoint);
    }
    return { ok: false, statusCode: err.statusCode };
  }
}
```

### Payload Structure
```json
{
  "title": "subject up to 100 chars",
  "body": "summary or truncated body up to 500 chars",
  "from": "sender address",
  "priority": 3,
  "tag": "ci",
  "ts": 1234567890
}
```

---

## 10. AI / Ollama Integration

### Prompt Template
```
You are an email triage assistant. Given an email, respond with JSON:
{ "relevant": boolean, "summary": "...", "priority": number, "reason": "..." }
- relevant: true if this is something a person would want to be notified about on their phone
- summary: one sentence, max 140 chars, captures the actionable content
- priority: 1 (low) to 5 (high), default 3
- reason: brief explanation of the relevance decision

Subject: {subject}
From: {from}
Body: {body}
```

### callOllama Function
```typescript
import { request } from 'node:https';

const semaphore = { count: config.ollamaMaxConcurrency, queue: [] as Function[] };

async function acquireSemaphore(): Promise<void> {
  if (semaphore.count > 0) {
    semaphore.count--;
    return;
  }
  return new Promise((resolve) => semaphore.queue.push(resolve));
}

function releaseSemaphore(): void {
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift();
    next?.();
  } else {
    semaphore.count++;
  }
}

async function callOllama(subject: string, from: string, body: string): Promise<AiResult | null> {
  await acquireSemaphore();
  const timeout = setTimeout(() => releaseSemaphore(), config.ollamaQueueTimeoutMs);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);

    const res = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt: buildPrompt(subject, from, body),
        stream: false,
        format: 'json',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.response);
    return { relevant: parsed.relevant, summary: parsed.summary, priority: parsed.priority };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    releaseSemaphore();
  }
}
```

### Bypass & Skip Patterns
- `AI_BYPASS_PATTERNS`: regex checked BEFORE Ollama call. If subject or body matches, force `relevant=true` and skip AI.
- `AI_SKIP_PATTERNS`: regex checked BEFORE Ollama call. If matches, skip Ollama entirely and fall back to direct delivery.

### User Preferences
- `use_ai_filter`: default from `AI_FILTER_DEFAULT` env var.
- `use_ai_summary`: always default ON.
- Stored in `user_prefs` table with keys `use_ai_filter` and `use_ai_summary`.

---

## 11. API Specification (JSON Only)

All dashboard API routes return **JSON**. Only static file routes serve HTML/CSS/JS.

### Auth
- `GET /auth/login` → 302 redirect to OIDC provider
- `GET /auth/callback` → handles OIDC callback, sets session cookie, redirects to `/`
- `POST /auth/logout` → clears session, redirects to `/`

### Public
- `GET /healthz` → `{ ok: true }`
- `GET /api/vapid-public-key` → plain text VAPID public key

### User (requires session)
- `GET /api/me` → `{ email, display_name, is_admin }`

### Devices
- `GET /api/devices` → `[{ id, endpoint, user_agent, last_seen, created_at }]`
- `POST /api/subscribe` → body `{ endpoint, keys: { p256dh, auth }, userAgent }` → returns updated devices array
- `DELETE /api/devices/:id` → returns updated devices array

### Rules
- `GET /api/rules` → `[{ id, position, match_field, match_pattern, action, action_value, enabled, app_name }]`
- `POST /api/rules` → body `{ match_field, match_pattern, action, action_value?, app_name?, enabled? }` → returns updated rules array
- `DELETE /api/rules/:id` → returns updated rules array
- `PATCH /api/rules/:id` → body `{ enabled? }` → toggle on/off

### Events
- `GET /api/events?after=<id>` → returns events with `id > after`, limited to 50. If `after` omitted, returns last 50.
- Response: `[{ id, ts, from_addr, to_addr, subject, status, delivered_count, failed_count }]`

### Test Push
- `POST /api/test` → sends test push to all user devices → `{ sent: N, total: M }`

### Admin Only
- `GET /api/admin/users` → `[{ sub, email, display_name, is_admin, device_count, event_count_7d, last_event_ts }]`
- `GET /api/admin/events/unmatched` → events with `status='no_user'`, last 50
- `POST /api/admin/users/:sub/admin` → `{ is_admin: boolean }` → promote/demote (cannot demote env admins)
- `GET /api/admin/credentials` → list all credentials
- `POST /api/admin/credentials` → body `{ user_sub, name }` → creates credential, returns `{ id, name, password }` (password shown ONCE)
- `PATCH /api/admin/credentials/:id` → body `{ enabled: boolean }`
- `DELETE /api/admin/credentials/:id`

### Impersonation
- `POST /api/admin/impersonate` → body `{ user_sub }` or `{ clear: true }` → sets session flag

---

## 12. Frontend Specification

### index.html Structure
Single page `/` with these sections in order:
1. **Header bar**: brand dot + "oidc-webpush" + current host + user email + Sign Out button
2. **Devices card**: header "devices" + "enable on this device" button + list of enrolled devices (UA + last seen + remove button)
3. **Rules card**: header "rules" + "+ add rule" button (toggles form) + list of rules + add rule form
4. **Events card**: header "events" + "test push" button + "refresh" button + toast slot + event list
5. **Admin sections** (only if `is_admin` from `/api/me`): Users, SMTP Credentials, Unmatched Events
6. **Footer**: "self-hosted · web push via VAPID · sso via OIDC"

### Add Rule Form Fields
- `match_field`: select (`subject`, `from`, `body`)
- `match_pattern`: text input (regex or substring)
- `action`: select (`priority`, `mute`, `tag`)
- `action_value`: text input (hidden when action=`mute`)
- `app_name`: select populated from admin credentials for this user
- Submit → POST `/api/rules` → client updates rules list from response

### Events List Behavior
- On load: `GET /api/events` (no `after` param), renders list.
- On refresh: `GET /api/events?after=<lastSeenId>`, appends new events to top.
- Manual refresh only. NO auto-polling.

### client.js Key Behaviors
- Register Service Worker (`/sw.js`, scope `/`).
- On "enable on this device" click:
  1. `Notification.requestPermission()`
  2. `fetch('/api/vapid-public-key')`
  3. `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })`
  4. POST `/api/subscribe` with endpoint + keys + userAgent
  5. Update devices list from response
- All dynamic updates use `fetch()` + manual DOM manipulation. No htmx.

### Service Worker (sw.js)
```javascript
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'oidc-webpush';
  const priority = data.priority || 3;
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: data.tag || undefined,
    timestamp: data.ts || Date.now(),
    requireInteraction: priority >= 4,
    vibrate: priority >= 4 ? [200, 100, 200] : undefined,
    data: { from: data.from, priority, url: '/' },
    actions: [
      { action: 'mute-type', title: 'Mute this' },
      { action: 'open', title: 'Open' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'mute-type') {
    const { from } = event.notification.data;
    event.waitUntil(
      fetch('/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ match_field: 'from', match_pattern: `^${from}$`, action: 'mute' })
      }).then(() => self.registration.showNotification('Muted', { body: `No more from ${from}`, tag: 'mute-confirm' }))
    );
    return;
  }
  const url = event.notification.data?.url || '/';
  event.waitUntil(self.clients.openWindow(url));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const key = await fetch('/api/vapid-public-key').then(r => r.text());
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.trim()),
      });
      const json = newSub.toJSON();
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
    } catch (err) { console.error('resubscribe failed', err); }
  })());
});

function urlBase64ToUint8Array(base64String) { /* standard implementation */ }
```

**iOS fallback:** Action buttons are unreliable on iOS PWAs. Tapping the notification body opens `/`. The mute action button is a convenience for Android/Desktop. iOS users mute via the dashboard rules page.

---

## 13. CSS Theme

Single dark theme. No toggle. No light mode.

```css
:root {
  --bg: #0e0f12;
  --bg-elev: #16181d;
  --bg-row: #1a1d23;
  --border: #25282f;
  --border-hi: #3a3e47;
  --fg: #e6e3da;
  --fg-dim: #9a9690;
  --fg-faint: #5e5b56;
  --accent: #f6a623;
  --accent-dim: #8a5e14;
  --ok: #6abf69;
  --warn: #e8a647;
  --err: #d65d5d;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Inter Tight', system-ui, -apple-system, sans-serif;
}
```

Keep the existing refined terminal aesthetic from `public/style.css`.

---

## 14. Install Script (`install.sh`)

One-liner: `bash -c "$(curl -fsSL https://example.com/install.sh)"`

Requirements:
1. Detect OS (Debian/Ubuntu/Fedora/Arch).
2. Install Node.js 24 LTS (via Nodesource, n, or package manager).
3. Install pnpm.
4. Clone repo to `/opt/oidc-webpush`.
5. Run `pnpm install && pnpm run build`.
6. Generate VAPID keys if missing (print to stdout, require manual save).
7. Interactive prompts for env vars: `BASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `ADMIN_EMAILS`, `OLLAMA_URL` (optional), `AI_FILTER_DEFAULT` (Y/n).
8. Write `/opt/oidc-webpush/.env`.
9. Create systemd unit `/etc/systemd/system/oidc-webpush.service`.
10. `systemctl daemon-reload && systemctl enable --now oidc-webpush`.

**Update / Upgrade:**
When `install.sh` is run again on an existing installation (detected by `/opt/oidc-webpush/.env` existing), it enters **update mode** instead of install mode:
1. `cd /opt/idc-webpush && git pull` (or re-clone if dirty).
2. `pnpm install && pnpm run build`.
3. Run any pending DB migrations automatically (check `schema_version`, apply missing).
4. Restart systemd service: `systemctl restart oidc-webpush`.
5. Preserve existing `.env` and database. Do NOT overwrite `.env`.
6. Print summary of changes (git log since last deploy).

**No Docker.** No mention of backup. No reverse proxy configs.

---

## 15. Edge Cases & Correct Behavior

1. **Unknown recipient**: log `status='no_user'`, return SMTP 250 OK. No bounce.
2. **No devices**: log `status='no_devices'`. No push attempted.
3. **All pushes fail**: log `status='failed'`.
4. **Ollama down/timeout**: fallback to truncated body delivery. Never silently drop.
5. **AI returns invalid JSON**: catch, fallback to direct delivery.
6. **Push endpoint 404/410**: immediate DELETE from DB.
7. **Session expired during action**: redirect to `/auth/login` for GET, 401 for others.
8. **Admin demoting env admin**: reject with 403. Env admins are permanent.
9. **Impersonating non-existent user**: reject with 404.
10. **Credential auth with disabled credential**: return SMTP auth failure.
11. **Unauthenticated SMTP connection**: reject with `535 Authentication required`.

---

## 16. Things Explicitly NOT Included

Do NOT implement any of these, even if they seem reasonable:
- htmx, React, Vue, Svelte, or any frontend framework
- HTML fragment API responses (only JSON for API routes)
- STARTTLS on SMTP
- Local user registration or username/password auth
- Traefik/Nginx/Caddy sample configs
- Docker/Dockerfile
- Backup/restore utilities or documentation
- Email body persistence or full-message viewer
- Broadcast push to all users
- Group/shared topics or mailing lists
- Time-limited rules or `expires_at`
- `origin` column on rules (use `app_name` instead)
- User aliases for fixing typos
- Metrics/Prometheus endpoint
- Per-rule `AND`/`OR` compound conditions
- Mobile native app
- Light theme or theme toggle
- Log file rotation inside the app
- Mailrise integration

---

## 17. Build Checklist for Another AI

Before declaring "done", verify:
- [ ] `package.json` name is `oidc-webpush`, engines says `>=24`
- [ ] `src/` has multiple files, not a single `app.ts` monolith
- [ ] Frontend uses vanilla JS fetch(), no htmx
- [ ] All API routes return JSON (except static files)
- [ ] DB has `schema_version`, `user_prefs`, `smtp_credentials` tables
- [ ] `users` table has `is_admin` column
- [ ] `rules` table has `enabled` and `app_name` columns, no `origin`
- [ ] SMTP requires auth, no unauthenticated fallback
- [ ] `RCPT TO` determines recipient, credential only validates sender
- [ ] VAPID auto-generates with visible stdout banner if env vars missing
- [ ] Ollama has semaphore concurrency control
- [ ] Admin can impersonate users
- [ ] Install script uses pnpm, not npm
- [ ] Install script supports `update` mode (git pull + rebuild + db migrate + restart, preserves `.env`)
- [ ] No Docker, no backup docs, no reverse proxy configs
