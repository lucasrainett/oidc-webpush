/** oidc-webpush — database layer */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type { User, Subscription, Rule, Event, Session, SmtpCredential } from './types.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
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
    endpoint    TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    UNIQUE(user_sub, endpoint)
  );

  CREATE TABLE IF NOT EXISTS rules (
    id            TEXT PRIMARY KEY,
    user_sub      TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    match_field   TEXT NOT NULL,
    match_pattern TEXT NOT NULL,
    action        TEXT NOT NULL,
    action_value  TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    app_name      TEXT,
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
    user_sub   TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, key)
  );

  CREATE TABLE IF NOT EXISTS smtp_credentials (
    id            TEXT PRIMARY KEY,
    user_sub      TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0,
    error_count   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_sub, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_user   ON rules(user_sub, position);
  CREATE INDEX IF NOT EXISTS idx_subs_user    ON subscriptions(user_sub);
`);

// ── Migration bootstrap ─────────────────────────────────────────────────────

const currentVersion = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
const version = currentVersion?.v ?? 0;

if (version < 1) {
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, Date.now());
}

if (version < 2) {
  // Migrate subscriptions: drop old UNIQUE(endpoint), add UNIQUE(user_sub, endpoint)
  db.exec(`
    CREATE TABLE subscriptions_new (
      id          TEXT PRIMARY KEY,
      user_sub    TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
      endpoint    TEXT NOT NULL,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      user_agent  TEXT,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      UNIQUE(user_sub, endpoint)
    );
    INSERT INTO subscriptions_new SELECT * FROM subscriptions;
    DROP TABLE subscriptions;
    ALTER TABLE subscriptions_new RENAME TO subscriptions;
    CREATE INDEX idx_subs_user ON subscriptions(user_sub);
  `);
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, Date.now());
}

// ── Prepared Statements ───────────────────────────────────────────────────

export const queries = {
  // Users
  upsertUser: db.prepare(`
    INSERT INTO users (sub, email, display_name, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sub) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name
  `),
  userBySub: db.prepare('SELECT * FROM users WHERE sub = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)'),
  allUsers: db.prepare('SELECT * FROM users'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE sub = ?'),

  // Subscriptions
  upsertSub: db.prepare(`
    INSERT INTO subscriptions (id, user_sub, endpoint, p256dh, auth, user_agent, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_sub, endpoint) DO UPDATE SET
      last_seen = excluded.last_seen,
      user_agent = excluded.user_agent
  `),
  listSubs: db.prepare('SELECT * FROM subscriptions WHERE user_sub = ? ORDER BY created_at DESC'),
  delSub: db.prepare('DELETE FROM subscriptions WHERE id = ? AND user_sub = ?'),
  delSubByEndpoint: db.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND user_sub = ?'),

  // Rules
  insertRule: db.prepare(`
    INSERT INTO rules (id, user_sub, position, match_field, match_pattern, action, action_value, enabled, app_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listRules: db.prepare('SELECT * FROM rules WHERE user_sub = ? ORDER BY position ASC'),
  getRuleById: db.prepare('SELECT * FROM rules WHERE id = ? AND user_sub = ?'),
  delRule: db.prepare('DELETE FROM rules WHERE id = ? AND user_sub = ?'),
  toggleRule: db.prepare('UPDATE rules SET enabled = ? WHERE id = ? AND user_sub = ?'),
  shiftRulePositions: db.prepare('UPDATE rules SET position = position - 1 WHERE user_sub = ? AND position > ?'),

  // Events
  insertEvent: db.prepare(`
    INSERT INTO events (ts, user_sub, from_addr, to_addr, subject, matched_rule, action_taken, delivered_count, failed_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  listEvents: db.prepare('SELECT * FROM events WHERE user_sub = ? AND id > ? ORDER BY ts DESC LIMIT ?'),
  listAllEvents: db.prepare('SELECT * FROM events WHERE user_sub = ? ORDER BY ts DESC LIMIT ?'),
  listUnmatchedEvents: db.prepare("SELECT * FROM events WHERE status = 'no_user' ORDER BY ts DESC LIMIT ?"),
  countEvents7d: db.prepare('SELECT COUNT(*) as c FROM events WHERE user_sub = ? AND ts > ?'),
  lastEventTs: db.prepare('SELECT MAX(ts) as ts FROM events WHERE user_sub = ?'),

  // Sessions
  createSession: db.prepare('INSERT INTO sessions (sid, user_sub, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE sid = ? AND expires_at > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  // User prefs
  getPref: db.prepare('SELECT value FROM user_prefs WHERE user_sub = ? AND key = ?'),
  setPref: db.prepare(`
    INSERT INTO user_prefs (user_sub, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_sub, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),

  // SMTP credentials
  insertCredential: db.prepare(`
    INSERT INTO smtp_credentials (id, user_sub, name, password_hash, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getCredentialById: db.prepare('SELECT * FROM smtp_credentials WHERE id = ?'),
  listCredentials: db.prepare('SELECT * FROM smtp_credentials WHERE user_sub = ? ORDER BY created_at DESC'),
  listAllCredentials: db.prepare('SELECT * FROM smtp_credentials ORDER BY created_at DESC'),
  updateCredentialStats: db.prepare('UPDATE smtp_credentials SET last_used_at = ?, message_count = message_count + 1 WHERE id = ?'),
  incrementCredentialError: db.prepare('UPDATE smtp_credentials SET error_count = error_count + 1 WHERE id = ?'),
  toggleCredential: db.prepare('UPDATE smtp_credentials SET enabled = ? WHERE id = ?'),
  delCredential: db.prepare('DELETE FROM smtp_credentials WHERE id = ?'),
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getUserPref(userSub: string, key: string, defaultValue: string): string {
  const row = queries.getPref.get(userSub, key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setUserPref(userSub: string, key: string, value: string): void {
  queries.setPref.run(userSub, key, value, Date.now());
}

export function isEnvAdmin(email: string): boolean {
  return config.adminEmails.has(email.toLowerCase());
}
