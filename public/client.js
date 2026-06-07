// oidc-webpush — client-side vanilla JS

(async () => {
  let lastEventId = 0;
  let oldestEventId = Infinity;
  let totalEventsLoaded = 0;
  let isAdmin = false;
  let impersonating = null;
  let currentSub = '';
  let eventsCredFilter = '';
  let eventsStatusFilter = '';

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(message, type = 'ok') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerHTML = `<div class="toast ${esc(type)}">${esc(message)}</div>`;
    setTimeout(() => { toast.innerHTML = ''; }, 3000);
  }

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
    if (smtpEndpoint) {
      smtpEndpoint.textContent = me.smtp_endpoint || (location.hostname + ':' + me.smtp_port);
    }
  } catch (err) { console.error(err); }

  const brandHost = document.getElementById('brand-host');
  if (brandHost) brandHost.textContent = location.host;

  // ── Settings (AI prefs) ───────────────────────────────────────────────────
  try {
    const prefs = await fetch('/api/prefs').then(r => r.json());
    const aiFilterEl = document.getElementById('pref-ai-filter');
    const aiSummaryEl = document.getElementById('pref-ai-summary');
    if (aiFilterEl) aiFilterEl.checked = prefs.use_ai_filter;
    if (aiSummaryEl) aiSummaryEl.checked = prefs.use_ai_summary;
  } catch (err) { console.error(err); }

  document.getElementById('pref-ai-filter')?.addEventListener('change', async (e) => {
    try {
      await fetch('/api/prefs', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ use_ai_filter: e.target.checked }),
      });
    } catch { showToast('failed to save preference', 'err'); }
  });

  document.getElementById('pref-ai-summary')?.addEventListener('change', async (e) => {
    try {
      await fetch('/api/prefs', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ use_ai_summary: e.target.checked }),
      });
    } catch { showToast('failed to save preference', 'err'); }
  });

  // ── Devices ───────────────────────────────────────────────────────────────
  function parseDeviceName(ua) {
    if (!ua) return 'unknown device';
    const u = ua.toLowerCase();
    let browser = 'browser';
    if (u.includes('edg')) browser = 'Edge';
    else if (u.includes('opr') || u.includes('opera')) browser = 'Opera';
    else if (u.includes('chrome')) browser = 'Chrome';
    else if (u.includes('firefox')) browser = 'Firefox';
    else if (u.includes('safari')) browser = 'Safari';

    let os = '';
    if (u.includes('android')) os = 'Android';
    else if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) os = 'iOS';
    else if (u.includes('macintosh') || u.includes('mac os x')) os = 'macOS';
    else if (u.includes('windows')) os = 'Windows';
    else if (u.includes('linux')) os = 'Linux';

    return os ? `${browser} on ${os}` : browser;
  }

  async function loadDevices() {
    try {
      const devices = await fetch('/api/devices').then(r => r.json());
      const container = document.getElementById('devices');
      if (!container) return;

      let currentEndpoint = null;
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) currentEndpoint = sub.endpoint;
      } catch (e) { /* ignore */ }

      if (!devices.length) {
        container.innerHTML = '<div class="empty">no devices enrolled · click "enable on this device" below</div>';
        if (enableBtn) {
          enableBtn.disabled = false;
          enableBtn.textContent = 'enable on this device';
        }
        return;
      }
      container.innerHTML = devices.map(s => {
        const isThisDevice = currentEndpoint && s.endpoint === currentEndpoint;
        const name = parseDeviceName(s.user_agent);
        const badge = isThisDevice ? ' <span class="meta" style="color:var(--accent)">· this device</span>' : '';
        return `<div class="row" title="${esc(s.user_agent ?? '')}">
          <span class="device-ua">${esc(name)}${badge}</span>
          <span class="meta">${relTime(s.last_seen)}</span>
          <button class="ghost" data-del-device="${esc(s.id)}">remove</button>
        </div>`;
      }).join('');
      container.querySelectorAll('[data-del-device]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.delDevice;
          if (!id) return;
          try {
            await fetch(`/api/devices/${id}`, { method: 'DELETE' });
            loadDevices();
          } catch { showToast('failed to remove device', 'err'); }
        });
      });
    } catch (err) {
      showToast('failed to load devices', 'err');
      console.error(err);
    }
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

          const existing = await reg.pushManager.getSubscription();
          if (existing) {
            enableBtn.textContent = 'push enabled on this device';
          }

          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'activated') {
                  window.location.reload();
                }
              });
            }
          });
          reg.update();
        } catch (err) {
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
          let sub = await reg.pushManager.getSubscription();

          if (!sub) {
            try {
              const subscribePromise = reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey.trim()),
              });
              const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('subscribe timed out')), 30_000);
              });
              sub = await Promise.race([subscribePromise, timeoutPromise]);
            } catch (subscribeErr) {
              sub = await reg.pushManager.getSubscription();
              if (!sub) throw subscribeErr;
            }
          }

          const json = sub.toJSON();

          const res = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: parseDeviceName(navigator.userAgent) }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => 'unknown error');
            throw new Error('subscribe failed: ' + res.status + ' ' + errText);
          }
          loadDevices();
          enableBtn.textContent = 'push enabled on this account';
        } catch (err) {
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
      container.innerHTML = rules.map((r, i) => {
        const av = r.action_value ? ` <span class="action-value">${esc(r.action_value)}</span>` : '';
        const app = r.app_name ? ` <span class="action-value">[${esc(r.app_name)}]</span>` : '';
        const status = r.enabled ? '' : ' <span class="action-value">(disabled)</span>';
        const isFirst = i === 0;
        const isLast = i === rules.length - 1;
        return `<div class="row">
          <span class="rule-expr"><code>${esc(r.match_field)}</code> ~ <code>/${esc(r.match_pattern)}/</code> → <span class="action-${esc(r.action)}">${esc(r.action)}</span>${av}${app}${status}</span>
          <button class="ghost" data-move-rule="${esc(r.id)}" data-dir="up" ${isFirst ? 'disabled' : ''}>↑</button>
          <button class="ghost" data-move-rule="${esc(r.id)}" data-dir="down" ${isLast ? 'disabled' : ''}>↓</button>
          <label class="checkbox-label"><input type="checkbox" data-toggle-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}></label>
          <button class="ghost" data-del-rule="${esc(r.id)}">delete</button>
        </div>`;
      }).join('');

      container.querySelectorAll('[data-move-rule]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.moveRule;
          const dir = e.target.dataset.dir;
          if (!id || !dir) return;
          try {
            await fetch(`/api/rules/${id}/move`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ direction: dir }),
            });
            loadRules();
          } catch { showToast('failed to reorder rule', 'err'); }
        });
      });

      container.querySelectorAll('[data-del-rule]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.delRule;
          if (!id) return;
          try {
            await fetch(`/api/rules/${id}`, { method: 'DELETE' });
            loadRules();
          } catch { showToast('failed to delete rule', 'err'); }
        });
      });
      container.querySelectorAll('[data-toggle-rule]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const id = e.target.dataset.toggleRule;
          const enabled = e.target.checked;
          if (!id) return;
          try {
            await fetch(`/api/rules/${id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled }),
            });
            loadRules();
          } catch { showToast('failed to toggle rule', 'err'); }
        });
      });
    } catch (err) {
      showToast('failed to load rules', 'err');
      console.error(err);
    }
  }
  loadRules();

  const toggleRuleForm = document.getElementById('toggle-rule-form');
  if (toggleRuleForm) {
    toggleRuleForm.addEventListener('click', () => {
      document.getElementById('rule-form')?.classList.toggle('open');
    });
  }

  const toggleRuleTest = document.getElementById('toggle-rule-test');
  if (toggleRuleTest) {
    toggleRuleTest.addEventListener('click', () => {
      document.getElementById('rule-test-form')?.classList.toggle('open');
    });
  }

  const ruleForm = document.getElementById('rule-form');
  if (ruleForm) {
    ruleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const appNameEl = document.getElementById('rule-app-name');
      const body = {
        match_field: fd.get('match_field'),
        match_pattern: fd.get('match_pattern'),
        action: fd.get('action'),
        action_value: fd.get('action_value') || null,
        app_name: appNameEl ? (appNameEl.value || null) : null,
        enabled: fd.get('enabled') === 'on',
      };
      try {
        await fetch('/api/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        e.target.reset();
        ruleForm.classList.remove('open');
        loadRules();
      } catch { showToast('failed to save rule', 'err'); }
    });
  }

  const ruleAction = document.getElementById('rule-action');
  if (ruleAction) {
    ruleAction.addEventListener('change', (e) => {
      const ruleValue = document.getElementById('rule-value');
      if (ruleValue) ruleValue.style.display = e.target.value === 'mute' ? 'none' : '';
    });
  }

  const ruleTestForm = document.getElementById('rule-test-form');
  if (ruleTestForm) {
    ruleTestForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const resultEl = document.getElementById('rule-test-result');
      try {
        const res = await fetch('/api/rules/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from: fd.get('from') || '',
            subject: fd.get('subject') || '',
            body: fd.get('body') || '',
          }),
        }).then(r => r.json());
        if (resultEl) {
          let msg, type;
          if (!res.matched) {
            msg = 'no match — would deliver at priority 3';
            type = 'ok';
          } else if (!res.would_deliver) {
            msg = `matched rule (${esc(res.action)}) — would be silently dropped`;
            type = 'warn';
          } else {
            const val = res.action_value ? ' ' + res.action_value : '';
            msg = `matched rule (${esc(res.action)}${esc(val)}) — would deliver`;
            type = 'ok';
          }
          resultEl.innerHTML = `<div class="toast ${type}">${msg}</div>`;
        }
      } catch {
        if (resultEl) resultEl.innerHTML = '<div class="toast err">test failed</div>';
      }
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  const PAGE_SIZE = 50;

  async function loadEvents(mode = 'initial') {
    try {
      let url;
      if (mode === 'older') {
        url = `/api/events?before=${oldestEventId}`;
      } else if (mode === 'newer' && lastEventId > 0) {
        url = `/api/events?after=${lastEventId}`;
      } else {
        url = '/api/events';
      }
      if (eventsCredFilter) url += '&credential=' + encodeURIComponent(eventsCredFilter);
      if (eventsStatusFilter) url += '&status=' + encodeURIComponent(eventsStatusFilter);

      const events = await fetch(url).then(r => r.json());
      const container = document.getElementById('events');
      const loadOlderEl = document.getElementById('events-load-older');
      const filterSelect = document.getElementById('events-cred-filter');
      if (!container) return;

      if (!events.length && mode === 'initial') {
        container.innerHTML = '<div class="empty">no events yet</div>';
        if (loadOlderEl) loadOlderEl.style.display = 'none';
        return;
      }

      const html = events.map(ev => `
        <div class="row event status-${esc(ev.status)}" style="cursor:pointer" data-event-id="${esc(ev.public_id)}">
          <span class="ts">${esc(new Date(ev.ts).toLocaleString())}</span>
          <span class="from">${esc((ev.from_addr ?? '').slice(0, 32))}${ev.credential_name ? ' [' + esc(ev.credential_name) + ']' : ''}</span>
          <span class="subject">${esc((ev.subject ?? '').slice(0, 64))}</span>
          <span class="status-pill">${esc(ev.status)} · ${ev.delivered_count}/${ev.delivered_count + ev.failed_count}</span>
        </div>`).join('');

      if (mode === 'older') {
        container.insertAdjacentHTML('beforeend', html);
      } else if (mode === 'newer') {
        container.insertAdjacentHTML('afterbegin', html);
      } else {
        container.innerHTML = html || '<div class="empty">no events yet</div>';
        totalEventsLoaded = 0;
        oldestEventId = Infinity;
        lastEventId = 0;
      }

      totalEventsLoaded += events.length;

      for (const ev of events) {
        if (ev.id > lastEventId) lastEventId = ev.id;
        if (ev.id < oldestEventId) oldestEventId = ev.id;
      }

      if (loadOlderEl) {
        loadOlderEl.style.display = events.length >= PAGE_SIZE ? '' : 'none';
      }

      container.querySelectorAll('[data-event-id]').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.dataset.eventId;
          if (id) window.location.href = '/event.html?id=' + id;
        });
      });

      if (filterSelect && mode === 'initial') {
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
    } catch (err) {
      showToast('failed to load events', 'err');
      console.error(err);
    }
  }
  loadEvents('initial');

  document.getElementById('refresh-events')?.addEventListener('click', () => {
    lastEventId = 0;
    oldestEventId = Infinity;
    totalEventsLoaded = 0;
    loadEvents('initial');
  });

  document.getElementById('load-older-btn')?.addEventListener('click', () => {
    if (oldestEventId < Infinity) loadEvents('older');
  });

  document.getElementById('events-cred-filter')?.addEventListener('change', (e) => {
    eventsCredFilter = e.target.value;
    lastEventId = 0;
    oldestEventId = Infinity;
    totalEventsLoaded = 0;
    loadEvents('initial');
  });

  document.getElementById('events-status-filter')?.addEventListener('change', (e) => {
    eventsStatusFilter = e.target.value;
    lastEventId = 0;
    oldestEventId = Infinity;
    totalEventsLoaded = 0;
    loadEvents('initial');
  });

  // ── Test Push ─────────────────────────────────────────────────────────────
  document.getElementById('test-push')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/test', { method: 'POST' }).then(r => r.json());
      showToast(`sent to ${res.sent}/${res.total} device(s)`, 'ok');
    } catch {
      showToast('test push failed', 'err');
    }
  });

  // ── Admin: Impersonation ──────────────────────────────────────────────────
  async function loadUsersForImpersonation() {
    try {
      const users = await fetch('/api/admin/users').then(r => r.json());
      const select = document.getElementById('impersonate-select');
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

      // Populate credential user restriction dropdown
      const credUserSelect = document.getElementById('cred-allowed-user');
      if (credUserSelect) {
        credUserSelect.innerHTML = '<option value="">any user</option>';
        for (const u of users) {
          const opt = document.createElement('option');
          opt.value = u.sub;
          opt.textContent = u.email;
          credUserSelect.appendChild(opt);
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
    } catch (err) {
      showToast('failed to load users', 'err');
      console.error(err);
    }
  }

  document.getElementById('impersonate-select')?.addEventListener('change', async (e) => {
    const sub = e.target.value;
    if (!sub) return;
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_sub: sub }),
      });
      location.reload();
    } catch { showToast('impersonation failed', 'err'); }
  });

  document.getElementById('stop-impersonate')?.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      location.reload();
    } catch { showToast('failed to stop impersonation', 'err'); }
  });

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
      container.innerHTML = creds.map(c => {
        const restriction = c.allowed_user_sub ? ` <span class="meta">→ ${esc(c.allowed_user_email ?? c.allowed_user_sub)}</span>` : '';
        return `<div class="row">
          <span class="device-ua">${esc(c.name)} · ${esc(c.id)}${restriction}</span>
          <span class="meta">${c.message_count} msgs</span>
          <label class="checkbox-label"><input type="checkbox" data-toggle-cred="${esc(c.id)}" ${c.enabled ? 'checked' : ''}></label>
          <button class="ghost" data-del-cred="${esc(c.id)}">delete</button>
        </div>`;
      }).join('');

      container.querySelectorAll('[data-del-cred]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = e.target.dataset.delCred;
          if (!id) return;
          if (!confirm('Delete this credential?')) return;
          try {
            await fetch(`/api/admin/credentials/${id}`, { method: 'DELETE' });
            loadAdminCredentials();
          } catch { showToast('failed to delete credential', 'err'); }
        });
      });
      container.querySelectorAll('[data-toggle-cred]').forEach(cb => {
        cb.addEventListener('change', async (e) => {
          const id = e.target.dataset.toggleCred;
          const enabled = e.target.checked;
          if (!id) return;
          try {
            await fetch(`/api/admin/credentials/${id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled }),
            });
            loadAdminCredentials();
          } catch { showToast('failed to toggle credential', 'err'); }
        });
      });

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
    } catch (err) {
      showToast('failed to load credentials', 'err');
      console.error(err);
    }
  }

  document.getElementById('toggle-cred-form')?.addEventListener('click', () => {
    document.getElementById('cred-form')?.classList.toggle('open');
  });

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
      const allowedUserEl = document.getElementById('cred-allowed-user');
      const allowed_user_sub = allowedUserEl ? (allowedUserEl.value || null) : null;
      try {
        const res = await fetch('/api/admin/credentials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, allowed_user_sub }),
        }).then(r => r.json());
        if (credResult) credResult.style.display = '';
        if (credResultId) credResultId.textContent = res.id;
        if (credResultPass) credResultPass.textContent = res.password;
        e.target.reset();
        credForm.classList.remove('open');
        loadAdminCredentials();
      } catch { showToast('failed to create credential', 'err'); }
    });
  }

  document.getElementById('hide-cred-result')?.addEventListener('click', () => {
    if (credResult) credResult.style.display = 'none';
  });

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

  // ── Admin: Unmatched Events ───────────────────────────────────────────────
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
    } catch (err) {
      showToast('failed to load unmatched events', 'err');
      console.error(err);
    }
  }
  document.getElementById('refresh-unmatched')?.addEventListener('click', loadUnmatchedEvents);
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
