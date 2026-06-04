# notify-app · notes

Running design log and feature backlog. Captures decisions, deferred ideas, and
open questions so context doesn't drop between sessions.

## Decisions made (v0.1 scaffold)

- **Backend: single `src/app.ts` file.** Fastify + smtp-server + web-push +
  better-sqlite3 + openid-client. Split at ~800 lines, not before.
- **Frontend: separate `public/`** (index.html + client.js + sw.js + style.css +
  manifest.json). No build step. htmx loaded from CDN (TODO: vendor it).
- **Persistence: SQLite (better-sqlite3, WAL).** One file. Schema migrations
  via `CREATE IF NOT EXISTS` for now; add `schema_version` when needed.
- **Auth: OIDC against Authentik with PKCE.** Server-side session table
  (7-day cookie). No CSRF middleware — relying on `SameSite=Lax`.
- **Routing model: by recipient address.** Local part or exact email match
  against Authentik users. Per-app credentials deferred (see below).
- **SMTP: plain on port 2525, no STARTTLS.** Trust boundary is the network
  (VLAN 30). TLS support deferred until needed (cert provisioning is the
  hard part, not the SMTP code).
- **Mailrise: not used.** notify-app is itself the SMTP server.
- **Install pattern: ProxmoxVE community-script style.** Single
  `bash -c "$(curl ...)"` line creates an unprivileged LXC, installs Node,
  builds, generates VAPID, writes `.env`, registers systemd unit. Follows
  LR's homelab patterns (startup order=3, unprivileged, NAS-free for now).
- **No PWA icons shipped.** Placeholder paths in `manifest.json`; LR to
  drop in art before launch.

## Feature backlog

### Admin role via `ADMIN_EMAILS` env (medium value, ~80 LOC)
Promote one or more Authentik users to admin by listing their emails in
`.env` (comma-separated, case-insensitive). No DB column needed — derived
at session resolution.

Plumbing:
- `config.adminEmails: Set<string>` parsed from `ADMIN_EMAILS` env
- `isAdmin(user)` helper
- `/api/me` returns `is_admin: boolean`
- Admin-only routes guarded with `if (!isAdmin(user)) return reply.code(403)`
- Frontend: body class `is-admin` toggles visibility of `.admin-only` sections
  via CSS; admin htmx triggers fired from client.js once `/api/me` resolves

Initial admin views (all read-only — mutation features come later):
- **Users**: list every user with email, display_name, device count, events
  in last 7d, last event timestamp. One query via subqueries on `users`.
- **System stats**: total users, total devices, events in last 24h,
  delivered vs unmatched (`no_user`) counts.
- **Unmatched events**: surface the `no_user` rows separately so admin can
  see "this app is sending to [email protected] but no user has that
  email" — common debugging case.

Later admin actions (deferred until needed):
- **Grant/revoke admin to other users.** This changes the design: env
  `ADMIN_EMAILS` becomes bootstrap-only, with in-DB grants overlaid on top.
  Either add `users.is_admin INTEGER` or a separate `admin_grants(user_sub,
  granted_by, granted_at)` table. Env-listed admins always-on (can't be
  revoked from the UI; preserves recovery path if DB gets wedged).
  `isAdmin(user)` checks `env_set ∪ db_grants`. UI: "make admin" / "revoke
  admin" buttons in the users list, with confirmation and audit trail in
  events table.
- **CRUD SMTP credentials across all users.** Depends on per-app
  credentials feature landing first. Admin can list, create, disable,
  delete any user's credentials. Useful for debugging ("which cred sent
  this?") and recovery ("user lost the secret, generate a new one").
  Creation on behalf of another user should be logged with `created_by`
  to keep the trail honest.
- **Mute / unmute on behalf of a user.** Admin can create or delete
  `mute` rules in any user's ruleset. Useful when a runaway app is
  spamming everyone and the admin wants to silence it system-wide
  before users individually rage-mute, or when a user asks for help.
  Depends on the rules-table `origin` column from the in-notification
  dismiss feature; add `admin_action` as a new origin value plus
  `created_by_admin TEXT` recording which admin acted. UI: in the admin
  user-list, each user row has a "view rules" expansion showing their
  current rules with delete buttons and an "add mute" form scoped to
  that user. The acted-on user gets a notification ("admin muted X" /
  "admin unmuted X") so it's transparent — they can undo from their own
  dashboard since the rule still belongs to them. System-wide mutes
  (mute X for ALL users at once) are a separate later feature; admin
  mute/unmute v1 acts on one user at a time.
