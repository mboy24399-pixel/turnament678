/* ═══════════════════════════════════════════════════════════════
   ARENA X — secure boot loader.
   1) Fetches public Firebase config from /api/config (server env vars).
   2) Dynamically loads Firebase SDKs, initializes the app.
   3) Exposes window.Arena = { firebase, auth, db, config }.
   No keys exist anywhere in this repo — that is the whole point.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SDK_VERSION = '10.12.0';
  const SDK_FILES = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-database-compat.js'];

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function showFatal(message) {
    const loader = document.getElementById('globalLoaderEl') || document.getElementById('adminLoader');
    if (loader) {
      loader.classList.add('show');
      loader.style.display = 'flex';
      loader.innerHTML = '<div style="max-width:420px;text-align:center;padding:24px;font-size:14px;line-height:1.7">'
        + '⚠️ <b>Setup incomplete</b><br><span style="opacity:.85">' + message + '</span></div>';
    } else {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="padding:20px;text-align:center">⚠️ ' + message + '</div>');
    }
  }

  async function boot() {
    // 1) runtime config (never hardcoded)
    let cfg;
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (!data.ok || !data.firebase) {
        const missing = (data.error && data.missing) ? data.missing.join(', ') : 'server config';
        throw new Error('Server Firebase config missing: ' + missing + '. Owner: set Vercel Environment Variables, then redeploy.');
      }
      cfg = data.firebase;
    } catch (e) {
      showFatal(e.message || 'Could not reach /api/config. Check deployment.');
      window.ArenaBootError = e;
      document.dispatchEvent(new CustomEvent('arena:boot-error', { detail: e }));
      return;
    }

    // 2) firebase SDKs
    try {
      for (const f of SDK_FILES) {
        await loadScript('https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/' + f);
      }
    } catch (e) {
      showFatal('Could not load Firebase SDK. Check your internet connection.');
      return;
    }

    // 3) init
    try {
      if (!window.firebase || !firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(cfg);
      }
      window.Arena = {
        firebase,
        auth: firebase.auth(),
        db: firebase.database(),
        config: cfg,
        serverTimeOffsetMs: 0,
      };
      // clock skew tracking (cooldown timers stay honest)
      try {
        firebase.database().ref('.info/serverTimeOffset').on('value', (s) => {
          window.Arena.serverTimeOffsetMs = s.val() || 0;
        });
      } catch (_) { /* ignore */ }
      document.dispatchEvent(new CustomEvent('arena:ready'));
    } catch (e) {
      showFatal('Firebase init failed: ' + e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
