// oidc-webpush — client-side vanilla JS

(async () => {
  let lastEventId = 0;
  let isAdmin = false;
  let impersonating = null;
  let currentSub = '';

  // ── Identity ──────────────────────────────────────────────────────────────
  try {
    const me = await fetch('/api/me').then(r => r.json());
    const who = document.getElementById('who');
    if (who) who.textContent = me.email;
    isAdmin = me.is_admin;
    impersonating = me.impersonating;
    currentSub = me.sub;
    if (isAdmin) {
      document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = '';
      });
      loadUsersForImpersonation();
      loadAdminCredentials();
      loadUnmatchedEvents();
    }
    if (impersonating) {
      const banner = document.getElementById('impersonate-banner');
      if (banner) {
        banner.style.display = '';
        const nameEl = document.getElementById('impersonate-name');
        if (nameEl) nameEl.textContent = impersonating.email;
      }
    }

    const smtpEndpoint = document.getElementById('smtp-endpoint');
    if (smtpEndpoint && me.smtp_endpoint) smtpEndpoint.textContent = me.smtp_endpoint;
  } catch (err) { console.error(err); }

  const brandHost = document.getElementById('brand-host');
  if (brandHost) brandHost.textContent = location.host;

  // ── Devices ───────────────────────────────────────────────────────────────
  async function loadDevices() {
    try {
      const devices = await fetch('/api/devices').then(r => r.json());
      const container = document.getElementById('devices');
      if (!container) return;
      if (!devices.length) {
        container.innerHTML = '<div class="empty">no devices enrolled · click "enable on this device" below</div>';
        if (enableBtn) {
          enableBtn.disabled = false;
          enableBtn.textContent = 'enable on this device';
        }
        return;
      }
      container.innerHTML = devices.map(s => `
        <div class="row">
          <span class="device-ua">${esc(s.user_agent ?? 'unknown')}</span>
          <span class="meta">${relTime(s.last_seen)}</span>
          <button class="ghost" data-del-device="${esc(s.id)}">remove</button>
        </div>`).join('');
      container.querySelectorAll('[data-del-device]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.target;
          const id = target.dataset.delDevice;
          if (!id) return;
          await fetch(`/api/devices/${id}`, { method: 'DELETE' });
          loadDevices();
        });
      });
    } catch (err) { console.error(err); }
  }
  loadDevices();

  const enableBtn = document.getElementById('enable-btn');
  if (enableBtn) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      enableBtn.disabled = true;
      enableBtn.textContent = 'push not supported in this browser';
    } else {
      (async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
          await navigator.serviceWorker.ready;
          console.log('[CLIENT] SW registered, state:', reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'active');
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              console.log('[CLIENT] new SW installing');
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'activated') {
                  console.log('[CLIENT] new SW activated, reloading...');
                  window.location.reload();
                }
              });
            }
          });
          // force update check on every page load
          reg.update();
        } catch (err) {
          console.error('[CLIENT] SW registration failed:', err);
          enableBtn.disabled = true;
          enableBtn.textContent = 'service worker failed';
        }
      })();

      enableBtn.addEventListener('click', async () => {
        const originalText = enableBtn.textContent;
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
          enableBtn.textContent = 'push enabled on this account';
        } catch (err) {
          console.error(err);
          enableBtn.textContent = originalText || 'enable on this device';
          alert('could not enable push: ' + (err.message || String(err)));
        }
      });
    }
  }

  // ── Rules ─────────────────────────────────────────────────────────────────
  async function loadRules() {
    try {
      const rules = await fetch('/api/rules').then(r => r.json());
      const container = document.getElementById('rules');
      if (!container) return;
      if (!rules.length) {
        container.innerHTML = '<div class="empty">no rules · all emails pass through with default priority</div>';
        return;
      }
      container.innerHTML = rules.map(r => {
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
          const target = e.target;
          const id = target.dataset.delRule;
          if (!id) return;
          await fetch(`/api/rules/${id}`, { method: 'DELETE' });
          loadRules();
        });
      });
      container.querySelectorAll('[data-toggle-rule]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const target = e.target;
          const id = target.dataset.toggleRule;
          const enabled = target.checked;
          if (!id) return;
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

  const toggleRuleForm = document.getElementById('toggle-rule-form');
  if (toggleRuleForm) {
    toggleRuleForm.addEventListener('click', () => {
      const form = document.getElementById('rule-form');
      if (form) form.classList.toggle('open');
    });
  }

  const ruleForm = document.getElementById('rule-form');
  if (ruleForm) {
    ruleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const target = e.target;
      const fd = new FormData(target);
      const appNameEl = document.getElementById('rule-app-name');
      const body = {
        match_field: fd.get('match_field'),
        match_pattern: fd.get('match_pattern'),
        action: fd.get('action'),
        action_value: fd.get('action_value') || null,
        app_name: appNameEl ? (appNameEl.value || null) : null,
        enabled: fd.get('enabled') === 'on',
      };
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      target.reset();
      ruleForm.style.display = 'none';
      loadRules();
    });
  }

  const ruleAction = document.getElementById('rule-action');
  if (ruleAction) {
    ruleAction.addEventListener('change', (e) => {
      const target = e.target;
      const val = target.value;
      const ruleValue = document.getElementById('rule-value');
      if (ruleValue) ruleValue.style.display = val === 'mute' ? 'none' : '';
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  let eventsCredFilter = '';

  async function loadEvents() {
    try {
      const after = lastEventId;
      let url = after > 0 ? `/api/events?after=${after}` : '/api/events';
      if (eventsCredFilter) url += (url.includes('?') ? '&' : '?') + 'credential=' + encodeURIComponent(eventsCredFilter);
      const events = await fetch(url).then(r => r.json());
      const container = document.getElementById('events');
      const filterSelect = document.getElementById('events-cred-filter');
      if (!container) return;
      if (!events.length && after === 0) {
        container.innerHTML = '<div class="empty">no events yet</div>';
        return;
      }
      const html = events.map(ev => `
        <div class="row event status-${esc(ev.status)}">
          <span class="ts">${esc(new Date(ev.ts).toLocaleString())}</span>
          <span class="from">${esc((ev.from_addr ?? '').slice(0, 32))}${ev.credential_name ? ' [' + esc(ev.credential_name) + ']' : ''}</span>
          <span class="subject">${esc((ev.subject ?? '').slice(0, 64))}</span>
          <span class="status-pill">${esc(ev.status)} · ${ev.delivered_count}/${ev.delivered_count + ev.failed_count}</span>
        </div>`).join('');
      if (after === 0) {
        container.innerHTML = html;
      } else {
        container.insertAdjacentHTML('afterbegin', html);
      }
      for (const ev of events) if (ev.id > lastEventId) lastEventId = ev.id;

      // populate credential filter from visible events
      if (filterSelect && after === 0) {
        const existing = new Set(Array.from(filterSelect.options).map(o => o.value));
        for (const ev of events) {
          if (ev.credential_name && !existing.has(ev.credential_name)) {
            const opt = document.createElement('option');
            opt.value = ev.credential_name;
            opt.textContent = ev.credential_name;
            filterSelect.appendChild(opt);
            existing.add(ev.credential_name);
          }
        }
      }
    } catch (err) { console.error(err); }
  }
  loadEvents();

  const refreshEvents = document.getElementById('refresh-events');
  if (refreshEvents) refreshEvents.addEventListener('click', loadEvents);

  const eventsCredFilterEl = document.getElementById('events-cred-filter');
  if (eventsCredFilterEl) {
    eventsCredFilterEl.addEventListener('change', (e) => {
      eventsCredFilter = e.target.value;
      lastEventId = 0;
      loadEvents();
    });
  }

  // ── Test Push ─────────────────────────────────────────────────────────────
  const testPush = document.getElementById('test-push');
  if (testPush) {
    testPush.addEventListener('click', async () => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      try {
        const res = await fetch('/api/test', { method: 'POST' }).then(r => r.json());
        toast.innerHTML = `<div class="toast ok">sent to ${res.sent}/${res.total} device(s)</div>`;
      } catch {
        toast.innerHTML = '<div class="toast err">test push failed</div>';
      }
      setTimeout(() => { toast.innerHTML = ''; }, 3000);
    });
  }

  // ── Admin: Impersonation ──────────────────────────────────────────────────
  async function loadUsersForImpersonation() {
    try {
      const users = await fetch('/api/admin/users').then(r => r.json());
      const select = document.getElementById('impersonate-select');
      const credSelect = document.getElementById('cred-user-select');
      if (select) {
        select.innerHTML = '<option value="">view as user...</option>';
        for (const u of users) {
          if (u.sub === currentSub) continue;
          const opt = document.createElement('option');
          opt.value = u.sub;
          opt.textContent = `${u.email} ${u.is_admin ? '(admin)' : ''}`;
          select.appendChild(opt);
        }
      }
      if (credSelect) {
        credSelect.innerHTML = '<option value="">select user...</option>';
        for (const u of users) {
          const opt = document.createElement('option');
          opt.value = u.sub;
          opt.textContent = u.email;
          credSelect.appendChild(opt);
        }
      }
      // Populate app_name dropdown from credential names
      const creds = await fetch('/api/admin/credentials').then(r => r.json());
      const appSelect = document.getElementById('rule-app-name');
      if (appSelect) {
        appSelect.innerHTML = '<option value="">app (optional)</option>';
        const names = new Set();
        for (const c of creds) if (c.name) names.add(c.name);
        for (const n of names) {
          const opt = document.createElement('option');
          opt.value = n;
          opt.textContent = n;
          appSelect.appendChild(opt);
        }
      }
    } catch (err) { console.error(err); }
  }

  const impersonateSelect = document.getElementById('impersonate-select');
  if (impersonateSelect) {
    impersonateSelect.addEventListener('change', async (e) => {
      const target = e.target;
      const sub = target.value;
      if (!sub) return;
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_sub: sub }),
      });
      location.reload();
    });
  }

  const stopImpersonate = document.getElementById('stop-impersonate');
  if (stopImpersonate) {
    stopImpersonate.addEventListener('click', async () => {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      location.reload();
    });
  }

  // ── Admin: Credentials ────────────────────────────────────────────────────
  async function loadAdminCredentials() {
    try {
      const creds = await fetch('/api/admin/credentials').then(r => r.json());
      const container = document.getElementById('credentials-list');
      if (!container) return;
      if (!creds.length) {
        container.innerHTML = '<div class="empty">no credentials</div>';
        return;
      }
      container.innerHTML = creds.map(c => `
        <div class="row">
          <span class="device-ua">${esc(c.name)} · ${esc(c.id)}</span>
          <span class="meta">${c.message_count} msgs</span>
          <label class="checkbox-label"><input type="checkbox" data-toggle-cred="${esc(c.id)}" ${c.enabled ? 'checked' : ''}></label>
          <button class="ghost" data-del-cred="${esc(c.id)}">delete</button>
        </div>`).join('');
      container.querySelectorAll('[data-del-cred]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const target = e.target;
          const id = target.dataset.delCred;
          if (!id) return;
          if (!confirm('Delete this credential?')) return;
          await fetch(`/api/admin/credentials/${id}`, { method: 'DELETE' });
          loadAdminCredentials();
        });
      });
      container.querySelectorAll('[data-toggle-cred]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const target = e.target;
          const id = target.dataset.toggleCred;
          const enabled = target.checked;
          if (!id) return;
          await fetch(`/api/admin/credentials/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          loadAdminCredentials();
        });
      });
      // also populate events filter dropdown with all credential names
      const filterSelect = document.getElementById('events-cred-filter');
      if (filterSelect) {
        const existing = new Set(Array.from(filterSelect.options).map(o => o.value));
        for (const c of creds) {
          if (c.name && !existing.has(c.name)) {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            filterSelect.appendChild(opt);
            existing.add(c.name);
          }
        }
      }
    } catch (err) { console.error(err); }
  }

  const toggleCredForm = document.getElementById('toggle-cred-form');
  if (toggleCredForm) {
    toggleCredForm.addEventListener('click', () => {
      const form = document.getElementById('cred-form');
      if (form) form.classList.toggle('open');
    });
  }

  const credForm = document.getElementById('cred-form');
  const credResult = document.getElementById('cred-result');
  const credResultId = document.getElementById('cred-result-id');
  const credResultPass = document.getElementById('cred-result-pass');

  if (credForm) {
    credForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameEl = document.getElementById('cred-name');
      const name = nameEl ? nameEl.value.trim() : '';
      if (!name) return;
      try {
        const res = await fetch('/api/admin/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }).then(r => r.json());
        if (credResult) credResult.style.display = '';
        if (credResultId) credResultId.textContent = res.id;
        if (credResultPass) credResultPass.textContent = res.password;
        const form = e.target;
        if (form.reset) form.reset();
        credForm.classList.remove('open');
        loadAdminCredentials();
      } catch {
        alert('failed to create credential');
      }
    });
  }

  const hideCredResult = document.getElementById('hide-cred-result');
  if (hideCredResult && credResult) {
    hideCredResult.addEventListener('click', () => {
      credResult.style.display = 'none';
    });
  }

  function copyToClipboard(el) {
    if (!el) return;
    const text = el.textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  document.getElementById('copy-cred-id')?.addEventListener('click', () => copyToClipboard(credResultId));
  document.getElementById('copy-cred-pass')?.addEventListener('click', () => copyToClipboard(credResultPass));

  // ── Admin: Unmatched Events ─────────────────────────────────────────────────
  async function loadUnmatchedEvents() {
    try {
      const events = await fetch('/api/admin/events/unmatched').then(r => r.json());
      const container = document.getElementById('unmatched-events');
      if (!container) return;
      if (!events.length) {
        container.innerHTML = '<div class="empty">no unmatched events</div>';
        return;
      }
      container.innerHTML = events.map(ev => `
        <div class="row event status-${esc(ev.status)}">
          <span class="ts">${esc(new Date(ev.ts).toLocaleString())}</span>
          <span class="from">${esc((ev.from_addr ?? '').slice(0, 32))}</span>
          <span class="subject">${esc((ev.to_addr ?? '').slice(0, 64))}</span>
          <span class="status-pill">${esc(ev.status)}</span>
        </div>`).join('');
    } catch (err) { console.error(err); }
  }
  const refreshUnmatched = document.getElementById('refresh-unmatched');
  if (refreshUnmatched) refreshUnmatched.addEventListener('click', loadUnmatchedEvents);

  // ── Mute from notification click ──────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const muteFrom = params.get('mute_from');
  if (muteFrom) {
    const muteBanner = document.getElementById('mute-banner');
    const muteFromEl = document.getElementById('mute-from');
    if (muteBanner && muteFromEl) {
      muteFromEl.textContent = muteFrom;
      muteBanner.style.display = '';
    }
    const muteConfirm = document.getElementById('mute-confirm');
    if (muteConfirm) {
      muteConfirm.addEventListener('click', async () => {
        try {
          await fetch('/api/rules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              match_field: 'from',
              match_pattern: `^${escapeRegex(muteFrom)}$`,
              action: 'mute',
              enabled: true,
            }),
          });
          const muteBanner = document.getElementById('mute-banner');
          if (muteBanner) {
            muteBanner.innerHTML = '<span>muted <strong>' + esc(muteFrom) + '</strong></span>';
          }
          loadRules();
          history.replaceState({}, '', '/');
        } catch (err) {
          console.error(err);
          alert('failed to create mute rule');
        }
      });
    }
    const muteCancel = document.getElementById('mute-cancel');
    if (muteCancel) {
      muteCancel.addEventListener('click', () => {
        const muteBanner = document.getElementById('mute-banner');
        if (muteBanner) muteBanner.style.display = 'none';
        history.replaceState({}, '', '/');
      });
    }
  }
})();

// ── Helpers ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
