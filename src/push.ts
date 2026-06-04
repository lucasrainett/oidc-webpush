/** oidc-webpush — Web Push delivery */

import webpush from 'web-push';
import { config } from './config.js';
import { db, queries } from './db.js';
import type { Subscription } from './types.js';

if (!config.vapid.public || !config.vapid.private) {
  const keys = webpush.generateVAPIDKeys();
  console.error('\n=== SAVE THESE KEYS ===');
  console.error('VAPID_PUBLIC=' + keys.publicKey);
  console.error('VAPID_PRIVATE=' + keys.privateKey);
  console.error('=======================\n');
  console.error('Set these in your .env file and restart.');
  process.exit(1);
}

webpush.setVapidDetails(config.vapid.subject, config.vapid.public, config.vapid.private);

export async function sendPush(
  sub: Subscription,
  payload: object,
): Promise<{ ok: boolean; statusCode?: number }> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err: any) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      queries.delSubByEndpoint.run(sub.endpoint);
    }
    return { ok: false, statusCode: err.statusCode };
  }
}
