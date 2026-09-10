/* Podmen X Tournament Arena — Admin panel (admin.js) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtDate = (ts) => {
    if (!ts) return '—';
    try { return new Date(Number(ts)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch { return '—'; }
  };
  const toLocal = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const fromLocal = (v) => (v ? new Date(v).getTime() : 0);
  function toast(msg, kind) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast ' + (kind || '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; setTimeout(() => d.remove(), 450); }, 3400);
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  let auth = null, db = null, isAdmin = false;
  const S = { tournaments: {}, matches: {}, tasks: {}, announcements: {}, results: {}, ads: null, users: [], claims: [] };

  async function api(action, params) {
    if (!auth || !auth.currentUser) throw new Error('Login expired. Please login again.');
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ action, ...(params || {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error((data.error && data.error.message) || 'Request failed');
    return data;
  }

  async function boot() {
    bindUI();
    let health;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      health = await r.json();
    } catch {
      return showConfigError(['Could not reach /api/health. Deploy backend + set Vercel env vars.']);
    }
    renderHealthBadge(health);
    if (!health || !health.ok) return showConfigError(['Health check failed.']);
    if (!health.publicConfigPresent) return showConfigError(health.missingPublic || ['Unknown']);
    try { firebase.initializeApp(health.publicConfig); }
    catch (e) { return showConfigError(['Firebase init failed: ' + e.message]); }
    auth = firebase.auth();
    db = firebase.database();

    auth.onAuthStateChanged(async (u) => {
      if (!u) { showLogin(); return; }
      $('adminEmail').textContent = u.email || u.uid;
      $('logoutBtn').style.display = '';
      try {
        await api('adminPing', {});
        isAdmin = true;
        showDash();
        attachListeners();
        await Promise.all([loadUsers(), loadClaims(), loadHealth()]);
      } catch (e) {
        isAdmin = false;
        $('loginCard').style.display = '';
        $('dash').style.display = 'none';
        $('loginMsg').innerHTML = '<div class="notice err">⛔ <b>Not an admin.</b> ' + esc(e.message) +
          '<br>Your UID: <span class="mono">' + esc(u.uid) + '</span><br>' +
          'Owner fix: add this UID to <b>ADMIN_UIDS</b> in Vercel env (redeploy), then login again.</div>';
      }
    });
  }

  function showConfigError(missing) {
    $('configError').innerHTML =
      '<div class="notice err"><b>⚠️ Setup incomplete.</b> Set in Vercel → Environment Variables then redeploy:<br>' +
      '<span class="mono">' + esc(missing.join(', ')) + '</span></div>';
    $('loginCard').style.display = 'none';
  }

  function showLogin() {
    $('loginCard').style.display = '';
    $('dash').style.display = 'none';
    $('logoutBtn').style.display = 'none';
    $('adminEmail').textContent = '';
  }
  function showDash() {
    $('loginCard').style.display = 'none';
    $('dash').style.display = '';
    $('loginMsg').innerHTML = '';
  }

  function renderHealthBadge(h) {
    const b = $('healthBadge');
    if (!h || !h.ok) { b.className = 'badge b-cancelled'; b.textContent = '● health: unreachable'; return; }
    const okAll = h.publicConfigPresent && h.adminSdk && h.adminSdk.configured;
    b.className = 'badge ' + (okAll ? 'b-completed' : 'b-live');
    b.textContent = okAll ? '● systems OK' : '● config issue';
  }

  // ── realtime (admin-authenticated reads) ─────────────────────
  function attachListeners() {
    db.ref('tournaments').on('value', (s) => { S.tournaments = s.val() || {}; renderTournaments(); fillTourSelects(); });
    db.ref('matches').on('value', (s) => { S.matches = s.val() || {}; renderMatches(); });
    db.ref('tasks').on('value', (s) => { S.tasks = s.val() || {}; renderTasks(); });
    db.ref('announcements').on('value', (s) => { S.announcements = s.val() || {}; renderAnnouncements(); });
    db.ref('results').on('value', (s) => { S.results = s.val() || {}; renderResults(); });
    db.ref('ads/config').on('value', (s) => { S.ads = s.val() || null; fillAds(); });
  }

  // ── tournaments ────────────────────────────────────────────
  function renderTournaments() {
    const arr = Object.keys(S.tournaments).map((id) => ({ id, ...S.tournaments[id] }))
      .sort((a, b) => (b.createdAt || b.startAt || 0) - (a.createdAt || a.startAt || 0));
    $('tList').innerHTML = arr.length ? arr.map((t) =>
      '<div class="row-card"><h4>' + esc(t.title) + ' <span class="badge b-brand">' + esc(t.status || '') + '</span></h4>' +
      '<p>🎮 ' + esc(t.game || '') + ' · 🪙 entry ' + fmtNum(t.entryCoins) + ' · 💰 prize ' + fmtNum(t.prizeCoins) +
      ' · 👥 ' + fmtNum(t.playersCount) + '/' + fmtNum(t.maxPlayers) + ' · 🕒 ' + esc(fmtDate(t.startAt)) + '</p>' +
      '<div class="row-actions"><button class="btn btn-sm" data-tedit="' + esc(t.id) + '">✏️ Edit</button>' +
      '<button class="btn btn-sm" data-tentries="' + esc(t.id) + '">🎫 Players</button>' +
      '<button class="btn btn-danger btn-sm" data-tdel="' + esc(t.id) + '">🗑 Delete</button></div></div>'
    ).join('') : '<div class="empty">No tournaments yet. Create one! 🏆</div>';
    bindListButtons();
  }
  function fillTourSelects() {
    const opts = Object.keys(S.tournaments).map((id) =>
      '<option value="' + esc(id) + '">' + esc(S.tournaments[id].title || id) + '</option>').join('');
    ['mTour', 'eTour', 'rTour'].forEach((sid) => { $(sid).innerHTML = opts || '<option value="">— none —</option>'; });
  }

  // ── matches ────────────────────────────────────────────────
  function renderMatches() {
    const arr = Object.keys(S.matches).map((id) => ({ id, ...S.matches[id] }))
      .sort((a, b) => (b.startAt || 0) - (a.startAt || 0));
    $('mList').innerHTML = arr.length ? arr.map((m) => {
      const t = S.tournaments[m.tournamentId] || {};
      return '<div class="row-card"><h4>' + esc(m.title) + ' <span class="badge b-brand">' + esc(m.status || '') + '</span></h4>' +
        '<p>🏆 ' + esc(t.title || m.tournamentId || '') + ' · 🔵 ' + esc(m.teamA || 'TBD') + ' ' + esc(m.scoreA || 0) +
        ' — ' + esc(m.scoreB || 0) + ' ' + esc(m.teamB || 'TBD') + ' 🔴 · 🕒 ' + esc(fmtDate(m.startAt)) + '</p>' +
        '<div class="row-actions"><button class="btn btn-sm" data-medit="' + esc(m.id) + '">✏️ Edit / score</button>' +
        '<button class="btn btn-danger btn-sm" data-mdel="' + esc(m.id) + '">🗑 Delete</button></div></div>';
    }).join('') : '<div class="empty">No matches yet.</div>';
    bindListButtons();
  }

  // ── tasks + claims ─────────────────────────────────────────
  function renderTasks() {
    const arr = Object.keys(S.tasks).map((id) => ({ id, ...S.tasks[id] }));
    $('kList').innerHTML = arr.length ? arr.map((t) =>
      '<div class="row-card"><h4>' + esc(t.title) + ' <span class="badge b-gold">🪙 ' + fmtNum(t.rewardCoins) + '</span> ' +
      '<span class="badge b-brand">' + esc(t.verification || 'auto') + '</span> ' +
      (t.active === false ? '<span class="badge b-cancelled">disabled</span>' : '<span class="badge b-completed">active</span>') + '</h4>' +
      (t.description ? '<p>' + esc(t.description) + '</p>' : '') +
      '<div class="row-actions"><button class="btn btn-sm" data-kedit="' + esc(t.id) + '">✏️ Edit</button>' +
      '<button class="btn btn-danger btn-sm" data-kdel="' + esc(t.id) + '">🗑 Delete</button></div></div>'
    ).join('') : '<div class="empty">No tasks yet.</div>';
    bindListButtons();
  }
  async function loadClaims() {
    try {
      const r = await api('adminListClaims', { status: 'pending' });
      S.claims = r.claims || [];
    } catch (e) { S.claims = []; }
    $('claimCount').textContent = S.claims.length ? '(' + S.claims.length + ')' : '';
    $('claimList').innerHTML = S.claims.length ? S.claims.map((c) =>
      '<div class="row-card"><h4>' + esc(c.taskTitle || c.taskId) + ' <span class="badge b-gold">🪙 ' + fmtNum(c.rewardCoins) + '</span></h4>' +
      '<p>👤 <span class="mono">' + esc(c.uid) + '</span> · 🕒 ' + esc(fmtDate(c.claimedAt)) + '</p>' +
      (c.proof ? '<p>🧾 Proof: ' + esc(c.proof) + '</p>' : '') +
      '<div class="row-actions"><button class="btn btn-green btn-sm" data-vok="' + esc(c.uid) + '|' + esc(c.taskId) + '">✅ Approve + pay</button>' +
      '<button class="btn btn-danger btn-sm" data-vno="' + esc(c.uid) + '|' + esc(c.taskId) + '">❌ Reject</button></div></div>'
    ).join('') : '<div class="empty">No pending claims. 🎉</div>';
    bindListButtons();
  }

  // ── users ──────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const r = await api('adminListUsers', { limit: 100 });
      S.users = r.users || [];
    } catch (e) { toast(e.message, 'err'); S.users = []; }
    renderUsers('');
  }
  function renderUsers(q) {
    q = (q || '').toLowerCase();
    const arr = S.users.filter((u) => !q || ((u.name || '') + ' ' + (u.email || '') + ' ' + u.uid).toLowerCase().includes(q));
    $('uRows').innerHTML = arr.map((u) =>
      '<tr><td><b>' + esc(u.name || 'Player') + '</b><br><span style="color:var(--muted)">' + esc(u.email || '') + '</span></td>' +
      '<td>🪙 <b>' + fmtNum(u.coins) + '</b></td>' +
      '<td class="mono" style="max-width:150px;overflow:hidden;text-overflow:ellipsis">' + esc(u.uid) + '</td>' +
      '<td><button class="btn btn-sm" data-pick="' + esc(u.uid) + '">Select</button></td></tr>'
    ).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No users found.</td></tr>';
    bindListButtons();
  }

  // ── results ────────────────────────────────────────────────
  function renderResults() {
    const arr = Object.keys(S.results).map((id) => ({ id, ...S.results[id] }))
      .sort((a, b) => (b.declaredAt || 0) - (a.declaredAt || 0));
    $('rList').innerHTML = arr.length ? arr.map((r) => {
      const t = S.tournaments[r.tournamentId] || {};
      return '<div class="row-card"><h4>🏁 ' + esc(t.title || r.tournamentId) + '</h4>' +
        '<p>🥇 ' + esc(r.winnerName || r.winnerUid || '-') + ' · 💰 🪙 ' + fmtNum(r.prizeCoins) + ' · ' + esc(fmtDate(r.declaredAt)) + '</p></div>';
    }).join('') : '<div class="empty">No results declared yet.</div>';
  }

  // ── announcements ──────────────────────────────────────────
  function renderAnnouncements() {
    const arr = Object.keys(S.announcements).map((id) => ({ id, ...S.announcements[id] }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('aList').innerHTML = arr.length ? arr.map((a) =>
      '<div class="row-card announce"><b>' + esc(a.title || 'Announcement') + '</b><p>' + esc(a.text || '') + '</p>' +
      '<div class="row-actions"><button class="btn btn-danger btn-sm" data-adel="' + esc(a.id) + '">Delete</button></div></div>'
    ).join('') : '<div class="empty">No announcements.</div>';
    bindListButtons();
  }

  // ── ads / health ───────────────────────────────────────────
  function fillAds() {
    if (!S.ads) return;
    $('adEnabled').value = S.ads.enabled === false ? 'false' : 'true';
    $('adTop').value = S.ads.topBannerEnabled === false ? 'false' : 'true';
    if (document.activeElement !== $('adText')) $('adText').value = S.ads.bannerText || '';
    if (document.activeElement !== $('adLink')) $('adLink').value = S.ads.bannerLink || '';
  }
  async function loadHealth() {
    try {
      const [h, rt] = await Promise.all([
        fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/runtime', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      ]);
      renderHealthBadge(h);
      $('healthBox').innerHTML =
        '<h4>💚 Health <span class="health-dot ' + (h.publicConfigPresent ? 'health-ok' : 'health-bad') + '"></span></h4>' +
        '<div class="kv"><span>Public config</span><b>' + (h.publicConfigPresent ? 'OK' : 'MISSING: ' + esc((h.missingPublic || []).join(', '))) + '</b></div>' +
        '<div class="kv"><span>Admin SDK</span><b>' + (h.adminSdk && h.adminSdk.configured ? 'connected ✓ (canRead=' + !!h.adminSdk.canRead + ')' : 'NOT configured ✗ ' + esc((h.adminSdk && h.adminSdk.error) || '')) + '</b></div>' +
        '<div class="kv"><span>App Check enforce</span><b>' + esc(String(h.appCheckEnforce)) + '</b></div>' +
        '<div class="kv"><span>Runtime</span><b>' + esc((h.runtime || {}).node || '') + ' · ' + esc((h.runtime || {}).vercelEnv || '') + ' · ' + esc((h.runtime || {}).region || '') + '</b></div>' +
        (rt ? '<div class="kv"><span>Probe</span><b>node ' + esc(rt.node || '') + ' · serverCreds=' + esc(String(rt.hasServerCredentials)) + '</b></div>' : '') +
        '<p style="color:var(--muted);font-size:12px">Full JSON: <a href="/api/health" target="_blank">/api/health</a> · <a href="/api/runtime" target="_blank">/api/runtime</a></p>';
    } catch (e) { $('healthBox').innerHTML = '<div class="notice err">' + esc(e.message) + '</div>'; }
  }

  // ── delegated list buttons ─────────────────────────────────
  function bindListButtons() {
    document.querySelectorAll('[data-tedit]').forEach((b) => b.onclick = () => editTournament(b.getAttribute('data-tedit')));
    document.querySelectorAll('[data-tdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this tournament?')) return;
      try { await api('deleteTournament', { id: b.getAttribute('data-tdel') }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-tentries]').forEach((b) => b.onclick = () => { $('eTour').value = b.getAttribute('data-tentries'); switchTab('users'); loadEntries(); });
    document.querySelectorAll('[data-medit]').forEach((b) => b.onclick = () => editMatch(b.getAttribute('data-medit')));
    document.querySelectorAll('[data-mdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this match?')) return;
      try { await api('deleteMatch', { id: b.getAttribute('data-mdel') }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-kedit]').forEach((b) => b.onclick = () => editTask(b.getAttribute('data-kedit')));
    document.querySelectorAll('[data-kdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this task?')) return;
      try { await api('deleteTask', { id: b.getAttribute('data-kdel') }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-vok]').forEach((b) => b.onclick = async () => {
      const [uid, taskId] = b.getAttribute('data-vok').split('|');
      try { const r = await api('verifyTask', { uid, taskId, approve: true }); toast('Approved! Paid 🪙 ' + fmtNum(r.rewardCoins), 'ok'); loadClaims(); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-vno]').forEach((b) => b.onclick = async () => {
      const [uid, taskId] = b.getAttribute('data-vno').split('|');
      if (!confirm('Reject this claim?')) return;
      try { await api('verifyTask', { uid, taskId, approve: false }); toast('Rejected'); loadClaims(); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { $('adjUid').value = b.getAttribute('data-pick'); toast('UID selected ✓'); });
    document.querySelectorAll('[data-adel]').forEach((b) => b.onclick = async () => {
      try { await api('deleteAnnouncement', { id: b.getAttribute('data-adel') }); toast('Deleted'); } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ── form fills ─────────────────────────────────────────────
  function editTournament(id) {
    const t = S.tournaments[id]; if (!t) return;
    $('tFormCard').style.display = '';
    $('tFormTitle').textContent = 'Edit tournament';
    $('tId').value = id; $('tTitle').value = t.title || ''; $('tGame').value = t.game || '';
    $('tEntry').value = t.entryCoins || 0; $('tPrize').value = t.prizeCoins || 0; $('tMax').value = t.maxPlayers || 0;
    $('tStatus').value = t.status || 'upcoming'; $('tStart').value = toLocal(t.startAt);
    $('tBanner').value = t.bannerUrl || ''; $('tRoomId').value = t.roomId || ''; $('tRoomPass').value = t.roomPass || '';
    $('tDesc').value = t.description || ''; $('tRules').value = t.rules || '';
    $('tFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function editMatch(id) {
    const m = S.matches[id]; if (!m) return;
    $('mFormCard').style.display = '';
    $('mId').value = id; $('mTour').value = m.tournamentId || ''; $('mTitle').value = m.title || '';
    $('mTeamA').value = m.teamA || ''; $('mTeamB').value = m.teamB || '';
    $('mScoreA').value = m.scoreA || 0; $('mScoreB').value = m.scoreB || 0;
    $('mStatus').value = m.status || 'upcoming'; $('mStart').value = toLocal(m.startAt);
    $('mRoomId').value = m.roomId || ''; $('mRoomPass').value = m.roomPass || ''; $('mStream').value = m.streamUrl || '';
    $('mFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function editTask(id) {
    const t = S.tasks[id]; if (!t) return;
    $('kFormCard').style.display = '';
    $('kId').value = id; $('kTitle').value = t.title || ''; $('kReward').value = t.rewardCoins || 0;
    $('kLink').value = t.link || ''; $('kVer').value = t.verification || 'auto';
    $('kActive').value = t.active === false ? 'false' : 'true'; $('kDesc').value = t.description || '';
    $('kFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadEntries() {
    const tid = $('eTour').value;
    if (!tid) { $('eList').innerHTML = '<div class="empty">No tournament selected.</div>'; return; }
    $('eList').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const r = await api('adminListEntries', { tournamentId: tid });
      $('eList').innerHTML = r.entries.length
        ? '<div class="notice ok">👥 ' + r.count + ' player(s) joined.</div>' + r.entries.map((e) =>
          '<div class="row-card"><h4>' + esc(e.inGameName || e.name || 'Player') + '</h4>' +
          '<p class="mono">' + esc(e.uid) + ' · 🕒 ' + esc(fmtDate(e.joinedAt)) + '</p></div>').join('')
        : '<div class="empty">No players yet.</div>';
    } catch (e) { $('eList').innerHTML = '<div class="notice err">' + esc(e.message) + '</div>'; }
  }

  function switchTab(name) {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    if (name === 'tasks') loadClaims();
    if (name === 'health') loadHealth();
  }

  // ── bindings ───────────────────────────────────────────────
  function bindUI() {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('loginBtn').addEventListener('click', async () => {
      const email = $('email').value.trim(), password = $('password').value;
      if (!email || !password) { toast('Enter email + password', 'err'); return; }
      $('loginBtn').disabled = true;
      try { await auth.signInWithEmailAndPassword(email, password); }
      catch (e) { $('loginMsg').innerHTML = '<div class="notice err">' + esc(e.message) + '</div>'; }
      $('loginBtn').disabled = false;
    });
    $('logoutBtn').addEventListener('click', () => auth.signOut());

    // tournaments
    $('tNew').addEventListener('click', () => {
      $('tFormCard').style.display = ''; $('tFormTitle').textContent = 'New tournament';
      ['tId', 'tTitle', 'tGame', 'tBanner', 'tRoomId', 'tRoomPass', 'tDesc', 'tRules'].forEach((i) => $(i).value = '');
      $('tGame').value = 'BGMI'; $('tEntry').value = 10; $('tPrize').value = 100; $('tMax').value = 100;
      $('tStatus').value = 'upcoming'; $('tStart').value = '';
    });
    $('tCancel').addEventListener('click', () => $('tFormCard').style.display = 'none');
    $('tSave').addEventListener('click', async () => {
      try {
        await api('upsertTournament', {
          id: $('tId').value.trim() || undefined, title: $('tTitle').value, game: $('tGame').value,
          entryCoins: Number($('tEntry').value), prizeCoins: Number($('tPrize').value), maxPlayers: Number($('tMax').value),
          status: $('tStatus').value, startAt: fromLocal($('tStart').value), bannerUrl: $('tBanner').value,
          roomId: $('tRoomId').value, roomPass: $('tRoomPass').value, description: $('tDesc').value, rules: $('tRules').value,
        });
        $('tFormCard').style.display = 'none';
        toast('Tournament saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // matches
    $('mNew').addEventListener('click', () => { $('mFormCard').style.display = ''; $('mId').value = ''; });
    $('mCancel').addEventListener('click', () => $('mFormCard').style.display = 'none');
    $('mSave').addEventListener('click', async () => {
      try {
        await api('upsertMatch', {
          id: $('mId').value.trim() || undefined, tournamentId: $('mTour').value, title: $('mTitle').value,
          teamA: $('mTeamA').value, teamB: $('mTeamB').value, scoreA: Number($('mScoreA').value), scoreB: Number($('mScoreB').value),
          status: $('mStatus').value, startAt: fromLocal($('mStart').value),
          roomId: $('mRoomId').value, roomPass: $('mRoomPass').value, streamUrl: $('mStream').value,
        });
        $('mFormCard').style.display = 'none';
        toast('Match saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // tasks
    $('kNew').addEventListener('click', () => { $('kFormCard').style.display = ''; $('kId').value = ''; });
    $('kCancel').addEventListener('click', () => $('kFormCard').style.display = 'none');
    $('kSave').addEventListener('click', async () => {
      try {
        await api('upsertTask', {
          id: $('kId').value.trim() || undefined, title: $('kTitle').value, rewardCoins: Number($('kReward').value),
          link: $('kLink').value, verification: $('kVer').value, active: $('kActive').value === 'true', description: $('kDesc').value,
        });
        $('kFormCard').style.display = 'none';
        toast('Task saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // users
    $('uRefresh').addEventListener('click', loadUsers);
    $('uSearch').addEventListener('input', debounce((e) => renderUsers(e.target.value), 200));
    $('adjGo').addEventListener('click', async () => {
      try {
        const r = await api('adjustCoins', { uid: $('adjUid').value.trim(), amount: Number($('adjAmt').value), reason: $('adjReason').value || 'admin adjustment' });
        toast('Done! New balance: 🪙 ' + fmtNum(r.balanceAfter), 'ok');
        loadUsers();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('mkAdmin').addEventListener('click', async () => {
      try { await api('setAdmin', { uid: $('adjUid').value.trim(), allow: true }); toast('Admin added ✓', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('rmAdmin').addEventListener('click', async () => {
      try { await api('setAdmin', { uid: $('adjUid').value.trim(), allow: false }); toast('Admin removed'); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('eLoad').addEventListener('click', loadEntries);

    // results
    $('rGo').addEventListener('click', async () => {
      if (!confirm('Declare result + credit prize? Tournament will be marked completed.')) return;
      try {
        await api('setResult', {
          tournamentId: $('rTour').value, winnerUid: $('rUid').value.trim(),
          winnerName: $('rName').value, prizeCoins: Number($('rPrize').value), note: $('rNote').value,
        });
        toast('🏆 Result declared + prize credited!', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // push
    $('aGo').addEventListener('click', async () => {
      try { await api('announce', { title: $('aTitle').value, text: $('aText').value }); $('aTitle').value = ''; $('aText').value = ''; toast('Published 📣', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('nGo').addEventListener('click', async () => {
      try {
        await api('notify', { mode: $('nMode').value, uid: $('nUid').value.trim(), title: $('nTitle').value, body: $('nBody').value });
        $('nTitle').value = ''; $('nBody').value = ''; toast('Sent 🔔', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    // ads
    $('adGo').addEventListener('click', async () => {
      try {
        await api('adConfig', {
          enabled: $('adEnabled').value === 'true', topBannerEnabled: $('adTop').value === 'true',
          bannerText: $('adText').value, bannerLink: $('adLink').value,
        });
        toast('Ad config saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
