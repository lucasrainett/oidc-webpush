/** oidc-webpush — SMTP ingress server */

import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { verify } from '@node-rs/argon2';
import { config } from './config.js';
import { db, queries } from './db.js';
import { evalRules } from './rules.js';
import { sendPush } from './push.js';
import { callOllama, matchesBypassPattern, matchesSkipPattern } from './ai.js';
import { getUserPref } from './db.js';
import type { User } from './types.js';

export function startSmtpServer() {
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    async onAuth(auth, _session, cb) {
      const cred = queries.getCredentialById.get(auth.username) as
        | { password_hash: string; enabled: number; user_sub: string; id: string }
        | undefined;
      if (!cred || !cred.enabled) {
        return cb(new Error('invalid credentials'));
      }
      try {
        const ok = await verify(cred.password_hash, auth.password ?? '');
        if (!ok) return cb(new Error('invalid credentials'));
        queries.updateCredentialStats.run(Date.now(), cred.id);
        return cb(null, { user: cred.user_sub });
      } catch {
        queries.incrementCredentialError.run(cred.id);
        return cb(new Error('invalid credentials'));
      }
    },
    async onData(stream, session, cb) {
      try {
        const parsed = await simpleParser(stream);
        for (const rcpt of session.envelope.rcptTo) {
          const recipient = rcpt.address.toLowerCase().trim();
          const user = queries.userByEmail.get(recipient) as User | undefined;
          if (!user) {
            queries.insertEvent.run(
              Date.now(), null, parsed.from?.text ?? '', recipient,
              parsed.subject ?? '(no subject)', null, null, 0, 0, 'no_user',
            );
            continue;
          }
          await handleEmail(parsed, recipient, user);
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

async function handleEmail(parsed: any, recipient: string, user: User) {
  const from = parsed.from?.text ?? '';
  const subject = parsed.subject ?? '(no subject)';
  const body = parsed.text ?? (parsed.html ? String(parsed.html) : '');

  const rules = queries.listRules.all(user.sub) as import('./types.js').Rule[];
  const matched = evalRules(rules, { from, subject, body });

  if (matched?.action === 'mute') {
    queries.insertEvent.run(
      Date.now(), user.sub, from, recipient, subject,
      matched.id, 'mute', 0, 0, 'muted',
    );
    return;
  }

  let aiResult = null;
  const aiEnabled = getUserPref(user.sub, 'use_ai_filter', String(config.aiFilterDefault)) !== 'false';
  const aiSummaryEnabled = getUserPref(user.sub, 'use_ai_summary', 'true') !== 'false';

  if (aiEnabled && !matchesSkipPattern(body + ' ' + subject)) {
    aiResult = await callOllama(subject, from, body);
  }

  // bypass patterns override AI verdict
  if (aiResult && !aiResult.relevant && matchesBypassPattern(body + ' ' + subject)) {
    aiResult.relevant = true;
  }

  if (aiResult && aiResult.relevant === false) {
    queries.insertEvent.run(
      Date.now(), user.sub, from, recipient, subject,
      matched?.id ?? null, 'ai_skip', 0, 0, 'ai_suppressed',
    );
    return;
  }

  let pushBody = '';
  let priority = matched?.action === 'priority' ? Number(matched.action_value) || 3 : 3;
  const tag = matched?.action === 'tag' ? matched.action_value : null;

  if (aiResult && aiResult.summary && aiSummaryEnabled) {
    pushBody = aiResult.summary;
    if (aiResult.priority) priority = aiResult.priority;
  } else {
    pushBody = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  const subs = queries.listSubs.all(user.sub) as import('./types.js').Subscription[];
  let delivered = 0, failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      const r = await sendPush(s, {
        title: subject.slice(0, 100),
        body: pushBody.slice(0, 500),
        from,
        priority,
        tag,
        ts: Date.now(),
      });
      if (r.ok) delivered++; else failed++;
    }),
  );

  const status = subs.length === 0 ? 'no_devices' : delivered > 0 ? 'delivered' : 'failed';
  queries.insertEvent.run(
    Date.now(), user.sub, from, recipient, subject,
    matched?.id ?? null, matched?.action ?? null,
    delivered, failed, status,
  );
}
