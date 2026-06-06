/** oidc-webpush — HTTP API routes */

import { randomUUID } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { nanoid } from 'nanoid';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';
import { db, queries, getUserPref, setUserPref, isEnvAdmin } from './db.js';
import {
  getOidcClient,
  createOidcState,
  getOidcState,
  deleteOidcState,
  upsertUserFromClaims,
  createSession,
  getSession,
  destroySession,
} from './auth.js';
import { sendPush } from './push.js';
import type { User, Subscription, Rule } from './types.js';

interface AuthedRequest extends FastifyRequest {
  user: User;
}

const PUBLIC_PATHS = new Set([
  '/manifest.json', '/sw.js', '/client.js', '/style.css',
  '/favicon.ico', '/healthz',
]);

export async function registerRoutes(app: FastifyInstance) {
  // ── Auth gate ─────────────────────────────────────────────────────────────
  app.addHook('preHandler', async (req, reply) => {
    if (req.url.startsWith('/auth/') || PUBLIC_PATHS.has(req.url) || req.url.startsWith('/icons/')) return;

    const sid = req.cookies.sid;
    const session = sid ? (getSession(sid)) : undefined;
    if (!session) {
      if (req.method === 'GET' && (req.url === '/' || req.url === '')) return reply.redirect('/auth/login');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const user = queries.userBySub.get(session.user_sub) as User | undefined;
    if (!user) return reply.code(401).send({ error: 'user not found' });

    // admin impersonation (skip for admin API routes so admin can manage)
    const impersonating = req.cookies.impersonate;
    if (impersonating && user.is_admin && !req.url.startsWith('/api/admin/')) {
      const target = queries.userBySub.get(impersonating) as User | undefined;
      if (target) {
        (req as AuthedRequest).user = target;
        (req as any)._realUser = user;
        return;
      }
    }
    (req as AuthedRequest).user = user;
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── VAPID key ─────────────────────────────────────────────────────────────
  app.get('/api/vapid-public-key', async (_req, reply) => {
    return reply.type('text/plain').send(config.vapid.public);
  });

  // ── Auth routes ───────────────────────────────────────────────────────────
  app.get('/auth/login', async (_req, reply) => {
    const client = await getOidcClient();
    const { key, state, nonce, codeChallenge } = createOidcState();
    reply.setCookie('oidc_state', key, {
      httpOnly: true,
      secure: config.baseUrl.startsWith('https'),
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
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
    if (!key) return reply.code(400).send({ error: 'missing state cookie' });
    const stored = getOidcState(key);
    if (!stored) return reply.code(400).send({ error: 'invalid state' });
    deleteOidcState(key);

    try {
      const client = await getOidcClient();
      const params = client.callbackParams(req.raw);
      const tokenSet = await client.callback(`${config.baseUrl}/auth/callback`, params, {
        state: stored.state, nonce: stored.nonce, code_verifier: stored.codeVerifier,
      });
      const claims = tokenSet.claims();
      const email = String(claims.email ?? '');
      if (!email) return reply.code(400).send({ error: 'email claim missing' });

      const user = upsertUserFromClaims(claims);
      const sid = createSession(user.sub);
      reply.setCookie('oidc_state', '', {
        path: '/',
        httpOnly: true,
        secure: config.baseUrl.startsWith('https'),
        sameSite: 'lax',
        expires: new Date(0),
      });
      reply.setCookie('sid', sid, {
        httpOnly: true,
        secure: config.baseUrl.startsWith('https'),
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 86_400,
      });
      return reply.redirect('/');
    } catch (err) {
      req.log.error({ err }, 'oidc callback failed');
      return reply.code(400).send({ error: 'authentication failed' });
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies.sid;
    if (sid) destroySession(sid);
    const cookieOpts = {
      path: '/',
      httpOnly: true,
      secure: config.baseUrl.startsWith('https'),
      sameSite: 'lax' as const,
      expires: new Date(0),
    };
    reply.setCookie('sid', '', cookieOpts);
    reply.setCookie('impersonate', '', cookieOpts);
    return reply.redirect('/');
  });

  // ── User ──────────────────────────────────────────────────────────────────
  app.get('/api/me', async (req) => {
    const u = (req as AuthedRequest).user;
    const realUser = (req as any)._realUser as User | undefined;
    return {
      sub: u.sub,
      email: u.email,
      display_name: u.display_name,
      is_admin: u.is_admin === 1,
      impersonating: realUser ? { email: realUser.email, display_name: realUser.display_name } : null,
      smtp_endpoint: config.smtpEndpoint,
    };
  });

  // ── Devices ───────────────────────────────────────────────────────────────
  app.get('/api/devices', async (req) => {
    const u = (req as AuthedRequest).user;
    return queries.listSubs.all(u.sub) as Subscription[];
  });

  app.post('/api/subscribe', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const body = req.body as { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string };
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    const now = Date.now();
    queries.upsertSub.run(nanoid(12), u.sub, body.endpoint, body.keys.p256dh, body.keys.auth, body.userAgent ?? null, now, now);
    return queries.listSubs.all(u.sub) as Subscription[];
  });

  app.delete('/api/devices/:id', async (req) => {
    const u = (req as AuthedRequest).user;
    const { id } = req.params as { id: string };
    queries.delSub.run(id, u.sub);
    return queries.listSubs.all(u.sub) as Subscription[];
  });

  // ── Rules ─────────────────────────────────────────────────────────────────
  app.get('/api/rules', async (req) => {
    const u = (req as AuthedRequest).user;
    return queries.listRules.all(u.sub) as Rule[];
  });

  app.post('/api/rules', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const body = req.body as { match_field: string; match_pattern: string; action: string; action_value?: string; app_name?: string; enabled?: boolean };
    if (!['from', 'subject', 'body'].includes(body.match_field)) return reply.code(400).send({ error: 'bad field' });
    if (!['mute', 'priority', 'tag'].includes(body.action)) return reply.code(400).send({ error: 'bad action' });
    if (!body.match_pattern?.trim()) return reply.code(400).send({ error: 'empty pattern' });

    const existing = queries.listRules.all(u.sub) as Rule[];
    queries.insertRule.run(
      nanoid(12), u.sub, existing.length,
      body.match_field, body.match_pattern.trim(),
      body.action, body.action_value?.trim() || null,
      body.enabled === false ? 0 : 1,
      body.app_name?.trim() || null,
      Date.now(),
    );
    return queries.listRules.all(u.sub) as Rule[];
  });

  app.delete('/api/rules/:id', async (req) => {
    const u = (req as AuthedRequest).user;
    const { id } = req.params as { id: string };
    const rule = queries.getRuleById.get(id, u.sub) as Rule | undefined;
    if (rule) {
      queries.delRule.run(id, u.sub);
      queries.shiftRulePositions.run(u.sub, rule.position);
    }
    return queries.listRules.all(u.sub) as Rule[];
  });

  app.patch('/api/rules/:id', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const { id } = req.params as { id: string };
    const body = req.body as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'bad body' });
    queries.toggleRule.run(body.enabled ? 1 : 0, id, u.sub);
    return queries.listRules.all(u.sub) as Rule[];
  });

  // ── Events ────────────────────────────────────────────────────────────────
  app.get('/api/events', async (req) => {
    const u = (req as AuthedRequest).user;
    const after = Number((req.query as any).after ?? 0);
    const cred = (req.query as any).credential as string | undefined;
    if (cred) {
      if (after > 0) {
        return queries.listEventsByCred.all(u.sub, after, cred, 50) as any[];
      }
      return queries.listAllEventsByCred.all(u.sub, cred, 50) as any[];
    }
    if (after > 0) {
      return queries.listEvents.all(u.sub, after, 50) as any[];
    }
    return queries.listAllEvents.all(u.sub, 50) as any[];
  });

  // ── Test push ─────────────────────────────────────────────────────────────
  app.post('/api/test', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    const subs = queries.listSubs.all(u.sub) as Subscription[];
    if (subs.length === 0) return reply.code(400).send({ error: 'no devices enrolled' });
    let delivered = 0;
    await Promise.all(subs.map(async (s) => {
      const r = await sendPush(s, { title: 'Test notification', body: `Hello ${u.display_name ?? u.email}, push is working.`, ts: Date.now() });
      if (r.ok) delivered++;
    }));
    queries.insertEvent.run(Date.now(), u.sub, '[test]', u.email, 'Test notification', null, 'test', delivered, subs.length - delivered, 'test', null);
    return { sent: delivered, total: subs.length };
  });

  // ── Admin routes ──────────────────────────────────────────────────────────
  app.get('/api/admin/users', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const users = queries.allUsers.all() as User[];
    const now = Date.now();
    const weekAgo = now - 7 * 86_400_000;
    return users.map((usr) => ({
      sub: usr.sub,
      email: usr.email,
      display_name: usr.display_name,
      is_admin: usr.is_admin === 1,
      is_env_admin: isEnvAdmin(usr.email),
      device_count: (queries.listSubs.all(usr.sub) as any[]).length,
      event_count_7d: (queries.countEvents7d.get(usr.sub, weekAgo) as { c: number }).c,
      last_event_ts: (queries.lastEventTs.get(usr.sub) as { ts: number } | undefined)?.ts ?? null,
    }));
  });

  app.get('/api/admin/events/unmatched', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    return queries.listUnmatchedEvents.all(50) as any[];
  });

  app.post('/api/admin/users/:sub/admin', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const targetSub = (req.params as { sub: string }).sub;
    const body = req.body as { is_admin: boolean };
    const target = queries.userBySub.get(targetSub) as User | undefined;
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (isEnvAdmin(target.email)) return reply.code(403).send({ error: 'cannot modify env admin' });
    queries.setAdmin.run(body.is_admin ? 1 : 0, targetSub);
    return { ok: true };
  });

  // ── Impersonation ─────────────────────────────────────────────────────────
  app.post('/api/admin/impersonate', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const body = req.body as { user_sub?: string; clear?: boolean };
    if (body.clear) {
      reply.setCookie('impersonate', '', {
        path: '/',
        httpOnly: true,
        secure: config.baseUrl.startsWith('https'),
        sameSite: 'lax',
        expires: new Date(0),
      });
      return { ok: true };
    }
    if (!body.user_sub) return reply.code(400).send({ error: 'missing user_sub' });
    const target = queries.userBySub.get(body.user_sub) as User | undefined;
    if (!target) return reply.code(404).send({ error: 'user not found' });
    reply.setCookie('impersonate', body.user_sub, {
      httpOnly: true,
      secure: config.baseUrl.startsWith('https'),
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
    return { ok: true };
  });

  // ── SMTP Credentials (admin only) ─────────────────────────────────────────
  app.get('/api/admin/credentials', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    return queries.listAllCredentials.all() as any[];
  });

  app.post('/api/admin/credentials', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const body = req.body as { name: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: 'bad body' });
    const id = 'cred_' + nanoid(12);
    const password = 'sk_' + nanoid(24);
    const hash = await argon2Hash(password);
    queries.insertCredential.run(id, u.sub, body.name.trim(), hash, 1, Date.now());
    return { id, name: body.name.trim(), password };
  });

  app.patch('/api/admin/credentials/:id', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const body = req.body as { enabled: boolean };
    queries.toggleCredential.run(body.enabled ? 1 : 0, id);
    return { ok: true };
  });

  app.delete('/api/admin/credentials/:id', async (req, reply) => {
    const u = (req as AuthedRequest).user;
    if (!u.is_admin) return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    queries.delCredential.run(id);
    return { ok: true };
  });
}
