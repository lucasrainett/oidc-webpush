# oidc-webpush — Cleanup Report

> Audit of current files against BUILD.md spec. Everything listed below must be fixed.

---

## Files Already Cleaned

| File | Status |
|------|--------|
| `.gitignore` | ✅ Added `.idea/` and `pnpm-lock.yaml` |
| `.idea/` | ✅ Removed from tracking (IDE files) |
| `Dockerfile` | ✅ Removed (BUILD.md says no Docker) |
| `package-lock.json` | ✅ Removed (switching to pnpm) |
| `notes.md` | ✅ Restored (design log, kept) |

---

## Files That Need Changes

### 1. `package.json`

| Issue | Current | Should Be |
|-------|---------|-----------|
| name | `"notify-app"` | `"oidc-webpush"` |
| description | `"...with Authentik SSO"` | `"...with OIDC SSO"` (generic, not Authentik-specific) |
| engines.node | `"\u003e=20"` | `"\u003e=24"` |
| Missing dependency | — | Add `@node-rs/argon2` (or `argon2`) for credential hashing |
| scripts.gen-vapid | — | Keep; it is correct |

**Action**: Rewrite `package.json` to match BUILD.md §2.

---

### 2. `.env.example`

| Issue | Current | Should Be |
|-------|---------|-----------|
| Mentions Traefik | `# public URL behind Traefik` | Generic, no mention of specific proxy |
| SMTP auth comments | Mentions optional auth, `SMTP_AUTH_USER`/`SMTP_AUTH_PASS` | Remove these; SMTP now requires per-app credentials managed by admin |
| Mentions Authentik | `# Authentik OIDC` | Generic `# OIDC SSO` |
| Missing env vars | — | Add: `ADMIN_EMAILS`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `OLLAMA_MAX_CONCURRENCY`, `OLLAMA_QUEUE_TIMEOUT_MS`, `AI_BYPASS_PATTERNS`, `AI_SKIP_PATTERNS`, `AI_FILTER_DEFAULT` |
| DB_PATH | `./data/notify.db` | `./data/oidc-webpush.db` |

**Action**: Rewrite `.env.example` to match BUILD.md §5.

---

### 3. `install.sh`

| Issue | Current | Should Be |
|-------|---------|-----------|
| Name references | `notify-app` everywhere | `oidc-webpush` |
| App name | `APP="notify"` | `APP="oidc-webpush"` |
| Repo URL | `https://forge.mgtd.net/lr/notify-app.git` | Actual new repo URL (TBD) |
| Proxmox-specific | Creates LXC, uses `pct`, VLAN, `vmbr0` | Generic Linux installer for any distro |
| Node version | `NODE_MAJOR=22` | `24` |
| Package manager | `npm ci` | `pnpm install` |
| Missing update mode | Only install | Add update/upgrade flow (git pull + rebuild + migrate + restart) |
| Missing env prompts | `SMTP_AUTH_USER`/`SMTP_AUTH_PASS` (removed) | `ADMIN_EMAILS`, `OLLAMA_URL`, `AI_FILTER_DEFAULT` |
| Path | `/opt/notify` | `/opt/oidc-webpush` |

**Action**: Complete rewrite. See BUILD.md §14.

---

### 4. `README.md`

| Issue | Current | Should Be |
|-------|---------|-----------|
| Title | `# notify-app` | `# oidc-webpush` |
| Mentions Authentik | `with Authentik SSO` | `with OIDC SSO` |
| Install URL | `notify-app` path | `oidc-webpush` path |
| Proxmox-specific | Entire install section | Generic Linux install |
| Manual install | `npm ci` | `pnpm install` |
| Docker section | Present | Remove entirely |
| Architecture diagram | Says `notify-app` | Update to `oidc-webpush` |
| Traefik route example | Present | Remove; no reverse proxy configs shipped |

**Action**: Complete rewrite. Remove Docker, Traefik, Proxmox refs. Update to generic OIDC + pnpm.

---

### 5. `src/app.ts`

| Issue | Current | Should Be |
|-------|---------|-----------|
| File structure | Single 570-line monolith | Split into `config.ts`, `db.ts`, `types.ts`, `auth.ts`, `routes.ts`, `smtp.ts`, `push.ts`, `rules.ts`, `ai.ts`, `utils.ts` |
| Project name | Comments say `notify-app` | `oidc-webpush` |
| DB schema | Missing `schema_version`, `is_admin`, `enabled`, `app_name`, `user_prefs`, `smtp_credentials` | Full schema per BUILD.md §4 |
| Frontend assumption | Returns HTML fragments (`text/html`) from API | All API routes return JSON |
| SMTP auth | Optional global `SMTP_AUTH_USER`/`SMTP_AUTH_PASS` | Per-app credentials via `smtp_credentials` table; no unauthenticated fallback |
| Rules engine | No `enabled`, no `app_name` | Add both |
| Routing | Exact email + local-part fallback | Exact lowercase email only |
| AI integration | Not present | Add Ollama integration with semaphore |
| Admin features | Not present | Add `is_admin`, impersonation, admin-only routes |
| User prefs | Not present | Add `user_prefs` table |
| Push payload | Body truncated to 200 chars | AI summary up to 500 chars, or raw subject on fallback |

**Action**: Delete `src/app.ts`. Create the multi-file structure from BUILD.md §3.

---

### 6. `public/index.html`

