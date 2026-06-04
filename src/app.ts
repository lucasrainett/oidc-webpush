/**
 * notify-app — SSO push notification service
 *
 * Single-file server: Fastify (HTTP/UI) + smtp-server (ingress) + web-push (delivery)
 * + better-sqlite3 (persistence) + openid-client (Authentik SSO).
 *
 * Returns HTML fragments for htmx swaps; full page lives in public/index.html.
 */

import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { Issuer, generators } from 'openid-client';
import { SMTPServer } from 'smtp-server';
import { simpleParser, ParsedMail } from 'mailparser';
import webpush from 'web-push';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const config = {
  baseUrl: required('BASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  smtpPort: Number(process.env.SMTP_PORT ?? 2525),
  smtpHost: process.env.SMTP_HOST ?? '0.0.0.0',
  smtpAuthUser: process.env.SMTP_AUTH_USER,
  smtpAuthPass: process.env.SMTP_AUTH_PASS,
  oidc: {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
  },
  vapid: {
    public: required('VAPID_PUBLIC'),
    private: required('VAPID_PRIVATE'),
    subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
  },
  cookieSecret: required('COOKIE_SECRET'),
  dbPath: process.env.DB_PATH ?? './data/notify.db',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    sub          TEXT PRIMARY KEY,
    email        TEXT UNIQUE NOT NULL,
    display_name TEXT,
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
    match_field   TEXT NOT NULL,
    match_pattern TEXT NOT NULL,
    action        TEXT NOT NULL,
    action_value  TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_events_user   ON events(user_sub, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_user    ON rules(user_sub, position);
  CREATE INDEX IF NOT EXISTS idx_subs_user     ON subscriptions(user_sub);
`);

interface User { sub: string; email: string; display_name: string | null; created_at: number; }
interface Subscription { id: string; user_sub: string; endpoint: string; p256dh: string; auth: string; user_agent: string | null; created_at: number; last_seen: number; }
interface Rule { id: string; user_sub: string; position: number; match_field: 'from' | 'subject' | 'body'; match_pattern: string; action: 'mute' | 'priority' | 'tag'; action_value: string | null; created_at: number; }
interface Event { id: number; ts: number; user_sub: string | null; from_addr: string | null; to_addr: string | null; subject: string | null; matched_rule: string | null; action_taken: string | null; delivered_count: number; failed_count: number; status: string; }
interface Session { sid: string; user_sub: string; created_at: number; expires_at: number; }

const q = {
  upsertUser: db.prepare(`
    INSERT INTO users (sub, email, display_name, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name
  `),
  userBySub: db.prepare('SELECT * FROM users WHERE sub = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)'),
  allUsers: db.prepare('SELECT * FROM users'),

  upsertSub: db.prepare(`
    INSERT INTO subscriptions (id, user_sub, endpoint, p256dh, auth, user_agent, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET last_seen = excluded.last_seen, user_agent = excluded.user_agent
  `),
  listSubs: db.prepare('SELECT * FROM subscriptions WHERE user_sub = ? ORDER BY created_at DESC'),
  delSub: db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_sub = ?'),
  delSubByEndpoint: db.prepare('DELETE FROM subscriptions WHERE endpoint = ?'),

  insertRule: db.prepare(`
    INSERT INTO rules (id, user_sub, position, match_field, match_pattern, action, action_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listRules: db.prepare('SELECT * FROM rules WHERE user_sub = ? ORDER BY position ASC'),
  delRule: db.prepare('DELETE FROM rules WHERE id = ? AND user_sub = ?'),

  insertEvent: db.prepare(`
    INSERT INTO events (ts, user_sub, from_addr, to_addr, subject, matched_rule, action_taken, delivered_count, failed_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listEvents: db.prepare('SELECT * FROM events WHERE user_sub = ? ORDER BY ts DESC LIMIT ?'),

  createSession: db.prepare('INSERT INTO sessions (sid, user_sub, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE sid = ? AND expires_at > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Web Push
// ─────────────────────────────────────────────────────────────────────────────

webpush.setVapidDetails(config.vapid.subject, config.vapid.public, config.vapid.private);

async function sendPush(sub: Subscription, payload: object): Promise<{ ok: boolean; statusCode?: number }> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err: any) {
    // 404/410 = endpoint gone, prune it
    if (err.statusCode === 404 || err.statusCode === 410) {
      q.delSubByEndpoint.run(sub.endpoint);
    }
    return { ok: false, statusCode: err.statusCode };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules engine
// ─────────────────────────────────────────────────────────────────────────────

interface EmailCtx { from: string; subject: string; body: string; }

function evalRules(rules: Rule[], email: EmailCtx): Rule | null {
  for (const r of rules) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Email handler
// ─────────────────────────────────────────────────────────────────────────────

function resolveUserFromRecipient(recipient: string): User | null {
  // 1. exact email match
  const exact = q.userByEmail.get(recipient) as User | undefined;
  if (exact) return exact;
  // 2. local-part match (so [email protected] routes to user whose email's local part is "alice")
  const local = recipient.split('@')[0].toLowerCase();
  const users = q.allUsers.all() as User[];
  return users.find(u => u.email.split('@')[0].toLowerCase() === local) ?? null;
}

async function handleEmail(parsed: ParsedMail, recipient: string): Promise<void> {
  const from = parsed.from?.text ?? '';
  const subject = parsed.subject ?? '(no subject)';
  const body = parsed.text ?? (parsed.html ? String(parsed.html) : '');

  const user = resolveUserFromRecipient(recipient);

  if (!user) {
    q.insertEvent.run(Date.now(), null, from, recipient, subject, null, null, 0, 0, 'no_user');
    return;
  }

  const rules = q.listRules.all(user.sub) as Rule[];
  const matched = evalRules(rules, { from, subject, body });

  if (matched?.action === 'mute') {
    q.insertEvent.run(Date.now(), user.sub, from, recipient, subject, matched.id, 'mute', 0, 0, 'muted');
    return;
  }

  const subs = q.listSubs.all(user.sub) as Subscription[];
  const payload = {
    title: subject.slice(0, 100),
    body: body.replace(/\s+/g, ' ').trim().slice(0, 200),
    from,
    priority: matched?.action === 'priority' ? Number(matched.action_value) || 3 : 3,
    tag: matched?.action === 'tag' ? matched.action_value : null,
    ts: Date.now(),
  };

  let delivered = 0, failed = 0;
  await Promise.all(subs.map(async s => {
    const r = await sendPush(s, payload);
    if (r.ok) delivered++; else failed++;
  }));

  q.insertEvent.run(
    Date.now(), user.sub, from, recipient, subject,
    matched?.id ?? null, matched?.action ?? null,
    delivered, failed,
    subs.length === 0 ? 'no_devices' : delivered > 0 ? 'delivered' : 'failed',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML fragment renderers (for htmx swaps)
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function renderDevices(subs: Subscription[]): string {
  if (subs.length === 0) {
    return `<div class="empty">no devices enrolled · click "enable on this device" below</div>`;
  }
  return subs.map(s => `
    <div class="row">
      <span class="device-ua">${esc(s.user_agent ?? 'unknown')}</span>
      <span class="meta">${relTime(s.last_seen)}</span>
      <button class="ghost" hx-delete="/api/devices/${esc(s.id)}" hx-target="#devices" hx-confirm="Remove this device?">remove</button>
    </div>`).join('');
}

function renderRules(rules: Rule[]): string {
  if (rules.length === 0) {
    return `<div class="empty">no rules · all emails pass through with default priority</div>`;
  }
  return rules.map(r => {
    const av = r.action_value ? ` <span class="action-value">${esc(r.action_value)}</span>` : '';
    return `<div class="row">
      <span class="rule-expr"><code>${esc(r.match_field)}</code> ~ <code>/${esc(r.match_pattern)}/</code> → <span class="action-${esc(r.action)}">${esc(r.action)}</span>${av}</span>
      <button class="ghost" hx-delete="/api/rules/${esc(r.id)}" hx-target="#rules" hx-confirm="Delete this rule?">delete</button>
    </div>`;
  }).join('');
}

function renderEvents(events: Event[]): string {
  if (events.length === 0) {
    return `<div class="empty">no events yet</div>`;
  }
  return events.map(e => `
    <div class="row event status-${esc(e.status)}">
      <span class="ts">${esc(new Date(e.ts).toLocaleString())}</span>
      <span class="from">${esc((e.from_addr ?? '').slice(0, 32))}</span>
      <span class="subject">${esc((e.subject ?? '').slice(0, 64))}</span>
      <span class="status-pill">${esc(e.status)} · ${e.delivered_count}/${e.delivered_count + e.failed_count}</span>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fastify app
// ─────────────────────────────────────────────────────────────────────────────

interface AuthedRequest extends FastifyRequest { user: User; }

async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(fastifyCookie, { secret: config.cookieSecret });
  await app.register(fastifyFormbody);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // ── OIDC discovery + client ─────────────────────────────────────────────
  const issuer = await Issuer.discover(config.oidc.issuer);
  const client = new issuer.Client({
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    redirect_uris: [`${config.baseUrl}/auth/callback`],
    response_types: ['code'],
  });

  // in-memory PKCE/state store, scoped to a short-lived cookie
  const oidcStates = new Map<string, { state: string; nonce: string; codeVerifier: string; ts: number }>();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of oidcStates) if (v.ts < cutoff) oidcStates.delete(k);
  }, 60_000).unref();

  // ── Auth routes ─────────────────────────────────────────────────────────
  app.get('/auth/login', async (_req, reply) => {
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    const key = randomUUID();
    oidcStates.set(key, { state, nonce, codeVerifier, ts: Date.now() });

    reply.setCookie('oidc_state', key, {
      httpOnly: true, secure: config.baseUrl.startsWith('https'), sameSite: 'lax', path: '/', maxAge: 600,
    });

    const url = client.authorizationUrl({
      scope: 'openid profile email',
      state, nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (req, reply) => {
    const key = req.cookies.oidc_state;
    if (!key) return reply.code(400).send('missing state cookie');
    const stored = oidcStates.get(key);
    if (!stored) return reply.code(400).send('invalid state');
    oidcStates.delete(key);

    try {
      const params = client.callbackParams(req.raw);
      const tokenSet = await client.callback(`${config.baseUrl}/auth/callback`, params, {
        state: stored.state, nonce: stored.nonce, code_verifier: stored.codeVerifier,
      });
      const claims = tokenSet.claims();
      const sub = String(claims.sub);
      const email = String(claims.email ?? '');
      const name = String(claims.name ?? claims.preferred_username ?? email);
      if (!email) return reply.code(400).send('email claim missing from id_token');

      q.upsertUser.run(sub, email, name, Date.now());
      const sid = randomUUID();
      const now = Date.now();
      q.createSession.run(sid, sub, now, now + 7 * 86_400_000);

      reply.clearCookie('oidc_state', { path: '/' });
      reply.setCookie('sid', sid, {
        httpOnly: true, secure: config.baseUrl.startsWith('https'), sameSite: 'lax', path: '/', maxAge: 7 * 86_400,
      });
      return reply.redirect('/');
    } catch (err) {
      req.log.error({ err }, 'oidc callback failed');
      return reply.code(400).send('authentication failed');
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies.sid;
    if (sid) q.delSession.run(sid);
    reply.clearCookie('sid', { path: '/' });
    return reply.redirect('/');
  });

  // ── auth gate ───────────────────────────────────────────────────────────
  const PUBLIC_PATHS = new Set(['/manifest.json', '/sw.js', '/client.js', '/style.css', '/favicon.ico', '/healthz']);

  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/auth/') || PUBLIC_PATHS.has(req.url) || req.url.startsWith('/icons/')) return;

    const sid = req.cookies.sid;
    const session = sid ? (q.getSession.get(sid, Date.now()) as Session | undefined) : undefined;
    if (!session) {
      if (req.url === '/' || req.url === '') return reply.redirect('/auth/login');
      return reply.code(401).send('unauthorized');
    }
    const user = q.userBySub.get(session.user_sub) as User | undefined;
    if (!user) return reply.code(401).send('user not found');
    (req as AuthedRequest).user = user;
  });

  // ── routes ──────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/vapid-public-key', async (_req, reply) => {
    return reply.type('text/plain').send(config.vapid.public);
  });

  app.get('/api/me', async (req) => {
    const u = (req as AuthedRequest).user;
    return { email: u.email, display_name: u.display_name };
  });

  app.get('/api/devices', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    return reply.type('text/html').send(renderDevices(q.listSubs.all(u.sub) as Subscription[]));
  });

  app.post('/api/subscribe', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const body = req.body as { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string };
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return reply.code(400).send('invalid subscription');
    }
    const now = Date.now();
    q.upsertSub.run(nanoid(12), u.sub, body.endpoint, body.keys.p256dh, body.keys.auth, body.userAgent ?? null, now, now);
    return reply.type('text/html').send(renderDevices(q.listSubs.all(u.sub) as Subscription[]));
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const { id } = req.params as { id: string };
    q.delSub.run(id, u.sub);
    return reply.type('text/html').send(renderDevices(q.listSubs.all(u.sub) as Subscription[]));
  });

  app.get('/api/rules', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    return reply.type('text/html').send(renderRules(q.listRules.all(u.sub) as Rule[]));
  });

  app.post('/api/rules', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const body = req.body as { match_field: string; match_pattern: string; action: string; action_value?: string };
    if (!['from', 'subject', 'body'].includes(body.match_field)) return reply.code(400).send('bad field');
    if (!['mute', 'priority', 'tag'].includes(body.action)) return reply.code(400).send('bad action');
    if (!body.match_pattern?.trim()) return reply.code(400).send('empty pattern');

    const existing = q.listRules.all(u.sub) as Rule[];
    q.insertRule.run(
      nanoid(12), u.sub, existing.length,
      body.match_field, body.match_pattern.trim(),
      body.action, body.action_value?.trim() || null,
      Date.now(),
    );
    return reply.type('text/html').send(renderRules(q.listRules.all(u.sub) as Rule[]));
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const { id } = req.params as { id: string };
    q.delRule.run(id, u.sub);
    return reply.type('text/html').send(renderRules(q.listRules.all(u.sub) as Rule[]));
  });

  app.get('/api/events', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    return reply.type('text/html').send(renderEvents(q.listEvents.all(u.sub, 50) as Event[]));
  });

  app.post('/api/test', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const subs = q.listSubs.all(u.sub) as Subscription[];
    if (subs.length === 0) {
      return reply.type('text/html').send(`<div class="toast warn">no devices enrolled</div>`);
    }
    let delivered = 0;
    await Promise.all(subs.map(async s => {
      const r = await sendPush(s, { title: 'Test notification', body: `Hello ${u.display_name ?? u.email}, push is working.`, ts: Date.now() });
      if (r.ok) delivered++;
    }));
    q.insertEvent.run(Date.now(), u.sub, '[test]', u.email, 'Test notification', null, 'test', delivered, subs.length - delivered, 'test');
    return reply.type('text/html').send(`<div class="toast ok">sent to ${delivered}/${subs.length} device(s)</div>`);
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMTP server
// ─────────────────────────────────────────────────────────────────────────────

function startSmtp() {
  const requireAuth = !!config.smtpAuthUser;
  const server = new SMTPServer({
    authOptional: !requireAuth,
    disabledCommands: requireAuth ? ['STARTTLS'] : ['AUTH', 'STARTTLS'],
    onAuth(auth, _session, cb) {
      if (!requireAuth) return cb(null, { user: 'anonymous' });
      if (auth.username === config.smtpAuthUser && auth.password === config.smtpAuthPass) {
        return cb(null, { user: auth.username });
      }
      return cb(new Error('invalid credentials'));
    },
    async onData(stream, session, cb) {
      try {
        const parsed = await simpleParser(stream);
        for (const rcpt of session.envelope.rcptTo) {
          try { await handleEmail(parsed, rcpt.address); }
          catch (err) { console.error('handleEmail error', err); }
        }
        cb();
      } catch (err: any) {
        cb(err);
      }
    },
  });
  server.listen(config.smtpPort, config.smtpHost, () => {
    console.log(`SMTP listening on ${config.smtpHost}:${config.smtpPort}`);
  });
  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

// nightly session cleanup
setInterval(() => q.cleanSessions.run(Date.now()), 60 * 60_000).unref();

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
startSmtp();

const shutdown = async (sig: string) => {
  console.log(`received ${sig}, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
