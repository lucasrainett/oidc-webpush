// Client-side glue: Web Push enrollment, identity hydration.
// Everything else is htmx in index.html.

(async () => {
  // Display current user
  try {
    const me = await fetch('/api/me').then(r => r.json());
    const who = document.getElementById('who');
    if (who) who.textContent = me.email;
  } catch { /* noop */ }

  // Display origin in header
  const host = document.getElementById('brand-host');
  if (host) host.textContent = location.host;

  const enableBtn = document.getElementById('enable-btn');
  if (!enableBtn) return;

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    enableBtn.disabled = true;
    enableBtn.textContent = 'push not supported in this browser';
    return;
  }

  // Register the SW first (idempotent — browser dedups by URL+scope)
  let registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  } catch (err) {
    console.error('sw register failed', err);
    enableBtn.disabled = true;
    enableBtn.textContent = 'service worker failed';
    return;
  }

  // Already subscribed? Reflect state.
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    enableBtn.textContent = 'push enabled on this device';
    enableBtn.disabled = true;
  }

  enableBtn.addEventListener('click', async () => {
    enableBtn.disabled = true;
    enableBtn.textContent = 'enabling…';

    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('permission denied');

      const vapidKey = await fetch('/api/vapid-public-key').then(r => r.text());
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey.trim()),
      });

      const sub = subscription.toJSON();
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: sub.keys,
          userAgent: navigator.userAgent.slice(0, 200),
        }),
      });

      if (!res.ok) throw new Error('subscribe failed: ' + res.status);

      // Swap the devices list with the fragment we got back
      const html = await res.text();
      document.getElementById('devices').innerHTML = html;

      enableBtn.textContent = 'push enabled on this device';
    } catch (err) {
      console.error(err);
      enableBtn.disabled = false;
      enableBtn.textContent = 'enable on this device';
      alert('could not enable push: ' + err.message);
    }
  });
})();

// VAPID key conversion — Web Push API wants a Uint8Array, server sends base64url
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
