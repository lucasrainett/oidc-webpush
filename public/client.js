// oidc-webpush — client-side vanilla JS

(async () => {
  let lastEventId = 0;
  let isAdmin = false;
  let impersonating = null;

  // ── Identity ──────────────────────────────────────────────────────────────
  try {
    const me = await fetch('/api/me').then(r => r.json());
    const who = document.getElementById('who');
    if (who) who.textContent = me.email;
    isAdmin = me.is_admin;
    impersonating = me.impersonating;
    if (isAdmin) {
      document.querySelectorAll('.admin-only').forEach(el => (el as HTMLElement).style.display = '');
      loadUsersForImpersonation();
      loadAdminCredentials();
      loadUnmatchedEvents();
    }
    if (impersonating) {
      const banner = document.getElementById('impersonate-banner');
      if (banner) {
        banner.style.display = '';
        document.getElementById('impersonate-name')!.textContent = impersonating.email;
      }
    }
  } catch (err) { console.error(err); }

  document.getElementById('brand-host')!.textContent = location.host;

  // ── Devices ───────────────────────────────────────────────────────────────
  async function loadDevices() {
    try {
      const devices = await fetch('/api/devices').then(r => r.json());
      const container = document.getElementById('devices')!;
      if (!devices.length) {
        container.innerHTML = '<div class="empty">no devices enrolled · click "enable on this device" below</div>';
        return;
      }
      container.innerHTML = devices.map((s: any) => `
        <div class="row">
          <span class="device-ua">${esc(s.user_agent ?? 'unknown')}</span>
          <span class="meta">${relTime(s.last_seen)}</span>
          <button class="ghost" data-del-device="${esc(s.id)}">remove</button>
        </div>`).join('');
      container.querySelectorAll('[data-del-device]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLElement).dataset.delDevice!;
          await fetch(`/api/devices/${id}`, { method: 'DELETE' });
          loadDevices();
        });
      });
    } catch (err) { console.error(err); }
  }
  loadDevices();

  const enableBtn = document.getElementById('enable-btn') as HTMLButtonElement;
  if (enableBtn) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      enableBtn.disabled = true;
      enableBtn.textContent = 'push not supported in this browser';
    } else {
      (async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
          await navigator.serviceWorker.ready;
          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            enableBtn.textContent = 'push enabled on this device';
            enableBtn.disabled = true;
          }
        } catch {
          enableBtn.disabled = true;
          enableBtn.textContent = 'service worker failed';
        }
      })();

      enableBtn.addEventListener('click', async () => {
        enableBtn.disabled = true;
        enableBtn.textContent = 'enabling…';
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') throw new Error('permission denied');
          const vapidKey = await fetch('/api/vapid-public-key').then(r => r.text());
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey.trim()),
          });
          const json = sub.toJSON();
          const res = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent.slice(0, 200) }),
          });
          if (!res.ok) throw new Error('subscribe failed');
          loadDevices();
          enableBtn.textContent = 'push enabled on this device';
        } catch (err: any) {
          console.error(err);
          enableBtn.disabled = false;
          enableBtn.textContent = 'enable on this device';
          alert('could not enable push: ' + err.message);
        }
      });
    }
  }

  // ── Rules ─────────────────────────────────────────────────────────────────
  async function loadRules() {
    try {
      const rules = await fetch('/api/rules').then(r => r.json());
      const container = document.getElementById('rules')!;
      if (!rules.length) {
        container.innerHTML = '<div class="empty">no rules · all emails pass through with default priority</div>';
        return;
      }
      container.innerHTML = rules.map((r: any) => {
        const av = r.action_value ? ` <span class="action-value">${esc(r.action_value)}</span>` : '';
        const app = r.app_name ? ` <span class="action-value">[${esc(r.app_name)}]</span>` : '';
        const status = r.enabled ? '' : ' <span class="action-value">(disabled)</span>';
        return `<div class="row">
          <span class="rule-expr"><code>${esc(r.match_field)}</code> ~ <code>/${esc(r.match_pattern)}/</code> → <span class="action-${esc(r.action)}">${esc(r.action)}</span>${av}${app}${status}</span>
          <label class="checkbox-label"><input type="checkbox" data-toggle-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}></label>
          <button class="ghost" data-del-rule="${esc(r.id)}">delete</button>
        </div>`;
      }).join('');

      container.querySelectorAll('[data-del-rule]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLElement).dataset.delRule!;
          await fetch(`/api/rules/${id}`, { method: 'DELETE' });
          loadRules();
        });
      });
      container.querySelectorAll('[data-toggle-rule]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const id = (e.target as HTMLInputElement).dataset.toggleRule!;
          const enabled = (e.target as HTMLInputElement).checked;
          await fetch(`/api/rules/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          loadRules();
        });
      });
    } catch (err) { console.error(err); }
  }
  loadRules();

  document.getElementById('toggle-rule-form')!.addEventListener('click', () => {
    const form = document.getElementById('rule-form')!;
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('rule-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const body: any = {
      match_field: fd.get('match_field'),
      match_pattern: fd.get('match_pattern'),
      action: fd.get('action'),
      action_value: fd.get('action_value') || null,
      app_name: (document.getElementById('rule-app-name') as HTMLSelectElement).value || null,
      enabled: fd.get('enabled') === 'on',
    };
    await fetch('/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    (e.target as HTMLFormElement).reset();
    document.getElementById('rule-form')!.style.display = 'none';
    loadRules();
  });

  document.getElementById('rule-action')!.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    document.getElementById('rule-value')!.style.display = val === 'mute' ? 'none' : '';
  });

  // ── Events ────────────────────────────────────────────────────────────────
  async function loadEvents() {
    try {
      const after = lastEventId;
      const url = after > 0 ? `/api/events?after=${after}` : '/api/events';
      const events = await fetch(url).then(r => r.json());
      const container = document.getElementById('events')!;
      if (!events.length && after === 0) {
        container.innerHTML = '<div class="empty">no events yet</div>';
        return;
      }
      const html = events.map((ev: any) => `
        <div class="row event status-${esc(ev.status)}">
          <span class="ts">${esc(new Date(ev.ts).toLocaleString())}</span>
          <span class="from">${esc((ev.from_addr ?? '').slice(0, 32))}</span>
          <span class="subject">${esc((ev.subject ?? '').slice(0, 64))}</span>
          <span class="status-pill">${esc(ev.status)} · ${ev.delivered_count}/${ev.delivered_count + ev.failed_count}</span>
        </div>`).join('');
      if (after === 0) {
        container.innerHTML = html;
      } else {
        container.insertAdjacentHTML('afterbegin', html);
      }
      for (const ev of events) if (ev.id > lastEventId) lastEventId = ev.id;
    } catch (err) { console.error(err); }
  }
  loadEvents();

  document.getElementById('refresh-events')!.addEventListener('click', loadEvents);

  // ── Test Push ─────────────────────────────────────────────────────────────
  document.getElementById('test-push')!.addEventListener('click', async () => {
    const toast = document.getElementById('toast')!;
    try {
      const res = await fetch('/api/test', { method: 'POST' }).then(r => r.json());
      toast.innerHTML = `<div class="toast ok">sent to ${res.sent}/${res.total} device(s)</div>`;
    } catch {
      toast.innerHTML = '<div class="toast err">test push failed</div>';
    }
    setTimeout(() => { toast.innerHTML = ''; }, 3000);
  });

  // ── Admin: Impersonation ──────────────────────────────────────────────────
  async function loadUsersForImpersonation() {
    try {
      const users = await fetch('/api/admin/users').then(r => r.json());
      const select = document.getElementById('impersonate-select') as HTMLSelectElement;
      const credSelect = document.getElementById('cred-user-select') as HTMLSelectElement;
      select.innerHTML = '<option value="">view as user...</option>';
      credSelect.innerHTML = '<option value="">select user...</option>';
      for (const u of users) {
        const opt = document.createElement('option');
        opt.value = u.sub;
        opt.textContent = `${u.email} ${u.is_admin ? '(admin)' : ''}`;
        select.appendChild(opt);
        const opt2 = document.createElement('option');
        opt2.value = u.sub;
        opt2.textContent = u.email;
        credSelect.appendChild(opt2);
      }
      // Populate app_name dropdown from credential names
      const creds = await fetch('/api/admin/credentials').then(r => r.json());
      const appSelect = document.getElementById('rule-app-name') as HTMLSelectElement;
      appSelect.innerHTML = '<option value="">app (optional)</option>';
      const names = new Set<string>();
      for (const c of creds) if (c.name) names.add(c.name);
      for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        appSelect.appendChild(opt);
      }
    } catch (err) { console.error(err); }
  }

  document.getElementById('impersonate-select')!.addEventListener('change', async (e) => {
    const sub = (e.target as HTMLSelectElement).value;
    if (!sub) return;
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_sub: sub }),
    });
    location.reload();
  });

  document.getElementById('stop-impersonate')!.addEventListener('click', async () => {
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    location.reload();
  });

  // ── Admin: Credentials ────────────────────────────────────────────────────
  async function loadAdminCredentials() {
    try {
      const creds = await fetch('/api/admin/credentials').then(r => r.json());
      const container = document.getElementById('credentials-list')!;
      if (!creds.length) {
        container.innerHTML = '<div class="empty">no credentials</div>';
        return;
      }
      container.innerHTML = creds.map((c: any) => `
        <div class="row">
          <span class="device-ua">${esc(c.name)} · ${esc(c.id)}</span>
          <span class="meta">${c.message_count} msgs</span>
          <label class="checkbox-label"><input type="checkbox" data-toggle-cred="${esc(c.id)}" ${c.enabled ? 'checked' : ''}></label>
          <button class="ghost" data-del-cred="${esc(c.id)}">delete</button>
        </div>`).join('');
      container.querySelectorAll('[data-del-cred]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = (e.target as HTMLElement).dataset.delCred!;
          if (!confirm('Delete this credential?')) return;
          await fetch(`/api/admin/credentials/${id}`, { method: 'DELETE' });
          loadAdminCredentials();
        });
      });
      container.querySelectorAll('[data-toggle-cred]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const id = (e.target as HTMLInputElement).dataset.toggleCred!;
          const enabled = (e.target as HTMLInputElement).checked;
          await fetch(`/api/admin/credentials/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          loadAdminCredentials();
        });
      });
    } catch (err) { console.error(err); }
  }

  document.getElementById('toggle-cred-form')!.addEventListener('click', () => {
    const form = document.getElementById('cred-form')!;
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('cred-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userSub = (document.getElementById('cred-user-select') as HTMLSelectElement).value;
    const name = (document.getElementById('cred-name') as HTMLInputElement).value.trim();
    if (!userSub || !name) return;
    try {
      const res = await fetch('/api/admin/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_sub: userSub, name }),
      }).then(r => r.json());
      alert(`Credential created.\nUsername: ${res.id}\nPassword: ${res.password}\n\nCopy the password now — it will not be shown again.`);
      (e.target as HTMLFormElement).reset();
      document.getElementById('cred-form')!.style.display = 'none';
      loadAdminCredentials();
    } catch {
      alert('failed to create credential');
    }
  });

  // ── Admin: Unmatched Events ─────────────────────────────────────────────────
  async function loadUnmatchedEvents() {
    try {
      const events = await fetch('/api/admin/events/unmatched').then(r => r.json());
      const container = document.getElementById('unmatched-events')!;
      if (!events.length) {
        container.innerHTML = '<div class="empty">no unmatched events</div>';
        return;
      }
      container.innerHTML = events.map((ev: any) => `
        <div class="row event status-${esc(ev.status)}">
          <span class="ts">${esc(new Date(ev.ts).toLocaleString())}</span>
          <span class="from">${esc((ev.from_addr ?? '').slice(0, 32))}</span>
          <span class="subject">${esc((ev.to_addr ?? '').slice(0, 64))}</span>
          <span class="status-pill">${esc(ev.status)}</span>
        </div>`).join('');
    } catch (err) { console.error(err); }
  }
  document.getElementById('refresh-unmatched')!.addEventListener('click', loadUnmatchedEvents);
})();

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