- **See all events, not just own.** Cross-user event view (filter by
  user, date range, status). Privacy implications — surface clearly in
  the UI ("viewing as admin: [user@...]") and consider an audit row
  every time an admin views another user's events. Could be opt-in per
  user ("allow admins to see my events" toggle) for stricter privacy.
- **Cleanup / housekeeping actions.** Scope TBD; candidate buttons:
    - Purge events older than N days (with `keep_failed_for_longer` option)
    - Remove dead push subscriptions (already auto-pruned on 404/410,
      but a manual sweep helps when the auto-prune missed cases)
    - Delete inactive users (no login in N days) — with confirmation,
      cascades to subscriptions/rules/events via FK
    - Wipe a user's events (per-user reset, not full delete)
    - `VACUUM` the SQLite DB and report size before/after
      Each action confirms twice and writes an event row marking what was done.
- Disable a user (set a flag, block SMTP routing to them)
- Force-delete a user's devices/rules/events
- Send a broadcast push to all users (system-wide announcement)
- Export events as CSV/JSON

UX: separate "admin" tab/section above events, only rendered when
`is_admin`. Or `?admin` query param to hide by default even for admins
(reduces accidental access to others' data during normal use).

Install: prompt for `ADMIN_EMAILS` in `install.sh` (default to whatever
email the LR enters during OIDC setup).

### AI integration via Ollama (high value, ~80 LOC for v1)
LR already runs Ollama on the workstation RTX 4070 Ti, network-accessible
at `http://workstation:11434`. Email content stays local — fits the
privacy-first stack.

Config:
```
OLLAMA_URL=http://workstation:11434
OLLAMA_MODEL=llama3.2:3b              # small + fast, already loaded for Paperless-GPT
OLLAMA_MIN_BODY_CHARS=500             # skip AI for short emails
OLLAMA_TIMEOUT_MS=5000                # SMTP path can't wait forever
OLLAMA_MAX_CONCURRENCY=2              # share GPU politely with Paperless / Open WebUI
```

Single combined prompt does both summarization and relevance scoring:

```
You are an email triage assistant. Given an email, respond with JSON:
{ "relevant": boolean, "summary": "...", "reason": "..." }
- relevant: true if this is something a person would want to be notified about
  on their phone, false if it's automated noise (marketing, low-value
  system messages, bounce reports, etc.)
- summary: one sentence, max 140 chars, captures the actionable content
- reason: brief explanation of the relevance decision

Subject: {subject}
From: {from}
Body: {body[:4000]}
```

Output handling in `handleEmail`:
1. Call Ollama with `stream: false`, `format: "json"`, `AbortSignal.timeout(5s)`
2. On timeout / parse fail / Ollama down → fall back to current behavior
   (truncated body, send)
3. If `relevant: false` AND user opted in to AI filtering → log event with
   `status='ai_suppressed'`, `action_taken='ai_skip'`, store reason; do NOT
   send push
4. If `relevant: true` → use `summary` as push body, send normally

Concurrency: simple in-process semaphore (`p-limit` or hand-rolled) caps
concurrent Ollama calls so a burst of arriving emails doesn't starve other
GPU users (Paperless OCR, Open WebUI chat).

Escape valves (deterministic, applied before AI):
- Existing rules engine wins — if a user's rule matches, AI is skipped
  entirely (rules are explicit user intent)
- Optional keyword allowlist (`AI_BYPASS_PATTERNS=2fa|verification|otp|alert`)
  in `.env` — never suppress messages matching these regardless of AI
  verdict. Protects against AI false negatives on critical messages.
- Errors/timeouts always fall through to deliver. Never silently drop on
  AI failure.

User controls (per-user, in DB):
- `use_ai_summary` (bool) — default on
- `use_ai_filter` (bool) — default OFF (opt-in; missed notifications are
  worse than noisy ones for v1)
- AI suppressions still appear in the events list with a distinct status
  so user can review what was filtered and adjust trust over time

Privacy:
- Per-user "AI off" switch
- Optional regex skip list (`AI_SKIP_PATTERNS=password|reset|credit card`)
  to bypass the model entirely for sensitive content even when AI is on
- Logged events store the AI summary + reason, not the original body, by
  default

Future AI tasks (same Ollama integration, separate prompts):
- Auto-pick priority (urgent vs routine) instead of static rule
- Auto-pick a topic/tag from a user-defined list
- Entity extraction ("which host failed?", "which job?") for richer
  notification context
- Multi-message digest ("you got 12 notifications today, here are the 3
  that matter") — runs on a schedule, not per-message

Failure modes worth thinking through before building:
- Ollama crashes mid-batch → semaphore deadlock? Use timeout + AbortSignal
  on every call, never block forever
- Model returns invalid JSON → catch parse error, treat as "no opinion",
  fall through to default behavior
- Model hallucinations in `summary` → cap output length, validate it's a
  string, never trust the model for routing decisions (only for
  body-content suggestions)
- GPU OOM under load → Ollama returns 500; treat same as timeout

### In-notification "don't show this again" (high value, ~100 LOC)
The notification itself carries a "mute this" action. Tapping it creates
a mute rule for future messages of the same type, so the user never has
to open the dashboard to silence a noisy source. Mirrors the unsubscribe
pattern from email clients.

**Reuse the rules table** rather than a separate `dismissals` table —
a dismissal is just a `mute` rule that happened to be created via UI
gesture instead of explicit config. Add `origin TEXT` column to `rules`
(values: `user`, `dismiss_action`, `ai_learned`). Lets the dashboard
distinguish hand-written rules from auto-generated ones and offer "show
auto-mutes" filter.

**What counts as "the same type"?**

v1: match on `from` address — simple, deterministic, matches the user's
mental model of "stop notifications from this thing." When the dismiss
action fires, create a rule `from ~ /^<exact-sender>$/i → mute`.

v2 candidates:
- Match on `from` + first-N-chars of subject (for senders that send
  multiple unrelated streams from one address)
- Match on SMTP credential (after per-app creds land — cleanest, since
  one cred = one logical source)
- AI-assisted: ask Ollama "describe this message's category" and store
  that as the match key

**Trigger mechanism:**

Two paths, both wired:

1. **Action button on the notification** (fast path; Android/desktop reliable):
   ```js
   // payload includes:
   actions: [
     { action: 'mute-type', title: 'Mute this' },
     { action: 'open',      title: 'Open' }
   ]
   // sw.js notificationclick:
   if (event.action === 'mute-type') {
     await fetch('/api/dismiss', {
       method: 'POST',
       credentials: 'include',
       body: JSON.stringify({ event_id })
     });
     await self.registration.showNotification('Muted', {
       body: `No more from ${from}.`,
       tag: 'mute-confirm',  // replaces self on repeat mutes
     });
   }
   ```

2. **Deep link** (universal fallback for iOS PWAs and any platform where
   action buttons don't render):
   `https://notify.mgtd.net/event/<id>?action=mute` → server resolves
   event → creates rule → shows confirmation page with undo. Tap on the
   notification body (not an action) goes here.

iOS PWA caveat: notification action buttons render inconsistently on iOS
Safari PWAs. The deep-link path is the canonical UX on iOS; on Android/
desktop, the action button is the fast path with deep link as fallback.

**Auth on the dismiss endpoint:**
Service worker fetches carry session cookies by default with `credentials:
'include'`. No need for a signed token — the SW is running in the user's
authenticated origin. Server-side: verify session, verify the event
belongs to the requesting user, then create the rule.

**Confirmation feedback:**
After the mute is created, show a brief confirmation notification:
`Muted ${from}` with `tag: 'mute-confirm'` (replaces itself on repeated
mutes so the tray doesn't fill up). No undo button on the notification
itself.

**Recovery from accidental mute:**
User opens the notify app, goes to the rules list, deletes the rule.
Same flow as removing any other rule — no special "recently muted" undo
buffer, no time-window restoration logic. The events list shows when
each mute was created (with origin = `dismiss_action`) so the user can
find recent mistakes easily. Worth a UI affordance: filter rules by
"recently auto-created" so a misclick is easy to spot.

**TTL:**
v1: permanent mutes. v2: per-rule `expires_at` so user can "mute for 30
days" — useful for one-off noisy maintenance windows.

**Tie-in with AI filter (when it lands):**
Dismissals are training signal. If a user mutes from-address X three
times via different rule paths, the AI gets stronger evidence that
messages from X are uninteresting. Could later be promoted to "auto-mute
candidates" the user can confirm in bulk ("we noticed you keep muting
X — make it permanent?"). v1 doesn't need this; just store the
dismissals consistently so v2 has data to work with.

**Edge cases worth thinking through:**
- Same notification on multiple devices: action on device A should
  affect device B's future notifications. Server-side rule creation
  handles this (next push uses the new rule). The notification on
  device B doesn't retroactively disappear — Web Push has no "recall"
  primitive. Acceptable.
- User dismisses 2FA code accidentally: bypass patterns from AI section
  apply here too. Even if user mutes "from <auth provider>", the
  `AI_BYPASS_PATTERNS` deterministic allowlist still delivers.
  Or: forbid creating mute rules whose `from` matches the bypass list
  (with explanation in UI).
- Dismissal of a notification you sent yourself (test push, broadcast):
  fine, it's a normal mute. Maybe a special action label for those
  (test notifications could show "this was a test" instead of "mute").

### Per-app SMTP credentials (high value, ~120 LOC)
Discussed in chat. Lets users:
- Create named app credentials ("Proxmox", "Immich")
- Toggle on/off without touching the originating app
- Revoke without affecting other apps
- See per-app message count, last_used_at, error rate

Data model:
```
smtp_credentials (
  id            TEXT PK            -- "cred_aB3xK9..." (= SMTP username)
  user_sub      TEXT FK users
  name          TEXT
  password_hash TEXT               -- argon2
  enabled       INTEGER            -- 0/1
  created_at    INTEGER
  last_used_at  INTEGER
  message_count INTEGER
)
```

Routing precedence:
1. Authenticated credential → that credential's user
2. Unauthenticated → recipient-address routing (current behavior)
3. New `.env` flag `SMTP_REQUIRE_AUTH=1` disables fallback

UX: new "apps" section above events. Token shown once on creation.

Dependencies: add `argon2` (or `@node-rs/argon2`).

### Open items / ideas not yet discussed
*(LR to extend this list — placeholder)*

- ...
- ...

## Deferred / explicitly not doing

- **Mailrise integration** — redundant; notify-app speaks SMTP natively.
- **OIDC SSO via header forwardAuth** — notify-app does its own OIDC client
  flow; no benefit to also routing through Traefik forwardAuth.
- **STARTTLS now** — internal-VLAN only; revisit if SMTP exposure expands.
- **React/Vue frontend** — htmx is enough; revisit only if interactivity
  outgrows fragments.
- **Migration framework** — premature; `CREATE IF NOT EXISTS` is enough
  through ~v0.3.

## Open questions

- Should SMTP credentials authenticate with username = credential ID and
  password = secret token (preferred), or some other scheme?
- For shared/admin topics (Proxmox alerts, CrowdSec, etc.) — synthetic
  "admin" user, or first-class "groups" concept? Decide before adding
  per-app creds since it affects the data model.
- Web Push payload limit (~4 KB). Long emails get truncated to 200 chars
  in body. Do we need a "tap to view full message" path back to the app?
  Would require persisting message bodies, which we currently don't.

## Reference

- Web Push API: https://web.dev/push-notifications-overview/
- openid-client v5: https://github.com/panva/node-openid-client
- smtp-server API: https://nodemailer.com/extras/smtp-server/
- Fastify v5 hooks: https://fastify.dev/docs/latest/Reference/Hooks/

---
*Append-only style preferred — strike through outdated items rather than
deleting, so the reasoning trail stays intact.*