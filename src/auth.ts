/** oidc-webpush — OIDC authentication */

import { randomUUID } from 'node:crypto';
import { Issuer, generators } from 'openid-client';
import { config } from './config.js';
import { db, queries, isEnvAdmin } from './db.js';
import type { User } from './types.js';

export interface OidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  ts: number;
}

export const oidcStates = new Map<string, OidcState>();

// cleanup old states every minute
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of oidcStates) {
    if (v.ts < cutoff) oidcStates.delete(k);
  }
}, 60_000);

let _issuer: Issuer | null = null;
let _client: any = null;

export async function getOidcClient() {
  if (_client) return _client;
  _issuer = await Issuer.discover(config.oidc.issuer);
  _client = new (_issuer as any).Client({
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    redirect_uris: [`${config.baseUrl}/auth/callback`],
    response_types: ['code'],
  });
  return _client;
}

export function createOidcState(): { key: string; state: string; nonce: string; codeChallenge: string } {
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const key = randomUUID();
  oidcStates.set(key, { state, nonce, codeVerifier, ts: Date.now() });
  return { key, state, nonce, codeChallenge };
}

export function getOidcState(key: string): OidcState | undefined {
  return oidcStates.get(key);
}

export function deleteOidcState(key: string): void {
  oidcStates.delete(key);
}

export function upsertUserFromClaims(claims: {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}): User {
  const sub = String(claims.sub);
  const email = String(claims.email ?? '');
  const displayName = String(claims.name ?? claims.preferred_username ?? email);
  const now = Date.now();

  const existing = queries.userBySub.get(sub) as User | undefined;
  const isAdmin = existing?.is_admin === 1 || isEnvAdmin(email) ? 1 : 0;

  queries.upsertUser.run(sub, email, displayName, isAdmin, now);
  return queries.userBySub.get(sub) as User;
}

export function createSession(userSub: string): string {
  const sid = randomUUID();
  const now = Date.now();
  queries.createSession.run(sid, userSub, now, now + 7 * 86_400_000);
  return sid;
}

export function getSession(sid: string) {
  return queries.getSession.get(sid, Date.now()) as { user_sub: string; expires_at: number } | undefined;
}

export function destroySession(sid: string): void {
  queries.delSession.run(sid);
}

// session cleanup every hour
setInterval(() => {
  queries.cleanSessions.run(Date.now());
}, 3600_000);
