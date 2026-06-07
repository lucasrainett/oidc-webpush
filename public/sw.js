// oidc-webpush service worker — receives push events and renders notifications.
// v2 — with action buttons (mute, open)

console.log('[SW] installing v2');

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  console.log('[SW] activated v2');
});

self.addEventListener('push', (event) => {
  console.log('[SW] push event received');
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'oidc-webpush', body: event.data ? event.data.text() : '' }; }

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
    data: { from: data.from, priority, eventId: data.eventId, url: data.eventId ? '/event.html?id=' + data.eventId : '/' },
    actions: [
      { action: 'mute-type', title: 'Mute this' },
      { action: 'open', title: 'Open' },
    ],
  };
  console.log('[SW] showing notification with actions:', options.actions);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'mute-type') {
    const from = event.notification.data?.from;
    if (from) {
      event.waitUntil(
        fetch('/api/rules', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            match_field: 'from',
            match_pattern: `^${escapeRegex(from)}$`,
            action: 'mute',
            enabled: true,
          }),
        }).then(() =>
          self.registration.showNotification('Muted', {
            body: `No more from ${from}.`,
            tag: 'mute-confirm',
          }),
        ).catch((err) => console.error('mute failed', err)),
      );
    }
    return;
  }

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const vapidKey = await fetch('/api/vapid-public-key').then(r => r.text());
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey.trim()),
      });
      const json = newSub.toJSON();
      await fetch('/api/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: 'sw-rotation' }),
      });
    } catch (err) {
      console.error('resubscribe failed', err);
    }
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