| Issue | Current | Should Be |
|-------|---------|-----------|
| Title | `<title>notify</title>` | `<title>oidc-webpush</title>` |
| Brand name | `<span class="brand-name">notify</span>` | `oidc-webpush` |
| htmx CDN | `<script src="https://unpkg.com/[email protected]"` | **REMOVE** — vanilla JS only |
| htmx attributes | `hx-get`, `hx-post`, `hx-trigger`, `hx-target`, `hx-swap`, `hx-on::after-request` everywhere | Replace with vanilla JS event handlers or data attributes for client.js to bind |
| Events auto-refresh | `hx-trigger="load, every 15s"` | Manual refresh only; remove auto-polling |
| Footer text | `sso via authentik` | `sso via OIDC` |
| Admin UI | Not present | Add conditional sections for admin: Users list, Credentials manager, Unmatched events |
| App name field | Not present | Add `app_name` select to rule form |
| Rule enable toggle | Not present | Add toggle/checkbox for `enabled` |

**Action**: Complete rewrite. Remove all htmx. Add admin sections. Use vanilla JS bindings.

---

### 7. `public/client.js`

| Issue | Current | Should Be |
|-------|---------|-----------|
| htmx dependency | Relies on htmx for device list swap | Use vanilla `fetch()` + DOM updates for ALL sections |
| Devices update | Replaces `innerHTML` with HTML fragment from server response | Parse JSON response, build DOM nodes, replace list |
| Rules update | Not handled (htmx did it) | Add `fetch()` for GET/POST/DELETE rules, build DOM |
| Events update | Not handled (htmx did it) | Add `fetch()` with `?after=<id>`, append new events |
| Admin impersonation | Not present | Add dropdown to switch user view |
| Admin credential creation | Not present | Add modal for creating credentials (show token once) |
| Admin unmatched events | Not present | Add fetch/render for unmatched events |
| Admin user list | Not present | Add fetch/render for all users |
| Toast handling | Not present | Show toast div on test push response |
| Rule form app_name | Not present | Populate select from admin credentials |

**Action**: Complete rewrite. No htmx. Pure vanilla JS fetch + DOM manipulation.

---

### 8. `public/sw.js`

| Issue | Current | Should Be |
|-------|---------|-----------|
| Comments | `notify-app service worker` | `oidc-webpush service worker` |
| Default title | `'notify'` | `'oidc-webpush'` |
| Notification actions | Only `open` action | Add `mute-type` action button |
| notificationclick | Only opens window | Handle `mute-type` action: POST to `/api/rules` to create mute rule |
| Mute confirmation | Not present | After creating mute rule, show confirmation notification |

**Action**: Update comments, title, add mute action to notificationclick.

---

### 9. `public/manifest.json`

| Issue | Current | Should Be |
|-------|---------|-----------|
| name | `"notify"` | `"oidc-webpush"` |
| short_name | `"notify"` | `"oidc-webpush"` |
| description | `"Self-hosted email-to-push notification gateway"` | `"Self-hosted email-to-push notification gateway with OIDC SSO"` |

**Action**: Update name/description fields.

---

### 10. `public/style.css`

| Issue | Current | Should Be |
|-------|---------|-----------|
| External font import | `@import url('https://fonts.googleapis.com/...')` | **Remove** — self-host fonts or use system fonts only (BUILD.md says no external dependencies) |
| Font stack | JetBrains Mono, Inter Tight | Keep the font-family declarations; if Google Fonts removed, fall back to system fonts already declared |
| Admin styles | Not present | Add `.admin-only` section styles, impersonation banner styles, credential table styles |
| Toast styles | Present | Keep; add `.toast.ok`/`.warn`/`.err` |
| Event grid | Present | Keep; may need adjustment for JSON-rendered content |

**Action**: Remove Google Fonts `@import`. Ensure system font fallbacks work. Add admin UI styles.

---

### 11. `tsconfig.json`

| Issue | Current | Should Be |
|-------|---------|-----------|
| `noUncheckedIndexedAccess` | `false` (explicit) | Remove the line (default is false, but BUILD.md doesn't mention it) |
| Overall | Mostly correct | Matches BUILD.md §2; keep as-is |

**Action**: Minor cleanup. Remove `noUncheckedIndexedAccess` line if present.

---

## New Files That Must Be Created

| File | Purpose |
|------|---------|
| `src/config.ts` | Env var parsing, validation, defaults |
| `src/db.ts` | SQLite connection, schema creation, migrations, query helpers |
| `src/types.ts` | TypeScript interfaces |
| `src/auth.ts` | OIDC client setup, login/callback/logout handlers |
| `src/routes.ts` | All HTTP API routes (Fastify) |
| `src/smtp.ts` | SMTPServer setup, onAuth, onData |
| `src/push.ts` | web-push wrapper, sendPush, auto-prune |
| `src/rules.ts` | evalRules() engine |
| `src/ai.ts` | Ollama integration, prompt, semaphore, bypass patterns |
| `src/utils.ts` | esc(), relTime(), etc. |
| `pnpm-lock.yaml` | Will be generated by pnpm |

---

## Files That Are OK (Keep As-Is for Now)

| File | Notes |
|------|-------|
| `tsconfig.json` | Minor cleanup only |
| `notes.md` | Design log, keep |
| `BUILD.md` | Spec document, keep |
| `CONFIRM.md` | Historical, keep or archive |
| `OPEN_ITEMS.md` | Historical, keep or archive |

---

## Recommended Order of Work

1. Fix `package.json` (name, engines, add argon2)
2. Fix `.env.example` (new vars, rename db)
3. Delete `src/app.ts` and create new `src/*.ts` files
4. Rewrite `public/index.html` (no htmx, add admin sections)
5. Rewrite `public/client.js` (vanilla JS)
6. Update `public/sw.js` (add mute action)
7. Update `public/manifest.json` (name)
8. Update `public/style.css` (remove Google Fonts, add admin styles)
9. Rewrite `install.sh` (generic Linux, pnpm, update mode)
10. Rewrite `README.md` (generic, no Docker/Traefik/Proxmox)
11. Run `pnpm install` to generate lockfile
12. Test build with `pnpm run build`
