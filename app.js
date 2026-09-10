/* Podmen X Tournament Arena — Player app (app.js) */
(function () {
  'use strict';

  // ── helpers ────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtDate = (ts) => {
    if (!ts) return 'TBA';
    try { return new Date(Number(ts)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch { return 'TBA'; }
  };
  function toast(msg, kind) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast ' + (kind || '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; setTimeout(() => d.remove(), 450); }, 3400);
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── state ──────────────────────────────────────────────────
  let auth = null, db = null, user = null;
  let statusFilter = 'all', searchQ = '', sortBy = 'new';
  const S = {
    tournaments: {}, tasks: {}, matches: {},
    announcements: {}, results: {}, ads: null,
    ledger: [], notifs: {}, notifsGlobal: {},
    claims: {}, joined: {}, coins: 0,
  };
  let publicReady = false;

  // ── backend call ───────────────────────────────────────────
  async function api(action, params) {
    if (!auth || !auth.currentUser) throw new Error('Please login first.');
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

  // ── boot ───────────────────────────────────────────────────
  async function boot() {
    bindUI();
    let health;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      health = await r.json();
    } catch {
      return showConfigError(['Could not reach /api/health. Is the backend deployed? Check Vercel env vars.']);
    }
    if (!health || !health.ok) return showConfigError(['Health check failed.']);
    if (!health.publicConfigPresent) {
      // Show EXACT missing variable names so the owner can fix Vercel env.
      return showConfigError(health.missingPublic || ['Unknown missing config']);
    }
    try {
      firebase.initializeApp(health.publicConfig);
    } catch (e) {
      return showConfigError(['Firebase init failed: ' + e.message]);
    }
    auth = firebase.auth();
    db = firebase.database();

    attachPublicListeners();

    auth.onAuthStateChanged(async (u) => {
      user = u;
      renderAuth();
      if (u) {
        try {
          await api('syncUser', { name: u.displayName || '', photo: u.photoURL || '' });
        } catch (e) { toast(e.message, 'err'); }
        attachPrivateListeners();
        refreshJoined().then(renderAll).catch(() => {});
      } else {
        detachPrivate();
        renderAll();
      }
    });

    if (location.hash === '#tasks') switchTab('tasks');
    publicReady = true;
    renderAll();
  }

  function showConfigError(missing) {
    $('configError').innerHTML =
      '<div class="notice err"><b>⚠️ Setup incomplete — Firebase config missing.</b><br>' +
      'Owner: set these in <b>Vercel → Settings → Environment Variables</b> then redeploy:<br>' +
      '<span class="mono">' + esc(missing.join(', ')) + '</span></div>';
  }

  // ── listeners ──────────────────────────────────────────────
  const refs = {};
  function attachPublicListeners() {
    refs.tournaments = db.ref('tournaments');
    refs.tournaments.on('value', (s) => { S.tournaments = s.val() || {}; renderTournaments(); probeJoinedLight(); renderMatches(); });
    refs.tasks = db.ref('tasks');
    refs.tasks.on('value', (s) => { S.tasks = s.val() || {}; renderTasks(); });
    refs.announce = db.ref('announcements');
    refs.announce.on('value', (s) => { S.announcements = s.val() || {}; renderAnnouncements(); renderNotifs(); });
    refs.results = db.ref('results');
    refs.results.on('value', (s) => { S.results = s.val() || {}; renderResults(); });
    refs.ads = db.ref('ads/config');
    refs.ads.on('value', (s) => { S.ads = s.val() || null; renderAds(); });
  }
  // private (per-user) listeners
  let privRefs = [];
  function attachPrivateListeners() {
    detachPrivate();
    const uid = user.uid;
    const r1 = db.ref('users/' + uid + '/coins');
    r1.on('value', (s) => { S.coins = typeof s.val() === 'number' ? s.val() : 0; renderWallet(); });
    privRefs.push(r1);
    const r2 = db.ref('walletLedger/' + uid).limitToLast(25);
    r2.on('value', (s) => { const a = []; s.forEach((c) => a.push({ id: c.key, ...c.val() })); S.ledger = a.reverse(); renderLedger(); });
    privRefs.push(r2);
    const r3 = db.ref('notifications/' + uid).limitToLast(30);
    r3.on('value', (s) => { const v = s.val() || {}; delete v._lastReadAt; S.notifs = v; renderNotifs(); });
    privRefs.push(r3);
    const r4 = db.ref('notificationsGlobal').limitToLast(30);
    r4.on('value', (s) => { S.notifsGlobal = s.val() || {}; renderNotifs(); });
    privRefs.push(r4);
    const r5 = db.ref('taskClaims/' + uid);
    r5.on('value', (s) => { S.claims = s.val() || {}; renderTasks(); });
    privRefs.push(r5);
    const r6 = db.ref('matches');
    r6.on('value', (s) => { S.matches = s.val() || {}; renderMatches(); });
    privRefs.push(r6);
  }
  function detachPrivate() {
    privRefs.forEach((r) => { try { r.off(); } catch {} });
    privRefs = [];
    S.coins = 0; S.ledger = []; S.notifs = {}; S.notifsGlobal = {}; S.claims = {}; S.joined = {}; S.matches = {};
  }

  // Which tournaments did I join? (probe own entry — allowed by security rules)
  async function refreshJoined() {
    S.joined = {};
    if (!user) return;
    const ids = Object.keys(S.tournaments).slice(0, 80);
    await Promise.all(ids.map(async (tid) => {
      try {
        const s = await db.ref('tournamentPlayers/' + tid + '/' + user.uid).get();
        if (s.exists()) S.joined[tid] = s.val();
      } catch { /* ignore */ }
    }));
  }
  const probeJoinedLight = debounce(() => { if (user) refreshJoined().then(() => { renderTournaments(); renderMatches(); }); }, 1200);

  // ── auth UI ────────────────────────────────────────────────
  function renderAuth() {
    const logged = !!user;
    $('loginBtn').style.display = logged ? 'none' : '';
    $('logoutBtn').style.display = logged ? '' : 'none';
    $('userChip').style.display = logged ? '' : 'none';
    $('walletPill').style.display = logged ? '' : 'none';
    if (logged) {
      $('userName').textContent = (user.displayName || user.email || 'Player').split(' ')[0];
      $('userPhoto').src = user.photoURL || '';
      $('userPhoto').style.display = user.photoURL ? '' : 'none';
    }
  }

  // ── renders ────────────────────────────────────────────────
  function statusBadge(st) {
    const m = { upcoming: 'b-upcoming', live: 'b-live', completed: 'b-completed', cancelled: 'b-cancelled' };
    return '<span class="badge ' + (m[st] || 'b-brand') + '">' + esc(st || 'upcoming') + '</span>';
  }

  function tournamentArray() {
    let arr = Object.keys(S.tournaments).map((id) => ({ id, ...S.tournaments[id] }));
    if (statusFilter !== 'all') arr = arr.filter((t) => (t.status || 'upcoming') === statusFilter);
    if (searchQ) {
      const q = searchQ.toLowerCase();
      arr = arr.filter((t) => ((t.title || '') + ' ' + (t.game || '')).toLowerCase().includes(q));
    }
    if (sortBy === 'prize') arr.sort((a, b) => (b.prizeCoins || 0) - (a.prizeCoins || 0));
    else if (sortBy === 'entry') arr.sort((a, b) => (a.entryCoins || 0) - (b.entryCoins || 0));
    else arr.sort((a, b) => (b.startAt || b.createdAt || 0) - (a.startAt || a.createdAt || 0));
    return arr;
  }

  function renderTournaments() {
    const list = $('tourList');
    const arr = tournamentArray();
    $('tourEmpty').style.display = arr.length ? 'none' : '';
    list.innerHTML = arr.map((t) => {
      const joined = !!S.joined[t.id];
      const entry = Number(t.entryCoins || 0);
      const full = (t.maxPlayers > 0 && (t.playersCount || 0) >= t.maxPlayers);
      const closed = t.status === 'completed' || t.status === 'cancelled';
      let btn;
      if (joined) btn = '<button class="btn btn-green btn-block" disabled>✓ Joined' + (t.roomId ? ' · Room: ' + esc(t.roomId) : '') + '</button>';
      else if (closed) btn = '<button class="btn btn-block" disabled>' + esc(t.status) + '</button>';
      else if (full) btn = '<button class="btn btn-block" disabled>Room Full</button>';
      else btn = '<button class="btn btn-primary btn-block" data-join="' + esc(t.id) + '">Join · 🪙 ' + fmtNum(entry) + '</button>';
      return '<div class="card">' +
        '<div class="card-banner">' + (t.bannerUrl ? '<img src="' + esc(t.bannerUrl) + '" alt="" loading="lazy" />' : '🏆') + '</div>' +
        '<div class="card-body">' +
        '<h3 class="card-title">' + esc(t.title || 'Tournament') + '</h3>' +
        '<div class="card-meta">' + statusBadge(t.status) + '<span class="badge b-brand">' + esc(t.game || 'Game') + '</span>' +
        (joined ? '<span class="badge b-completed">joined ✓</span>' : '') + '</div>' +
        '<div class="prize-row"><span>💰 Prize</span><b>🪙 ' + fmtNum(t.prizeCoins) + '</b></div>' +
        '<div class="prize-row"><span>👥 Players</span><b>' + fmtNum(t.playersCount) + (t.maxPlayers ? ' / ' + fmtNum(t.maxPlayers) : '') + '</b></div>' +
        '<div class="card-meta">🕒 ' + esc(fmtDate(t.startAt)) + '</div>' +
        (t.description ? '<p style="color:var(--muted);font-size:13px;margin:0">' + esc(String(t.description).slice(0, 140)) + '</p>' : '') +
        (joined && t.roomPass ? '<div class="notice ok" style="margin:0">🔑 Room pass: <b>' + esc(t.roomPass) + '</b></div>' : '') +
        btn +
        '</div></div>';
    }).join('');
    list.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => openJoin(b.getAttribute('data-join'))));
  }

  function renderMatches() {
    const box = $('matchFeed');
    const ms = Object.keys(S.matches).map((id) => ({ id, ...S.matches[id] }));
    if (!user) { box.innerHTML = '<div class="empty">🔐 Login to see live match feed with room details.</div>'; return; }
    if (!ms.length) { box.innerHTML = '<div class="empty">No matches yet. Joined tournament matches will appear here.</div>'; return; }
    ms.sort((a, b) => ((S.joined[b.tournamentId] ? 1 : 0) - (S.joined[a.tournamentId] ? 1 : 0)) || ((b.startAt || 0) - (a.startAt || 0)));
    box.innerHTML = ms.slice(0, 60).map((m) => {
      const t = S.tournaments[m.tournamentId] || {};
      const mine = !!S.joined[m.tournamentId];
      return '<div class="row-card">' +
        '<h4>' + esc(m.title || 'Match') + ' ' + statusBadge(m.status) + (mine ? ' <span class="badge b-completed">my tournament</span>' : '') + '</h4>' +
        '<p>🏆 ' + esc(t.title || m.tournamentId || '') + ' · 🕒 ' + esc(fmtDate(m.startAt)) + '</p>' +
        '<p>🔵 <b>' + esc(m.teamA || 'TBD') + '</b> ' + esc(m.scoreA || 0) + ' — ' + esc(m.scoreB || 0) + ' <b>' + esc(m.teamB || 'TBD') + '</b> 🔴</p>' +
        (mine && (m.roomId || m.roomPass) ? '<p>🚪 Room: <b>' + esc(m.roomId || '-') + '</b> · 🔑 Pass: <b>' + esc(m.roomPass || '-') + '</b></p>' : '') +
        (m.streamUrl ? '<div class="row-actions"><a class="btn btn-sm" href="' + esc(m.streamUrl) + '" target="_blank" rel="noopener">▶ Watch stream</a></div>' : '') +
        '</div>';
    }).join('');
  }

  function renderTasks() {
    const box = $('taskList');
    const arr = Object.keys(S.tasks).map((id) => ({ id, ...S.tasks[id] })).filter((t) => t.active !== false);
    if (!arr.length) { box.innerHTML = '<div class="empty">No tasks right now. Check back soon! 🎁</div>'; return; }
    arr.sort((a, b) => (b.rewardCoins || 0) - (a.rewardCoins || 0));
    box.innerHTML = arr.map((t) => {
      const claim = S.claims[t.id];
      let action;
      if (!user) action = '<button class="btn btn-gold btn-sm" data-loginfirst="1">Login to claim</button>';
      else if (claim && claim.status === 'approved') action = '<button class="btn btn-sm" disabled>✓ Claimed</button>';
      else if (claim && claim.status === 'pending') action = '<button class="btn btn-sm" disabled>⏳ Pending verification</button>';
      else action = '<button class="btn btn-gold btn-sm" data-claim="' + esc(t.id) + '">Claim 🪙 ' + fmtNum(t.rewardCoins) + '</button>';
      return '<div class="row-card"><h4>' + esc(t.title || 'Task') + ' <span class="badge b-gold">🪙 ' + fmtNum(t.rewardCoins) + '</span>' +
        (t.verification === 'manual' ? ' <span class="badge b-brand">manual verify</span>' : '') + '</h4>' +
        (t.description ? '<p>' + esc(t.description) + '</p>' : '') +
        '<div class="row-actions">' + (t.link ? '<a class="btn btn-sm" href="' + esc(t.link) + '" target="_blank" rel="noopener">🔗 Open task</a>' : '') + action + '</div></div>';
    }).join('');
    box.querySelectorAll('[data-loginfirst]').forEach((b) => b.addEventListener('click', doLogin));
    box.querySelectorAll('[data-claim]').forEach((b) => b.addEventListener('click', () => claimTask(b.getAttribute('data-claim'))));
  }

  function renderWallet() {
    $('walletCoins').textContent = fmtNum(S.coins);
    $('walletBig').textContent = fmtNum(S.coins);
  }

  function renderLedger() {
    const box = $('ledgerList');
    if (!user) { box.innerHTML = '<div class="empty">🔐 Login to view your wallet.</div>'; return; }
    if (!S.ledger.length) { box.innerHTML = '<div class="empty">No transactions yet. Join a tournament or claim a task!</div>'; return; }
    box.innerHTML = S.ledger.map((l) => {
      const pos = Number(l.amount) >= 0;
      return '<div class="row-card"><h4 style="color:' + (pos ? 'var(--green)' : 'var(--red)') + '">' + (pos ? '+' : '') + fmtNum(l.amount) + ' 🪙</h4>' +
        '<p>' + esc(l.reason || l.type || '') + ' · ' + esc(fmtDate(l.createdAt)) + ' · bal: ' + fmtNum(l.balanceAfter) + '</p></div>';
    }).join('');
  }

  function renderAnnouncements() {
    const box = $('announceList');
    const arr = Object.keys(S.announcements).map((id) => ({ id, ...S.announcements[id] })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3);
    box.innerHTML = arr.map((a) => '<div class="row-card announce">📢 <b>' + esc(a.title || 'Announcement') + '</b><p>' + esc(a.text || '') + '</p></div>').join('');
  }

  function renderNotifs() {
    const box = $('notifList');
    const mine = Object.keys(S.notifs).map((id) => ({ id, scope: 'user', ...S.notifs[id] }));
    const glob = Object.keys(S.notifsGlobal).map((id) => ({ id, scope: 'global', ...S.notifsGlobal[id] }));
    const all = [...mine, ...glob].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
    const unread = mine.filter((n) => !n.read).length;
    $('notifDot').textContent = unread ? '(' + unread + ')' : '';
    if (!user) { box.innerHTML = '<div class="empty">🔐 Login to receive notifications.</div>'; return; }
    if (!all.length) { box.innerHTML = '<div class="empty">No notifications yet.</div>'; return; }
    box.innerHTML = all.map((n) =>
      '<div class="row-card"><h4>' + (n.read === false ? '🔵 ' : '') + esc(n.title || 'Notification') + '</h4>' +
      '<p>' + esc(n.body || '') + ' · ' + esc(fmtDate(n.createdAt)) + '</p>' +
      (n.scope === 'user' && n.read === false ? '<div class="row-actions"><button class="btn btn-sm" data-read="' + esc(n.id) + '">Mark read</button></div>' : '') +
      '</div>').join('');
    box.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('markNotificationRead', { id: b.getAttribute('data-read') }); } catch (e) { toast(e.message, 'err'); }
    }));
  }

  function renderResults() {
    const box = $('resultList');
    const arr = Object.keys(S.results).map((id) => ({ id, ...S.results[id] })).sort((a, b) => (b.declaredAt || 0) - (a.declaredAt || 0)).slice(0, 20);
    if (!arr.length) { box.innerHTML = '<div class="empty">No results declared yet.</div>'; return; }
    box.innerHTML = arr.map((r) => {
      const t = S.tournaments[r.tournamentId] || {};
      return '<div class="row-card"><h4>🏁 ' + esc(t.title || r.tournamentId) + '</h4>' +
        '<p>🥇 Winner: <b>' + esc(r.winnerName || r.winnerUid || '-') + '</b> · 💰 🪙 ' + fmtNum(r.prizeCoins) + '</p>' +
        (r.note ? '<p>' + esc(r.note) + '</p>' : '') + '</div>';
    }).join('');
  }

  function renderAds() {
    const box = $('adBanner');
    if (S.ads && S.ads.enabled !== false && S.ads.topBannerEnabled !== false && S.ads.bannerText) {
      const inner = esc(S.ads.bannerText);
      box.innerHTML = S.ads.bannerLink
        ? '<a href="' + esc(S.ads.bannerLink) + '" target="_blank" rel="noopener" style="text-decoration:none"><div class="ad-banner">' + inner + '</div></a>'
        : '<div class="ad-banner">' + inner + '</div>';
    } else box.innerHTML = '';
  }

  function renderAll() {
    if (!publicReady && !Object.keys(S.tournaments).length) { /* still render empties */ }
    renderAuth(); renderTournaments(); renderMatches(); renderTasks();
    renderWallet(); renderLedger(); renderAnnouncements(); renderNotifs(); renderResults(); renderAds();
  }

  // ── join flow ──────────────────────────────────────────────
  let joinTid = null;
  function openJoin(tid) {
    if (!user) { toast('Please login with Google first.', 'err'); doLogin(); return; }
    const t = S.tournaments[tid];
    if (!t) return;
    joinTid = tid;
    $('joinTitle').textContent = 'Join: ' + (t.title || '');
    $('joinInfo').textContent = 'Entry: 🪙 ' + fmtNum(t.entryCoins) + ' · Prize: 🪙 ' + fmtNum(t.prizeCoins) + ' · ' + fmtDate(t.startAt);
    $('ignInput').value = '';
    $('joinModal').classList.add('open');
  }

  async function claimTask(taskId) {
    const t = S.tasks[taskId];
    if (!t) return;
    if (t.verification === 'manual') {
      $('proofInput').value = '';
      $('proofModal').classList.add('open');
      $('proofModal').dataset.task = taskId;
      if (t.link) window.open(t.link, '_blank', 'noopener');
      return;
    }
    if (t.link) window.open(t.link, '_blank', 'noopener');
    try {
      toast('Claiming…');
      const r = await api('claimTask', { taskId });
      toast('🎉 +' + fmtNum(r.rewardCoins) + ' coins added!', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ── auth actions ───────────────────────────────────────────
  async function doLogin() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
      toast('Welcome! 🎮', 'ok');
    } catch (e) {
      // Popup blocked on some mobile browsers → fallback to redirect.
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) {
        try { await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider()); return; }
        catch (e2) { toast(e2.message, 'err'); return; }
      }
      toast(e.message, 'err');
    }
  }

  // ── tabs ───────────────────────────────────────────────────
  function switchTab(name) {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  }

  // ── UI bindings ────────────────────────────────────────────
  function bindUI() {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.querySelectorAll('#statusChips .chip').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#statusChips .chip').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      statusFilter = b.dataset.status;
      renderTournaments();
    }));
    $('search').addEventListener('input', debounce((e) => { searchQ = e.target.value.trim(); renderTournaments(); }, 200));
    $('sortSel').addEventListener('change', (e) => { sortBy = e.target.value; renderTournaments(); });
    $('loginBtn').addEventListener('click', doLogin);
    $('logoutBtn').addEventListener('click', () => auth.signOut());
    $('joinCancel').addEventListener('click', () => $('joinModal').classList.remove('open'));
    $('joinConfirm').addEventListener('click', async () => {
      const ign = $('ignInput').value.trim();
      $('joinConfirm').disabled = true;
      try {
        const r = await api('joinTournament', { tournamentId: joinTid, inGameName: ign });
        $('joinModal').classList.remove('open');
        toast('✅ Joined! Balance: 🪙 ' + fmtNum(r.balanceAfter), 'ok');
        await refreshJoined(); renderTournaments(); renderMatches(); switchTab('matches');
      } catch (e) { toast(e.message, 'err'); }
      $('joinConfirm').disabled = false;
    });
    $('proofCancel').addEventListener('click', () => $('proofModal').classList.remove('open'));
    $('proofConfirm').addEventListener('click', async () => {
      const taskId = $('proofModal').dataset.task;
      const proof = $('proofInput').value.trim();
      if (!proof) { toast('Please paste your proof.', 'err'); return; }
      $('proofConfirm').disabled = true;
      try {
        await api('claimTask', { taskId, proof });
        $('proofModal').classList.remove('open');
        toast('Submitted! Admin will verify soon. ⏳', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      $('proofConfirm').disabled = false;
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
