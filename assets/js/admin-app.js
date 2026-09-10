/* ═══════════════════════════════════════════════════════════════
   ARENA X — admin panel. Written from scratch.
   Reads come from realtime DB (admin) + server feed (works for every
   admin). Every WRITE goes through /api/command with an admin check.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtD = (ts) => { if (!ts) return '—'; try { return new Date(Number(ts)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return '—'; } };
  const toLocal = (ts) => { if (!ts) return ''; const d = new Date(Number(ts)); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  const fromLocal = (v) => (v ? new Date(v).getTime() : 0);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function toast(msg, kind) {
    const box = $('adToasts'); if (!box) return;
    const d = document.createElement('div');
    d.className = 'ad-toast ' + (kind || '');
    d.textContent = msg; box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; setTimeout(() => d.remove(), 450); }, 3400);
  }
  function showLoader(on) { $('adminLoader').classList.toggle('show', !!on); }
  function modal(id) { return new bootstrap.Modal($(id)); }

  let auth = null, db = null, isAdmin = false;
  const S = {
    games: {}, promos: {}, tournaments: {}, settings: {},
    users: [], withdrawals: [], deposits: [], referrals: [], notifHist: [],
    wdTab: 'pending', dpTab: 'pending', rfTab: 'pending', theme: 'midnight',
  };
  let chart = null;

  async function api(action, params) {
    if (!auth || !auth.currentUser) throw new Error('Session expired. Login again.');
    const token = await auth.currentUser.getIdToken();
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, ...(params || {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error((data.error && data.error.message) || 'Request failed');
    return data;
  }

  // ── boot ───────────────────────────────────────────────────
  function boot() {
    if (!window.Arena) return;
    auth = window.Arena.auth;
    db = window.Arena.db;
    bindUI();
    checkHealth();
    db.ref('adminConfig/adminUid').get()
      .then((s) => {
        if (!s.exists() || !s.val()) { $('adSetupBox').style.display = ''; $('adLoginBox').style.display = 'none'; }
      })
      .catch(() => {});
    auth.onAuthStateChanged(async (u) => {
      if (!u) { showGate(); return; }
      $('adEmailShort').textContent = u.email || u.uid;
      $('adLogoutBtn').style.display = '';
      try {
        await api('adminPing', {});
        isAdmin = true;
        showDash();
        attachLive();
        await refreshAll();
      } catch (e) {
        isAdmin = false;
        showGate();
        $('adLoginMsg').innerHTML = '<div class="alert alert-danger">⛔ <b>Not an admin.</b> ' + esc(e.message) +
          '<br>Your UID: <span class="mono">' + esc(u.uid) + '</span><br>Owner fix: set <b>ADMIN_UIDS</b> in Vercel env (redeploy), or run first-time setup.</div>';
        $('adSetupBox').style.display = '';
      }
    });
  }
  document.addEventListener('arena:ready', boot);
  if (window.Arena) boot();

  function showGate() {
    $('adLoginBox').style.display = '';
    $('adDash').style.display = 'none';
    $('adLogoutBtn').style.display = 'none';
    $('adEmailShort').textContent = '';
  }
  function showDash() {
    $('adLoginBox').style.display = 'none';
    $('adSetupBox').style.display = 'none';
    $('adDash').style.display = '';
    $('adLoginMsg').innerHTML = '';
  }
  async function checkHealth() {
    try {
      const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
      const okAll = h.publicConfigPresent && h.adminSdk && h.adminSdk.configured;
      const b = $('adHealthBadge');
      b.className = 'badge ' + (okAll ? 'bg-success' : 'bg-danger');
      b.textContent = okAll ? '● systems OK' : '● config issue';
      $('adHealthBox').innerHTML = '<h5>💚 System health</h5>' +
        '<div class="kv"><span>Public config</span><b>' + (h.publicConfigPresent ? 'OK' : 'MISSING: ' + esc((h.missingPublic || []).join(', '))) + '</b></div>' +
        '<div class="kv"><span>Admin SDK</span><b>' + (h.adminSdk && h.adminSdk.configured ? 'connected ✓' : 'NOT configured ✗ ' + esc((h.adminSdk && h.adminSdk.error) || '')) + '</b></div>' +
        '<div class="kv"><span>Runtime</span><b>' + esc((h.runtime || {}).node || '') + ' · ' + esc((h.runtime || {}).vercelEnv || '') + '</b></div>' +
        '<div class="kv"><span>Bootstrap admins</span><b>' + esc(String(h.bootstrapAdminsSet || 0)) + '</b></div>';
    } catch (e) { $('adHealthBox').innerHTML = '<div class="alert alert-danger">' + esc(e.message) + '</div>'; }
  }

  // ── realtime (public + admin-readable) ─────────────────────
  function attachLive() {
    db.ref('games').on('value', (s) => { S.games = s.val() || {}; renderGames(); fillGameSelects(); });
    db.ref('promotions').on('value', (s) => { S.promos = s.val() || {}; renderPromos(); });
    db.ref('tournaments').on('value', (s) => { S.tournaments = s.val() || {}; renderTours(); fillMcSelect(); renderMcPlayers(); });
    db.ref('settings').on('value', (s) => { S.settings = s.val() || {}; fillSettings(); });
    // queues change rarely — poll via server feed instead of wide listeners
    setInterval(() => { if (isAdmin) loadQueues(); }, 20000);
  }
  async function refreshAll() {
    showLoader(true);
    try {
      await Promise.all([loadDashboard(), loadUsers(), loadQueues(), loadTxns(), loadAudit(), loadLbMgt()]);
    } catch (e) { toast(e.message, 'err'); }
    showLoader(false);
  }

  // ── dashboard ──────────────────────────────────────────────
  async function loadDashboard() {
    const a = await api('analyticsSnapshot', {});
    const cards = [
      ['👥 Users', a.totalUsers], ['🆕 New (7d)', a.new7d], ['🏆 Tournaments', a.tournaments],
      ['🔴 Live', a.live], ['🎫 Registrations', a.registrations], ['💰 In wallets 🎟', a.ticketsInWallets],
      ['💸 Pending WD', a.pendingWithdrawals], ['⚡ Pending RC', a.pendingDeposits], ['🎁 Pending Ref', a.pendingReferrals],
    ];
    $('adStats').innerHTML = cards.map((c) => '<div class="stat-box"><div class="num">' + fmtN(c[1]) + '</div><div class="lbl">' + esc(c[0]) + '</div></div>').join('');
    // chart: last 14 days signups
    const labels = [], data = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const k = d.toISOString().slice(0, 10);
      labels.push(k.slice(5));
      data.push((a.signupsPerDay || {})[k] || 0);
    }
    try {
      if (chart) chart.destroy();
      chart = new Chart($('adUserChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Signups', data, borderColor: '#facc15', backgroundColor: 'rgba(250,204,21,.15)', fill: true, tension: 0.35 }] },
        options: { plugins: { legend: { labels: { color: '#e5e9f5' } } }, scales: { x: { ticks: { color: '#8b94b3' } }, y: { ticks: { color: '#8b94b3' }, beginAtZero: true } } },
      });
    } catch (_) {}
  }

  // ── games / promos / tournaments ───────────────────────────
  function renderGames() {
    const arr = Object.keys(S.games).map((id) => ({ id, ...S.games[id] })).sort((a, b) => (a.order || 0) - (b.order || 0));
    $('adGamesList').innerHTML = arr.length ? arr.map((g) =>
      '<div class="ad-card d-flex align-items-center gap-3">' +
      (g.imageUrl ? '<img class="thumb" src="' + esc(g.imageUrl) + '" alt="" />' : '<div class="thumb d-flex align-items-center justify-content-center">🎮</div>') +
      '<div style="flex:1"><strong>' + esc(g.name) + '</strong><br><small style="color:var(--ad-muted)">order ' + esc(g.order || 0) + ' · ' + (g.active === false ? 'disabled' : 'active') + '</small></div>' +
      '<button class="btn-ad btn-ghost btn-sm" data-gedit="' + esc(g.id) + '">✏️</button><button class="btn-ad btn-red btn-sm" data-gdel="' + esc(g.id) + '">🗑</button></div>'
    ).join('') : '<div class="ad-card">No games yet.</div>';
    bindListBtns();
  }
  function renderPromos() {
    const arr = Object.keys(S.promos).map((id) => ({ id, ...S.promos[id] })).sort((a, b) => (a.order || 0) - (b.order || 0));
    $('adPromoList').innerHTML = arr.length ? arr.map((p) =>
      '<div class="ad-card d-flex align-items-center gap-3">' +
      (p.imageUrl ? '<img class="thumb" src="' + esc(p.imageUrl) + '" alt="" />' : '<div class="thumb d-flex align-items-center justify-content-center">📣</div>') +
      '<div style="flex:1"><strong>' + esc(p.title || 'Promotion') + '</strong><br><small style="color:var(--ad-muted)">' + esc(p.link || '') + ' · ' + (p.active === false ? 'disabled' : 'active') + '</small></div>' +
      '<button class="btn-ad btn-ghost btn-sm" data-pedit="' + esc(p.id) + '">✏️</button><button class="btn-ad btn-red btn-sm" data-pdel="' + esc(p.id) + '">🗑</button></div>'
    ).join('') : '<div class="ad-card">No promotions yet.</div>';
    bindListBtns();
  }
  function renderTours() {
    const arr = Object.keys(S.tournaments).map((id) => ({ id, ...S.tournaments[id] })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('adTourList').innerHTML = arr.length ? arr.map((t) => {
      const g = S.games[t.gameId || ''];
      return '<div class="ad-card"><strong>' + esc(t.name) + '</strong> <span class="badge bg-info">' + esc(t.status || '') + '</span> <span class="badge bg-secondary">' + esc(g ? g.name : (t.gameId || '')) + '</span> <span class="badge bg-warning">' + esc(t.mode || 'solo') + '</span>' +
        '<br><small style="color:var(--ad-muted)">🎟 entry ' + fmtN(t.entryFee) + ' · 💰 prize ' + fmtN(t.prizePool) + ' · 👥 ' + fmtN(t.spotsFilled) + '/' + fmtN(t.maxPlayers) + ' · 🕒 ' + esc(fmtD(t.matchDate)) + '</small>' +
        '<div class="d-flex gap-2 mt-2"><button class="btn-ad btn-ghost btn-sm" data-tedit="' + esc(t.id) + '">✏️ Edit</button>' +
        '<button class="btn-ad btn-blue btn-sm" data-tmc="' + esc(t.id) + '">🎛 Control</button>' +
        '<button class="btn-ad btn-red btn-sm" data-tdel="' + esc(t.id) + '">🗑</button></div></div>';
    }).join('') : '<div class="ad-card">No tournaments yet.</div>';
    bindListBtns();
  }
  function fillGameSelects() {
    $('tGame').innerHTML = Object.keys(S.games).map((id) => '<option value="' + esc(id) + '">' + esc(S.games[id].name || id) + '</option>').join('') || '<option value="">— no games —</option>';
  }
  function fillMcSelect() {
    const sel = $('adMcTour');
    const cur = sel.value;
    sel.innerHTML = Object.keys(S.tournaments).map((id) => '<option value="' + esc(id) + '">' + esc(S.tournaments[id].name || id) + ' [' + esc(S.tournaments[id].status || '') + ']</option>').join('') || '<option value="">— none —</option>';
    if (cur) sel.value = cur;
    const t = S.tournaments[sel.value];
    if (t) { $('adMcRoomId').value = t.roomId || ''; $('adMcRoomPass').value = t.roomPassword || ''; $('adMcShow').value = t.showIdPass === false ? 'false' : 'true'; }
  }

  // ── match control ──────────────────────────────────────────
  async function renderMcPlayers() {
    const tid = $('adMcTour').value;
    const box = $('adMcPlayers');
    if (!tid || !S.tournaments[tid]) { box.innerHTML = '<span style="color:var(--ad-muted)">Select a tournament.</span>'; return; }
    let players = S.tournaments[tid].registeredPlayers || null;
    if (!players) {
      // bootstrap admin fallback: fetch via server feed
      try { const r = await api('adminFeed', { kind: 'entries', tournamentId: tid }); players = {}; r.entries.forEach((e) => { players[e.uid] = e; }); }
      catch (_) { players = {}; }
    }
    const arr = Object.keys(players).map((uid) => ({ uid, ...players[uid] })).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    box.innerHTML = arr.length
      ? '<div class="table-wrap"><table class="ad-tbl"><thead><tr><th>#</th><th>Player</th><th>Game UID</th><th>Mode</th><th>Fee</th><th>Joined</th></tr></thead><tbody>' +
        arr.map((p, i) => '<tr><td>' + (i + 1) + '</td><td><strong>' + esc(p.name || '') + '</strong><br><small class="mono">' + esc(p.uid) + '</small>' + (p.teammateName ? '<br><small>👥 ' + esc(p.teammateName) + ' (' + esc(p.teammateGameUid || '') + ')</small>' : '') + '</td><td>' + esc(p.gameUid || '') + '</td><td>' + esc(p.mode || '') + '</td><td>🎟' + fmtN(p.feePaid) + '</td><td>' + esc(fmtD(p.joinedAt)) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<span style="color:var(--ad-muted)">No players yet.</span>';
  }
  function winRow(uid, name, prize, rank) {
    const d = document.createElement('div');
    d.className = 'row g-2 mb-2';
    d.innerHTML = '<div class="col-2"><input class="form-control" data-w="rank" type="number" value="' + (rank || 1) + '" /></div>' +
      '<div class="col-5"><input class="form-control mono" data-w="uid" placeholder="Winner UID" value="' + esc(uid || '') + '" /></div>' +
      '<div class="col-3"><input class="form-control" data-w="name" placeholder="Name" value="' + esc(name || '') + '" /></div>' +
      '<div class="col-2"><input class="form-control" data-w="prize" type="number" placeholder="🎟" value="' + esc(prize || '') + '" /></div>';
    return d;
  }

  // ── users ──────────────────────────────────────────────────
  async function loadUsers(search) {
    const r = await api('listUsers', { limit: 150, search: search || '' });
    S.users = r.users || [];
    renderUsers();
    renderAnalytics();
    renderLbMgt('');
  }
  function renderUsers() {
    $('adUserRows').innerHTML = S.users.map((u) =>
      '<tr><td><strong>' + esc(u.name || 'Player') + '</strong><br><small style="color:var(--ad-muted)">' + esc(u.email || '') + '</small><br><small class="mono">' + esc(u.uid) + '</small></td>' +
      '<td>🎟<b>' + fmtN(u.tickets) + '</b></td><td>🎁' + fmtN(u.bonusTickets) + '</td><td class="mono">' + esc(u.referralCode || '—') + '</td>' +
      '<td>' + (u.blocked === true ? '<span class="badge bg-danger">blocked</span>' : '<span class="badge bg-success">active</span>') + '</td>' +
      '<td><button class="btn-ad btn-ghost btn-sm" data-upick="' + esc(u.uid) + '">Select</button> <button class="btn-ad btn-blue btn-sm" data-udetail="' + esc(u.uid) + '">Detail</button></td></tr>'
    ).join('') || '<tr><td colspan="6" class="text-center">No users.</td></tr>';
    bindListBtns();
  }
  function renderAnalytics() {
    const week = Date.now() - 7 * 86400000;
    const active = [...S.users].sort((a, b) => (b.matchesPlayed || 0) - (a.matchesPlayed || 0)).slice(0, 8);
    const inactive = S.users.filter((u) => (u.lastLoginAt || u.createdAt || 0) < week && ((u.tickets || 0) + (u.bonusTickets || 0)) > 0).slice(0, 8);
    $('adAnaStats').innerHTML = [
      ['👥 Loaded', S.users.length], ['⛔ Blocked', S.users.filter((u) => u.blocked).length],
      ['💰 Avg wallet', S.users.length ? Math.round(S.users.reduce((s, u) => s + (u.tickets || 0), 0) / S.users.length) : 0],
      ['⚔️ Total matches', S.users.reduce((s, u) => s + (u.matchesPlayed || 0), 0)],
    ].map((c) => '<div class="stat-box"><div class="num">' + fmtN(c[1]) + '</div><div class="lbl">' + esc(c[0]) + '</div></div>').join('');
    $('adMostActive').innerHTML = active.map((u) => '<div class="kv"><span>' + esc(u.name || u.uid) + '</span><b>⚔️ ' + fmtN(u.matchesPlayed) + ' · 🏆 ' + fmtN(u.matchesWon) + '</b></div>').join('') || '—';
    $('adInactive').innerHTML = inactive.map((u) => '<div class="kv"><span>' + esc(u.name || u.uid) + '</span><b>🎟 ' + fmtN((u.tickets || 0) + (u.bonusTickets || 0)) + '</b></div>').join('') || '—';
  }
  function renderLbMgt(q) {
    q = (q || '').toLowerCase();
    const arr = [...S.users]
      .map((u) => ({ ...u, score: (u.points || 0) || ((u.totalEarnings || 0) + (u.matchesWon || 0) * 100 + (u.matchesPlayed || 0) * 5) }))
      .filter((u) => !q || ((u.name || '') + ' ' + (u.email || '')).toLowerCase().includes(q))
      .sort((a, b) => b.score - a.score).slice(0, 100);
    $('adLbRows').innerHTML = arr.map((u, i) =>
      '<tr><td><b>' + (i + 1) + '</b> <small style="color:var(--ad-muted)">(saved: ' + esc(u.leaderboardRank || '—') + ')</small></td><td><strong>' + esc(u.name || '') + '</strong><br><small class="mono">' + esc(u.uid) + '</small></td>' +
      '<td>' + fmtN(u.score) + '</td><td>🎟' + fmtN(u.totalEarnings) + '</td><td>🏆' + fmtN(u.matchesWon) + '/⚔️' + fmtN(u.matchesPlayed) + '</td></tr>'
    ).join('') || '<tr><td colspan="5" class="text-center">No users.</td></tr>';
  }

  // ── queues (server feed = works for every admin) ───────────
  async function loadQueues() {
    try {
      const [w, d, r, n] = await Promise.all([
        api('adminFeed', { kind: 'withdrawals', limit: 120 }),
        api('adminFeed', { kind: 'deposits', limit: 120 }),
        api('adminFeed', { kind: 'referrals', limit: 120 }),
        api('adminFeed', { kind: 'notifications', limit: 30 }),
      ]);
      S.withdrawals = w.items || []; S.deposits = d.items || []; S.referrals = r.items || []; S.notifHist = n.items || [];
    } catch (e) { /* keep old */ }
    renderQueues();
  }
  function badge(id, n) { const b = $(id); b.style.display = n ? '' : 'none'; b.textContent = n; }
  function renderQueues() {
    const wd = S.withdrawals.filter((x) => x.status === S.wdTab);
    $('adWdRows').innerHTML = wd.map((x) =>
      '<tr><td>' + esc(fmtD(x.createdAt)) + '</td><td><strong>' + esc(x.name || '') + '</strong><br><small class="mono">' + esc(x.uid) + '</small></td>' +
      '<td>🎟<b>' + fmtN(x.amount) + '</b></td><td>' + esc(x.method || '') + '<br><small>' + esc(x.account || '') + '</small></td><td>' + esc(x.status) + '</td>' +
      '<td>' + (x.status === 'pending' ? '<button class="btn-ad btn-blue btn-sm" data-wdrev="' + esc(x.id) + '">Review</button>' : '<small>' + esc(x.note || '') + '</small>') + '</td></tr>'
    ).join('') || '<tr><td colspan="6" class="text-center">Empty.</td></tr>';
    const dp = S.deposits.filter((x) => x.status === S.dpTab);
    $('adDpRows').innerHTML = dp.map((x) =>
      '<tr><td>' + esc(fmtD(x.createdAt)) + '</td><td><strong>' + esc(x.name || '') + '</strong><br><small class="mono">' + esc(x.uid) + '</small></td>' +
      '<td>₹<b>' + fmtN(x.amount) + '</b></td><td class="mono">' + esc(x.utr || '') + '</td><td>' + esc(x.status) + '</td>' +
      '<td>' + (x.status === 'pending' ? '<button class="btn-ad btn-blue btn-sm" data-dprev="' + esc(x.id) + '">Review</button>' : '<small>' + esc(x.note || '') + '</small>') + '</td></tr>'
    ).join('') || '<tr><td colspan="6" class="text-center">Empty.</td></tr>';
    const rf = S.referrals.filter((x) => x.status === S.rfTab);
    $('adRefRows').innerHTML = rf.map((x) =>
      '<tr><td>' + esc(fmtD(x.createdAt)) + '</td><td><strong>' + esc(x.newName || '') + '</strong><br><small class="mono">' + esc(x.newUid || '') + '</small></td>' +
      '<td class="mono">' + esc(x.code || '') + '</td><td><small class="mono">' + esc(x.referrerUid || '') + '</small></td><td>' + esc(x.status) + '</td>' +
      '<td>' + (x.status === 'pending' ? '<button class="btn-ad btn-blue btn-sm" data-rfrev="' + esc(x.id) + '">Review</button>' : '🎁 ref +' + fmtN(x.refBonus) + ' / new +' + fmtN(x.joinBonus)) + '</td></tr>'
    ).join('') || '<tr><td colspan="6" class="text-center">Empty.</td></tr>';
    badge('adWdBadge', S.withdrawals.filter((x) => x.status === 'pending').length);
    badge('adDpBadge', S.deposits.filter((x) => x.status === 'pending').length);
    badge('adRefBadge', S.referrals.filter((x) => x.status === 'pending').length);
    $('adNotifHist').innerHTML = S.notifHist.map((n) => '<div class="kv"><span><b>' + esc(n.title || '') + '</b> — ' + esc((n.message || '').slice(0, 90)) + '</span><b>' + esc(fmtD(n.createdAt)) + '</b></div>').join('') || '—';
    bindListBtns();
  }

  // ── txns / audit ───────────────────────────────────────────
  async function loadTxns() {
    try {
      const uid = $('adTxUid').value.trim();
      if (uid) {
        const r = await api('getUserDetail', { uid });
        $('adTxRows').innerHTML = (r.txns || []).map((t) =>
          '<tr><td>' + esc(fmtD(t.ts)) + '</td><td>' + esc(r.user.name || uid) + '</td><td>' + esc(t.type || '') + '</td><td>' + esc(t.reason || '') + '</td><td><b>' + (Number(t.amount) > 0 ? '+' : '') + fmtN(t.amount) + '</b></td></tr>'
        ).join('') || '<tr><td colspan="5" class="text-center">No transactions.</td></tr>';
      } else {
        const r = await api('recentTransactions', { limit: 60 });
        $('adTxRows').innerHTML = (r.txns || []).map((t) =>
          '<tr><td>' + esc(fmtD(t.ts)) + '</td><td>' + esc(t.name || '') + '<br><small class="mono">' + esc(t.uid) + '</small></td><td>' + esc(t.type || '') + '</td><td>' + esc(t.reason || '') + '</td><td><b>' + (Number(t.amount) > 0 ? '+' : '') + fmtN(t.amount) + '</b></td></tr>'
        ).join('') || '<tr><td colspan="5" class="text-center">No transactions.</td></tr>';
      }
    } catch (e) { toast(e.message, 'err'); }
  }
  async function loadAudit() {
    try {
      const r = await api('auditList', { limit: 40 });
      $('adAuditList').innerHTML = (r.items || []).map((a) =>
        '<div class="kv"><span><b>' + esc(a.action) + '</b> — ' + esc(a.detail || '') + '<br><small class="mono">' + esc(a.by || '') + '</small></span><b>' + esc(fmtD(a.ts)) + '</b></div>'
      ).join('') || '—';
    } catch (_) {}
  }
  async function loadLbMgt() { renderLbMgt($('adLbSearch').value); }

  // ── settings form ──────────────────────────────────────────
  function fillSettings() {
    const st = S.settings;
    if (!st) return;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v === undefined ? '' : v; };
    set('stAppName', st.appName); set('stLogo', st.logoUrl); set('stAnnounce', st.announcement);
    set('stAdReward', st.adRewardTickets === undefined ? 5 : st.adRewardTickets);
    set('stAdCd', st.adCooldownSec === undefined ? 60 : st.adCooldownSec);
    set('stAdLimit', st.adDailyLimit === undefined ? 20 : st.adDailyLimit);
    set('stAdLink', st.adLink);
    set('stMinWd', st.minWithdrawTickets === undefined ? 100 : st.minWithdrawTickets);
    set('stRefBonus', st.referralBonus === undefined ? 20 : st.referralBonus);
    set('stJoinBonus', st.joinBonusTickets === undefined ? 10 : st.joinBonusTickets);
    set('stSignupBonus', st.signupBonusTickets === undefined ? 0 : st.signupBonusTickets);
    set('stUpi', st.upiId); set('stUpiName', st.upiName); set('stUpiQr', st.upiQrUrl);
    set('stSupEmail', st.supportEmail); set('stSupUrl', st.supportUrl);
    set('stAbout', (st.policies || {}).about); set('stPrivacy', (st.policies || {}).privacy);
    set('stTerms', (st.policies || {}).terms); set('stRefund', (st.policies || {}).refund);
    $('stMaint').value = st.maintenanceMode === true ? 'true' : 'false';
    if (st.appName) $('adBrand').textContent = st.appName + ' · Admin';
    if (st.logoUrl) $('adLogo').src = st.logoUrl;
    if (st.theme) { S.theme = st.theme; paintThemeDots(); }
  }
  function paintThemeDots() {
    document.querySelectorAll('#adThemeDots .theme-dot').forEach((d) => { d.style.borderColor = d.dataset.t === S.theme ? '#fff' : 'transparent'; });
  }

  // ── PDFs ───────────────────────────────────────────────────
  function pdfTable(title, head, rows) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      doc.text(title + ' — ' + new Date().toLocaleString(), 14, 14);
      doc.autoTable({ head: [head], body: rows, startY: 20 });
      doc.save(title.replace(/\s+/g, '-').toLowerCase() + '.pdf');
      toast('PDF downloaded ✓', 'ok');
    } catch (e) { toast('PDF failed: ' + e.message, 'err'); }
  }

  // ── delegated buttons ──────────────────────────────────────
  function bindListBtns() {
    document.querySelectorAll('[data-gedit]').forEach((b) => b.onclick = () => {
      const g = S.games[b.dataset.gedit]; if (!g) return;
      $('gId').value = b.dataset.gedit; $('gName').value = g.name || ''; $('gImg').value = g.imageUrl || '';
      $('gOrder').value = g.order || 0; $('gActive').value = g.active === false ? 'false' : 'true';
      modal('adGameModal').show();
    });
    document.querySelectorAll('[data-gdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this game?')) return;
      try { await api('deleteGame', { id: b.dataset.gdel }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-pedit]').forEach((b) => b.onclick = () => {
      const p = S.promos[b.dataset.pedit]; if (!p) return;
      $('pId').value = b.dataset.pedit; $('pTitle').value = p.title || ''; $('pImg').value = p.imageUrl || '';
      $('pLink').value = p.link || ''; $('pOrder').value = p.order || 0; $('pActive').value = p.active === false ? 'false' : 'true';
      modal('adPromoModal').show();
    });
    document.querySelectorAll('[data-pdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this promotion?')) return;
      try { await api('deletePromotion', { id: b.dataset.pdel }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-tedit]').forEach((b) => b.onclick = () => {
      const t = S.tournaments[b.dataset.tedit]; if (!t) return;
      $('tId').value = b.dataset.tedit; $('tName').value = t.name || ''; $('tGame').value = t.gameId || '';
      $('tFee').value = t.entryFee || 0; $('tPrize').value = t.prizePool || 0; $('tMax').value = t.maxPlayers || 0;
      $('tKill').value = t.perKillPrize || 0; $('tMode').value = t.mode || 'solo'; $('tStatus').value = t.status || 'upcoming';
      $('tDate').value = toLocal(t.matchDate); $('tMap').value = t.map || ''; $('tBanner').value = t.bannerUrl || '';
      $('tDesc').value = t.description || ''; $('tPD').value = t.prizeDistribution || '';
      modal('adTourModal').show();
    });
    document.querySelectorAll('[data-tdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this tournament AND its registrations?')) return;
      try { await api('deleteTournament', { id: b.dataset.tdel }); toast('Deleted', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-tmc]').forEach((b) => b.onclick = () => {
      switchSection('tournament-management-section');
      $('adMcTour').value = b.dataset.tmc;
      fillMcSelect(); renderMcPlayers();
    });
    document.querySelectorAll('[data-upick]').forEach((b) => b.onclick = () => { $('adAdjUid').value = b.dataset.upick; toast('UID selected ✓'); });
    document.querySelectorAll('[data-udetail]').forEach((b) => b.onclick = async () => {
      try {
        const r = await api('getUserDetail', { uid: b.dataset.udetail });
        const u = r.user;
        $('adDetailBody').innerHTML =
          '<div class="kv"><span>Name / Email</span><b>' + esc(u.name || '') + ' / ' + esc(u.email || '') + '</b></div>' +
          '<div class="kv"><span>UID</span><b class="mono">' + esc(u.uid) + '</b></div>' +
          '<div class="kv"><span>Wallet</span><b>🎟 ' + fmtN(u.tickets) + ' + 🎁 ' + fmtN(u.bonusTickets) + '</b></div>' +
          '<div class="kv"><span>Earnings / Rank</span><b>🎟 ' + fmtN(u.totalEarnings) + ' / #' + esc(u.leaderboardRank || '—') + '</b></div>' +
          '<div class="kv"><span>Matches / Wins</span><b>⚔️ ' + fmtN(u.matchesPlayed) + ' / 🏆 ' + fmtN(u.matchesWon) + '</b></div>' +
          '<div class="kv"><span>Referral</span><b class="mono">' + esc(u.referralCode || '—') + ' (by ' + esc(u.referredBy || '—') + ')</b></div>' +
          '<div class="kv"><span>Joined / Seen</span><b>' + esc(fmtD(u.createdAt)) + ' / ' + esc(fmtD(u.lastLoginAt)) + '</b></div>' +
          '<h6 class="mt-3">Recent ledger</h6>' + ((r.txns || []).map((t) =>
            '<div class="kv"><span>' + esc(t.reason || t.type || '') + ' · ' + esc(fmtD(t.ts)) + '</span><b>' + (Number(t.amount) > 0 ? '+' : '') + fmtN(t.amount) + '</b></div>').join('') || '—') +
          '<h6 class="mt-3">Withdrawals</h6>' + ((r.withdrawals || []).map((w) =>
            '<div class="kv"><span>🎟' + fmtN(w.amount) + ' → ' + esc(w.account || '') + ' · ' + esc(fmtD(w.createdAt)) + '</span><b>' + esc(w.status) + '</b></div>').join('') || '—');
        modal('adDetailModal').show();
      } catch (e) { toast(e.message, 'err'); }
    });
    document.querySelectorAll('[data-wdrev]').forEach((b) => b.onclick = () => openDecide('withdrawal', b.dataset.wdrev));
    document.querySelectorAll('[data-dprev]').forEach((b) => b.onclick = () => openDecide('deposit', b.dataset.dprev));
    document.querySelectorAll('[data-rfrev]').forEach((b) => b.onclick = () => openDecide('referral', b.dataset.rfrev));
  }

  let decideKind = null, decideId = null;
  function openDecide(kind, id) {
    decideKind = kind; decideId = id;
    const map = { withdrawal: S.withdrawals, deposit: S.deposits, referral: S.referrals };
    const x = (map[kind] || []).find((i) => i.id === id) || {};
    $('adDecideTitle').textContent = 'Review ' + kind + ' — ' + (kind === 'withdrawal' ? '🎟' + fmtN(x.amount) : kind === 'deposit' ? '₹' + fmtN(x.amount) : '🎁');
    $('adDecideInfo').innerHTML = '<pre class="mono" style="white-space:pre-wrap">' + esc(JSON.stringify(x, null, 1)).slice(0, 800) + '</pre>';
    $('adDecideNote').value = '';
    modal('adDecideModal').show();
  }
  async function decide(okYes) {
    const note = $('adDecideNote').value.trim();
    const acts = {
      withdrawal: okYes ? 'approveWithdrawal' : 'rejectWithdrawal',
      deposit: okYes ? 'approveDeposit' : 'rejectDeposit',
      referral: okYes ? 'approveReferral' : 'rejectReferral',
    };
    try {
      await api(acts[decideKind], { id: decideId, note });
      bootstrap.Modal.getInstance($('adDecideModal')).hide();
      toast(okYes ? 'Approved ✓' : 'Rejected', okYes ? 'ok' : '');
      loadQueues();
    } catch (e) { toast(e.message, 'err'); }
  }

  function switchSection(id) {
    document.querySelectorAll('#adDash .section').forEach((s) => s.classList.toggle('active', s.id === id));
    document.querySelectorAll('#adNav .nav-link').forEach((a) => a.classList.toggle('active', a.dataset.section === id));
    try { bootstrap.Offcanvas.getInstance($('adSidebar')).hide(); } catch (_) {}
    if (id === 'audit-section') { checkHealth(); loadAudit(); }
    if (id === 'dashboard-section') loadDashboard();
  }

  // ── bindings ───────────────────────────────────────────────
  function bindUI() {
    document.querySelectorAll('#adNav .nav-link').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); switchSection(a.dataset.section); }));
    $('adLoginBtn').addEventListener('click', async () => {
      $('adLoginBtn').disabled = true;
      try { await auth.signInWithEmailAndPassword($('adLoginEmail').value.trim(), $('adLoginPass').value); }
      catch (e) { $('adLoginMsg').innerHTML = '<div class="alert alert-danger">' + esc(e.message) + '</div>'; }
      $('adLoginBtn').disabled = false;
    });
    $('adSetupBtn').addEventListener('click', async () => {
      $('adSetupBtn').disabled = true;
      try {
        await auth.signInWithEmailAndPassword($('adSetupEmail').value.trim(), $('adSetupPass').value);
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'setupAdmin' }) });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error.message);
        toast('🎉 You are now the admin!', 'ok');
      } catch (e) { $('adSetupMsg').innerHTML = '<div class="alert alert-danger">' + esc(e.message) + '</div>'; }
      $('adSetupBtn').disabled = false;
    });
    $('adLogoutBtn').addEventListener('click', () => auth.signOut());

    $('adSeedBtn').addEventListener('click', async () => {
      try { const r = await api('seedDemoData', {}); toast('Seeded: ' + JSON.stringify(r), 'ok'); loadDashboard(); } catch (e) { toast(e.message, 'err'); }
    });
    const recompute = async () => { try { const r = await api('recomputeLeaderboard', {}); toast(`Ranked ${r.ranked}/${r.total} ✓`, 'ok'); loadUsers(); } catch (e) { toast(e.message, 'err'); } };
    $('adRecomputeBtn').addEventListener('click', recompute);
    $('adLbRecompute').addEventListener('click', recompute);
    $('adRefreshDash').addEventListener('click', refreshAll);
    $('adLbSearch').addEventListener('input', debounce((e) => renderLbMgt(e.target.value), 220));

    // games
    $('adGameNew').addEventListener('click', () => { $('gId').value = ''; $('gName').value = ''; $('gImg').value = ''; $('gOrder').value = 0; $('adGameModalTitle').textContent = 'New Game'; modal('adGameModal').show(); });
    $('gSave').addEventListener('click', async () => {
      try {
        await api('upsertGame', { id: $('gId').value.trim() || undefined, name: $('gName').value, imageUrl: $('gImg').value, order: Number($('gOrder').value), active: $('gActive').value === 'true' });
        bootstrap.Modal.getInstance($('adGameModal')).hide(); toast('Game saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    // promos
    $('adPromoNew').addEventListener('click', () => { $('pId').value = ''; $('pTitle').value = ''; $('pImg').value = ''; $('pLink').value = ''; $('pOrder').value = 0; modal('adPromoModal').show(); });
    $('pSave').addEventListener('click', async () => {
      try {
        await api('upsertPromotion', { id: $('pId').value.trim() || undefined, title: $('pTitle').value, imageUrl: $('pImg').value, link: $('pLink').value, order: Number($('pOrder').value), active: $('pActive').value === 'true' });
        bootstrap.Modal.getInstance($('adPromoModal')).hide(); toast('Promotion saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    // tournaments
    $('adTourNew').addEventListener('click', () => {
      $('tId').value = ''; $('tName').value = ''; $('tFee').value = 10; $('tPrize').value = 100; $('tMax').value = 100;
      $('tKill').value = 0; $('tMode').value = 'solo'; $('tStatus').value = 'upcoming'; $('tDate').value = '';
      $('tMap').value = ''; $('tBanner').value = ''; $('tDesc').value = ''; $('tPD').value = '';
      modal('adTourModal').show();
    });
    $('tSave').addEventListener('click', async () => {
      try {
        await api('upsertTournament', {
          id: $('tId').value.trim() || undefined, name: $('tName').value, gameId: $('tGame').value,
          entryFee: Number($('tFee').value), prizePool: Number($('tPrize').value), maxPlayers: Number($('tMax').value),
          perKillPrize: Number($('tKill').value), mode: $('tMode').value, status: $('tStatus').value,
          matchDate: fromLocal($('tDate').value), map: $('tMap').value, bannerUrl: $('tBanner').value,
          description: $('tDesc').value, prizeDistribution: $('tPD').value,
        });
        bootstrap.Modal.getInstance($('adTourModal')).hide(); toast('Tournament saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    // match control
    $('adMcTour').addEventListener('change', () => { fillMcSelect(); renderMcPlayers(); });
    $('adMcRoomSave').addEventListener('click', async () => {
      try {
        await api('setRoom', { tournamentId: $('adMcTour').value, roomId: $('adMcRoomId').value, roomPassword: $('adMcRoomPass').value, showIdPass: $('adMcShow').value === 'true' });
        toast('Room saved + players notified ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('adWinAdd').addEventListener('click', () => $('adWinRows').appendChild(winRow('', '', '', $('adWinRows').children.length + 1)));
    $('adWinRows').appendChild(winRow('', '', '', 1));
    $('adWinGo').addEventListener('click', async () => {
      const rows = [...$('adWinRows').children].map((d) => ({
        rank: Number(d.querySelector('[data-w="rank"]').value) || 1,
        uid: d.querySelector('[data-w="uid"]').value.trim(),
        name: d.querySelector('[data-w="name"]').value.trim(),
        prize: Number(d.querySelector('[data-w="prize"]').value) || 0,
      })).filter((w) => w.uid && w.prize > 0);
      if (!rows.length) { toast('Add at least one winner with UID + prize.', 'err'); return; }
      if (!confirm(`Pay ${rows.length} winner(s) and complete the tournament?`)) return;
      try {
        const r = await api('declareWinners', { tournamentId: $('adMcTour').value, winners: rows, note: $('adWinNote').value });
        toast(`🏆 Paid ${r.credited.filter((c) => !c.error).length}/${r.credited.length} winners!`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
    $('adMcPdf').addEventListener('click', () => {
      const t = S.tournaments[$('adMcTour').value] || {};
      const players = t.registeredPlayers || {};
      pdfTable('players-' + ($('adMcTour').value || 'x'), ['#', 'Player', 'Game UID', 'Mode', 'Fee', 'Joined'],
        Object.keys(players).map((uid, i) => [i + 1, players[uid].name || '', players[uid].gameUid || '', players[uid].mode || '', players[uid].feePaid || 0, fmtD(players[uid].joinedAt)]));
    });

    // users
    $('adUserRefresh').addEventListener('click', () => loadUsers($('adUserSearch').value));
    $('adUserSearch').addEventListener('input', debounce((e) => loadUsers(e.target.value), 400));
    $('adUserNew').addEventListener('click', () => modal('adUserModal').show());
    $('uSave').addEventListener('click', async () => {
      try {
        const r = await api('createUser', { name: $('uName').value, email: $('uEmail').value.trim(), password: $('uPass').value, initialTickets: Number($('uInit').value) });
        bootstrap.Modal.getInstance($('adUserModal')).hide();
        toast('User created: ' + r.uid + ' ✓', 'ok'); loadUsers();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('adAdjGo').addEventListener('click', async () => {
      try {
        const r = await api('adjustBalance', { uid: $('adAdjUid').value.trim(), tickets: Number($('adAdjT').value), bonusTickets: Number($('adAdjB').value), reason: $('adAdjReason').value || 'Admin adjustment' });
        toast(`Done! Tickets: ${fmtN(r.ticketsAfter)}${r.bonusAfter !== undefined ? ' · Bonus: ' + fmtN(r.bonusAfter) : ''}`, 'ok');
        loadUsers($('adUserSearch').value);
      } catch (e) { toast(e.message, 'err'); }
    });
    $('adBlockBtn').addEventListener('click', async () => {
      const uid = $('adAdjUid').value.trim();
      if (!uid) { toast('Select a user first.', 'err'); return; }
      const u = S.users.find((x) => x.uid === uid);
      try {
        const r = await api('toggleBlock', { uid, blocked: !(u && u.blocked === true) });
        toast(r.blocked ? '⛔ User blocked' : '✅ User unblocked', r.blocked ? '' : 'ok');
        loadUsers($('adUserSearch').value);
      } catch (e) { toast(e.message, 'err'); }
    });
    $('adUserPdf').addEventListener('click', () => {
      pdfTable('users', ['Name', 'Email', 'Tickets', 'Bonus', 'Earnings', 'Matches'],
        S.users.map((u) => [u.name || '', u.email || '', u.tickets || 0, u.bonusTickets || 0, u.totalEarnings || 0, u.matchesPlayed || 0]));
    });

    // notifications
    $('adGnSend').addEventListener('click', async () => {
      try { await api('sendGlobalNotification', { title: $('adGnTitle').value, message: $('adGnMsg').value, imageUrl: $('adGnImg').value }); toast('Global sent 📢', 'ok'); loadQueues(); } catch (e) { toast(e.message, 'err'); }
    });
    $('adInSend').addEventListener('click', async () => {
      try { await api('sendUserNotification', { uid: $('adInUid').value.trim(), title: $('adInTitle').value, message: $('adInMsg').value }); toast('Sent 👤', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });

    // txns
    $('adTxLoad').addEventListener('click', loadTxns);

    // tabs
    document.querySelectorAll('#adWdTabs .nav-link').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#adWdTabs .nav-link').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      S.wdTab = b.dataset.wd; renderQueues();
    }));
    document.querySelectorAll('#adDpTabs .nav-link').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#adDpTabs .nav-link').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      S.dpTab = b.dataset.dp; renderQueues();
    }));
    document.querySelectorAll('#adRefTabs .nav-link').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#adRefTabs .nav-link').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      S.rfTab = b.dataset.rf; renderQueues();
    }));
    $('adDecideYes').addEventListener('click', () => decide(true));
    $('adDecideNo').addEventListener('click', () => decide(false));

    // theme
    document.querySelectorAll('#adThemeDots .theme-dot').forEach((d) => d.addEventListener('click', () => { S.theme = d.dataset.t; paintThemeDots(); }));
    $('adThemeSave').addEventListener('click', async () => {
      try { await api('updateSettings', { theme: S.theme }); toast('Theme saved ✓', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });

    // settings
    $('stSave').addEventListener('click', async () => {
      try {
        await api('updateSettings', {
          appName: $('stAppName').value, logoUrl: $('stLogo').value, announcement: $('stAnnounce').value,
          adRewardTickets: Number($('stAdReward').value), adCooldownSec: Number($('stAdCd').value),
          adDailyLimit: Number($('stAdLimit').value), adLink: $('stAdLink').value,
          minWithdrawTickets: Number($('stMinWd').value), referralBonus: Number($('stRefBonus').value),
          joinBonusTickets: Number($('stJoinBonus').value), signupBonusTickets: Number($('stSignupBonus').value),
          upiId: $('stUpi').value, upiName: $('stUpiName').value, upiQrUrl: $('stUpiQr').value,
          supportEmail: $('stSupEmail').value, supportUrl: $('stSupUrl').value,
          maintenanceMode: $('stMaint').value === 'true',
          policies: { about: $('stAbout').value, privacy: $('stPrivacy').value, terms: $('stTerms').value, refund: $('stRefund').value },
        });
        toast('Settings saved ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  }
})();
