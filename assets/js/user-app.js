/* ═══════════════════════════════════════════════════════════════
   ARENA X — user app. Written from scratch. No keys here: Firebase comes
   from window.Arena (boot.js → /api/config). All money moves go through
   /api/command on the server. This file only READS + renders + asks.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── tiny helpers ───────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtD = (ts) => {
    if (!ts) return 'TBA';
    try { return new Date(Number(ts)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch { return '—'; }
  };
  const timeLeft = (ts) => {
    const ms = Number(ts || 0) - Date.now();
    if (ms <= 0) return 'LIVE / Started';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return d + 'd ' + (h % 24) + 'h left';
    if (h > 0) return h + 'h ' + (m % 60) + 'm left';
    return m + 'm ' + Math.floor((ms % 60000) / 1000) + 's left';
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function toast(msg, kind) {
    const box = $('axToasts');
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'ax-toast ' + (kind || '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; setTimeout(() => d.remove(), 450); }, 3400);
  }
  function showLoader(on) { const l = $('globalLoaderEl'); if (l) l.classList.toggle('show', !!on); }
  function fieldMsg(id, text, isErr) {
    const el = $(id);
    if (!el) return;
    if (!text) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.className = 'alert mt-2 ' + (isErr ? 'alert-danger' : 'alert-success');
    el.textContent = text;
  }
  function confirmDlg(title, text) {
    return new Promise((resolve) => {
      $('axConfirmTitle').textContent = title;
      $('axConfirmText').textContent = text;
      const m = new bootstrap.Modal($('axConfirmModal'));
      const yes = $('axConfirmYes'), no = $('axConfirmNo');
      const done = (v) => { yes.onclick = null; no.onclick = null; m.hide(); resolve(v); };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      m.show();
    });
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Copied ✓', 'ok'); }
    catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied ✓', 'ok'); } catch { toast('Copy failed', 'err'); } ta.remove(); }
  }

  // ── sound engine (WebAudio click, no audio files needed) ────
  const Sound = {
    ctx: null,
    enabled() { return localStorage.getItem('axSound') !== 'off'; },
    click() {
      if (!this.enabled()) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.connect(g); g.connect(this.ctx.destination);
        o.frequency.value = 660; o.type = 'sine';
        g.gain.setValueAtTime(0.08, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.09);
        o.start(); o.stop(this.ctx.currentTime + 0.1);
      } catch (_) { /* silent */ }
    },
  };
  document.addEventListener('click', (e) => { if (e.target.closest('button,.nav-item,.game-card,.payment-option-card')) Sound.click(); }, true);

  // ── state ──────────────────────────────────────────────────
  let auth = null, db = null, SV = null;
  let user = null, profile = null;
  let tourTab = 'upcoming', tourSearch = '', gameFilter = '', gameFilterName = '';
  const S = {
    settings: {}, games: {}, promos: {}, tournaments: {}, myJoins: {},
    txns: [], globalNotifs: {}, personalNotifs: {}, leaderboard: [],
    adHistory: [], chatTid: null, chatReply: null, adCooldownUntil: 0,
  };
  const pubRefs = [];
  let privRefs = [];
  let promoSwiper = null;
  const navStack = [];

  // ── server call ────────────────────────────────────────────
  async function api(action, params, opts) {
    if (!auth || !auth.currentUser) throw new Error('Please login first.');
    const token = await auth.currentUser.getIdToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 25000);
    try {
      const res = await fetch('/api/command', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ action, ...(params || {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        const err = new Error((data.error && data.error.message) || 'Request failed');
        err.code = data.error && data.error.code;
        err.retryAfterSec = data.retryAfterSec;
        throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  // ── boot ───────────────────────────────────────────────────
  function boot() {
    if (!window.Arena) return;
    auth = window.Arena.auth;
    db = window.Arena.db;
    SV = window.firebase.database.ServerValue;
    applySavedTheme();
    bindUI();
    bindOffline();
    attachPublic();
    securitySelfCheck();
    setInterval(tickTimers, 1000);
    auth.onAuthStateChanged(async (u) => {
      user = u;
      if (!u) { onLogoutUI(); detachPrivate(); showSection('login-section', true); return; }
      showLoader(true);
      try {
        const r = await api('syncUser', { name: u.displayName || '', photoURL: u.photoURL || '', referralCode: sessionStorage.getItem('axPendingRef') || '' });
        sessionStorage.removeItem('axPendingRef');
        profile = r.user;
        if (profile && profile.blocked === true) {
          await auth.signOut();
          toast('⛔ Your account is blocked. Contact support.', 'err');
          return;
        }
        attachPrivate();
        renderAuthSurfaces();
        if (!location.hash || location.hash === '#login') showSection('home-section', true);
        else showSection('home-section', true);
      } catch (e) {
        toast(e.message, 'err');
        showSection('login-section', true);
      }
      showLoader(false);
    });
  }
  document.addEventListener('arena:ready', boot);
  document.addEventListener('arena:boot-error', () => showSection('login-section', true));
  if (window.Arena) boot();

  function bindOffline() {
    const bar = $('offlineBar');
    const upd = () => { bar.style.display = navigator.onLine ? 'none' : 'block'; };
    window.addEventListener('online', upd);
    window.addEventListener('offline', upd);
    upd();
  }

  // Warn (once) if the database is dangerously open to anonymous writes.
  async function securitySelfCheck() {
    try {
      const url = window.Arena.config.databaseURL + '/__ax_probe__.json';
      const put = await fetch(url, { method: 'PUT', body: JSON.stringify({ t: Date.now() }) });
      if (put.ok) {
        await fetch(url, { method: 'DELETE' }).catch(() => {});
        const w = $('securityWarning');
        w.innerHTML = '⚠️ <b>Security Alert:</b> Database rules look public. Anyone can write data. <button id="axSecDismiss">Dismiss</button>';
        w.style.display = '';
        $('axSecDismiss').onclick = () => { w.style.display = 'none'; };
      }
    } catch (_) { /* locked (good) or unreachable — stay silent */ }
  }

  // ── listeners ──────────────────────────────────────────────
  function attachPublic() {
    const rSettings = db.ref('settings');
    rSettings.on('value', (s) => { S.settings = s.val() || {}; applySettings(); });
    pubRefs.push(rSettings);
    const rGames = db.ref('games');
    rGames.on('value', (s) => { S.games = s.val() || {}; renderGames(); });
    pubRefs.push(rGames);
    const rPromos = db.ref('promotions');
    rPromos.on('value', (s) => { S.promos = s.val() || {}; renderPromos(); });
    pubRefs.push(rPromos);
    const rTours = db.ref('tournaments');
    rTours.on('value', (s) => { S.tournaments = s.val() || {}; renderTournaments(); renderMyContests(); probeMyJoins(); });
    pubRefs.push(rTours);
  }
  function attachPrivate() {
    detachPrivate();
    const uid = user.uid;
    const r1 = db.ref('users/' + uid);
    r1.on('value', (s) => {
      profile = s.val() || profile;
      if (profile && profile.blocked === true) { auth.signOut(); toast('⛔ Account blocked by admin.', 'err'); return; }
      renderAuthSurfaces(); renderWallet(); renderProfile(); renderEarnings();
    });
    privRefs.push(r1);
    const r2 = db.ref('transactions/' + uid).limitToLast(40);
    r2.on('value', (s) => { const a = []; s.forEach((c) => a.push({ id: c.key, ...c.val() })); S.txns = a.reverse(); renderTxns(); renderEarnings(); });
    privRefs.push(r2);
    const r3 = db.ref('notifications').limitToLast(30);
    r3.on('value', (s) => { S.globalNotifs = s.val() || {}; renderNotifBadge(); });
    privRefs.push(r3);
    const r4 = db.ref(`users/${uid}/notifications`).limitToLast(30);
    r4.on('value', (s) => { S.personalNotifs = s.val() || {}; renderNotifBadge(); });
    privRefs.push(r4);
    const d = new Date();
    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r5 = db.ref(`users/${uid}/adRewards/${dk}`).limitToLast(30);
    r5.on('value', (s) => { const a = []; s.forEach((c) => a.push(c.val())); S.adHistory = a.reverse(); renderAdHistory(); renderAdNote(); });
    privRefs.push(r5);
    loadLeaderboard();
  }
  function detachPrivate() {
    privRefs.forEach((r) => { try { r.off(); } catch (_) {} });
    privRefs = [];
    S.txns = []; S.globalNotifs = {}; S.personalNotifs = {}; S.myJoins = {}; S.leaderboard = [];
    profile = null;
  }
  async function loadLeaderboard() {
    try {
      const r = await api('getLeaderboard', {});
      S.leaderboard = r.board || [];
    } catch (_) { S.leaderboard = []; }
    renderLeaderboard();
  }

  // Which tournaments did I join? (own node probe, rules-allowed)
  async function probeMyJoins() {
    if (!user) return;
    const ids = Object.keys(S.tournaments).slice(0, 80);
    const found = {};
    await Promise.all(ids.map(async (tid) => {
      try {
        const s = await db.ref(`tournaments/${tid}/registeredPlayers/${user.uid}`).get();
        if (s.exists()) found[tid] = s.val();
      } catch (_) {}
    }));
    S.myJoins = found;
    renderTournaments(); renderMyContests();
  }
  const probeDebounced = debounce(probeMyJoins, 1500);

  // ── settings → UI ──────────────────────────────────────────
  function applySettings() {
    const st = S.settings;
    if (st.appName) document.title = st.appName + ' — E-Sport Tournaments';
    if (st.logoUrl) { $('axLogo').src = st.logoUrl; }
    if (st.announcement) $('axAnnounce').innerHTML = '<div class="announce-strip">📢 ' + esc(st.announcement) + '</div>';
    else $('axAnnounce').innerHTML = '';
    $('axAdRewardEl').textContent = fmtN(st.adRewardTickets === undefined ? 5 : st.adRewardTickets);
    $('axWdMin').textContent = fmtN(st.minWithdrawTickets === undefined ? 100 : st.minWithdrawTickets);
    $('axUpiIdText').textContent = st.upiId || 'UPI not set by admin yet';
    $('axUpiNameText').textContent = st.upiName || '';
    if (st.upiQrUrl) { $('axQrBox').style.display = ''; $('axQrImg').src = st.upiQrUrl; }
    else $('axQrBox').style.display = 'none';
    renderAdNote();
    if (st.maintenanceMode === true && user) {
      toast('🛠 App is in maintenance mode. Please come back soon.', 'err');
    }
  }

  // ── router ─────────────────────────────────────────────────
  const TITLES = {
    'login-section': 'Welcome', 'home-section': 'Home', 'tournaments-section': 'Contests',
    'wallet-section': 'Wallet', 'earnings-section': 'Earnings', 'leaderboard-section': 'Leaderboard',
    'profile-section': 'Profile', 'recharge-section': 'Recharge',
  };
  function showSection(id, reset) {
    if (reset) navStack.length = 0;
    else if (navStack[navStack.length - 1] !== id) {
      const cur = document.querySelector('.section.active');
      if (cur && cur.id !== id) navStack.push(cur.id);
      if (navStack.length > 20) navStack.shift();
    }
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === id));
    document.querySelectorAll('#axBottomNav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === id));
    const logged = !!user;
    $('axBottomNav').style.display = (id === 'login-section') ? 'none' : '';
    $('axBackBtn').style.display = (!reset && navStack.length) ? '' : 'none';
    if (id === 'tournaments-section' && gameFilterName) {
      $('axTitleWrap').style.display = 'none';
      $('axGameTitle').style.display = '';
      $('axGameTitle').textContent = '🎮 ' + gameFilterName;
    } else {
      $('axTitleWrap').style.display = '';
      $('axGameTitle').style.display = 'none';
      $('axTitleWrap').firstChild.textContent = (TITLES[id] || 'Arena') + ' ';
    }
    window.scrollTo({ top: 0 });
    if (id === 'leaderboard-section') loadLeaderboard();
  }
  function goBack() {
    const prev = navStack.pop();
    showSection(prev || 'home-section', !prev);
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === (prev || 'home-section')));
    $('axBackBtn').style.display = navStack.length ? '' : 'none';
  }

  // ── auth UI ────────────────────────────────────────────────
  function renderAuthSurfaces() {
    const first = ((profile && profile.name) || (user && user.displayName) || 'Player').split(' ')[0];
    $('axGreeting').textContent = first;
    $('axWalletChip').style.display = user ? '' : 'none';
    if (user && profile) {
      $('axChipTickets').textContent = fmtN((profile.tickets || 0) + (profile.bonusTickets || 0));
      if (profile.photoURL) { $('axAvatar').innerHTML = '<img src="' + esc(profile.photoURL) + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="" />'; }
    }
  }
  function onLogoutUI() {
    $('axGreeting').textContent = 'Guest';
    $('axWalletChip').style.display = 'none';
  }

  // ── home renders ───────────────────────────────────────────
  function renderPromos() {
    const arr = Object.keys(S.promos).map((id) => ({ id, ...S.promos[id] }))
      .filter((p) => p.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
    const wrap = $('axPromoWrap');
    if (!arr.length) {
      wrap.innerHTML = '<div class="swiper-slide"><div style="height:190px;border-radius:10px;background:linear-gradient(135deg,#232a5c,#3b2a6e);display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700">🏆 Welcome to the Arena</div></div>';
    } else {
      wrap.innerHTML = arr.map((p) => {
        const img = p.imageUrl
          ? '<img src="' + esc(p.imageUrl) + '" alt="' + esc(p.title || 'promo') + '" loading="lazy" />'
          : '<div style="height:190px;border-radius:10px;background:linear-gradient(135deg,#232a5c,#3b2a6e);display:flex;align-items:center;justify-content:center;font-weight:700">' + esc(p.title || '🎮') + '</div>';
        return '<div class="swiper-slide">' + (p.link ? '<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + img + '</a>' : img) + '</div>';
      }).join('');
    }
    try {
      if (promoSwiper) promoSwiper.destroy(true, true);
      promoSwiper = new Swiper('#promotionSliderEl', { loop: arr.length > 1, autoplay: { delay: 3200 }, pagination: { el: '.swiper-pagination', clickable: true } });
    } catch (_) {}
  }
  function renderGames() {
    const arr = Object.keys(S.games).map((id) => ({ id, ...S.games[id] }))
      .filter((g) => g.active !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
    $('axGamesList').innerHTML = arr.length ? arr.map((g) =>
      '<div class="col-6"><div class="game-card" data-game="' + esc(g.id) + '" data-gname="' + esc(g.name || 'Game') + '">' +
      (g.imageUrl ? '<img src="' + esc(g.imageUrl) + '" alt="' + esc(g.name || '') + '" loading="lazy" />' : '<div class="game-emoji">🎮</div>') +
      '<span>' + esc(g.name || 'Game') + '</span></div></div>'
    ).join('') : '<div class="col-12 text-center" style="color:var(--ax-muted)">No games yet. Admin will add soon!</div>';
    document.querySelectorAll('#axGamesList [data-game]').forEach((el) => el.addEventListener('click', () => {
      gameFilter = el.dataset.game; gameFilterName = el.dataset.gname;
      showSection('tournaments-section');
      renderTournaments();
    }));
  }
  function statusPill(st) {
    return '<span class="status-pill st-' + esc(st || 'upcoming') + '">' + esc(st || 'upcoming') + '</span>';
  }
  function tourCard(t) {
    const joined = !!S.myJoins[t.id];
    const filled = Number(t.spotsFilled || 0), max = Number(t.maxPlayers || 0);
    const pct = max > 0 ? Math.min(100, Math.round((filled / max) * 100)) : 0;
    const fee = Number(t.entryFee || 0);
    const closed = t.status === 'completed' || t.status === 'cancelled';
    const full = max > 0 && filled >= max;
    let joinBtn;
    if (joined) joinBtn = '<button class="btn-custom btn-sm btn-joined" disabled>✓ Joined</button>';
    else if (closed) joinBtn = '<button class="btn-custom btn-sm btn-disabled" disabled>' + esc(t.status) + '</button>';
    else if (full) joinBtn = '<button class="btn-custom btn-sm btn-disabled" disabled>Full</button>';
    else joinBtn = '<button class="btn-custom btn-sm btn-join" data-act="join" data-tid="' + esc(t.id) + '">Join • 🎟' + fmtN(fee) + '</button>';
    const roomBtn = (joined && t.showIdPass !== false && (t.roomId || t.roomPassword))
      ? '<button class="btn-custom btn-sm btn-idpass" data-act="room" data-tid="' + esc(t.id) + '">🔑 ID/Pass</button>' : '';
    const res = t.status === 'completed' && t.winners && t.winners.length
      ? '<div class="mt-2 small">🥇 Winner: <strong>' + esc(t.winners[0].name || t.winners[0].uid || '') + '</strong> (+' + fmtN(t.winners[0].prize) + ' 🎟)</div>' : '';
    return '<div class="tournament-card">' +
      '<div class="tournament-card-banner">' + (t.bannerUrl ? '<img src="' + esc(t.bannerUrl) + '" loading="lazy" alt="" />' : '🏆') + '</div>' +
      '<div class="tournament-card-content">' +
      '<div class="d-flex justify-content-between align-items-center gap-2"><div class="tournament-card-title">' + esc(t.name || 'Tournament') + '</div>' + statusPill(t.status) + '</div>' +
      '<div class="small" style="color:var(--ax-muted)">🕒 ' + esc(fmtD(t.matchDate)) + ' · ⏳ ' + esc(timeLeft(t.matchDate)) + ' · 👥 ' + (t.mode === 'duo' ? 'DUO' : 'SOLO') + '</div>' +
      '<div class="tournament-info-strip">' +
      '<div class="info-item"><span>PRIZE POOL</span><strong style="color:var(--ax-accent)">🎟 ' + fmtN(t.prizePool) + '</strong></div>' +
      '<div class="info-item"><span>ENTRY</span><strong>🎟 ' + fmtN(fee) + '</strong></div>' +
      '<div class="info-item"><span>PER KILL</span><strong>🎟 ' + fmtN(t.perKillPrize) + '</strong></div>' +
      '</div>' +
      '<div class="tournament-card-spots">Spots: <span>' + fmtN(filled) + (max ? '/' + fmtN(max) : '') + '</span><div class="progress"><div class="progress-bar" style="width:' + pct + '%"></div></div></div>' +
      res +
      '<div class="tournament-card-actions">' + joinBtn +
      '<button class="btn-custom btn-sm btn-details" data-act="details" data-tid="' + esc(t.id) + '">Details</button>' +
      '<button class="btn-custom btn-sm btn-details" data-act="chat" data-tid="' + esc(t.id) + '">💬 Chat</button>' +
      roomBtn + '</div></div></div>';
  }
  function bindTourButtons(root) {
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const tid = b.dataset.tid, act = b.dataset.act;
      if (act === 'join') openJoin(tid);
      else if (act === 'details') openDetails(tid);
      else if (act === 'chat') openChat(tid);
      else if (act === 'room') openRoom(tid);
    }));
  }
  function renderTournaments() {
    let arr = Object.keys(S.tournaments).map((id) => ({ id, ...S.tournaments[id] }));
    arr = arr.filter((t) => (t.status || 'upcoming') === tourTab);
    if (gameFilter) arr = arr.filter((t) => (t.gameId || '') === gameFilter);
    if (tourSearch) { const q = tourSearch.toLowerCase(); arr = arr.filter((t) => ((t.name || '') + ' ' + (t.map || '')).toLowerCase().includes(q)); }
    arr.sort((a, b) => (a.matchDate || 0) - (b.matchDate || 0));
    const box = $('axTourList');
    box.innerHTML = arr.map(tourCard).join('');
    $('axNoTours').style.display = arr.length ? 'none' : '';
    bindTourButtons(box);
  }
  function renderMyContests() {
    const ids = Object.keys(S.myJoins);
    const arr = ids.map((id) => S.tournaments[id] ? { id, ...S.tournaments[id] } : null).filter(Boolean)
      .sort((a, b) => (b.matchDate || 0) - (a.matchDate || 0)).slice(0, 10);
    const box = $('axMyContests');
    box.innerHTML = arr.map(tourCard).join('');
    $('axNoContests').style.display = arr.length ? 'none' : '';
    bindTourButtons(box);
  }

  // ── join / details / room ──────────────────────────────────
  let joinTid = null;
  function openJoin(tid) {
    const t = S.tournaments[tid];
    if (!t) return;
    if (!user) { toast('Please login first.', 'err'); showSection('login-section', true); return; }
    joinTid = tid;
    const isDuo = (t.mode || 'solo') === 'duo';
    $('axDuoFields').style.display = isDuo ? '' : 'none';
    $('axJoinInfo').textContent = `${t.name || ''} • Entry 🎟${fmtN(t.entryFee)} (bonus first) • ${isDuo ? 'DUO' : 'SOLO'} • ${fmtD(t.matchDate)}`;
    $('axJoinName').value = (profile && profile.name) || '';
    $('axJoinUid').value = '';
    fieldMsg('axJoinMsg', '');
    new bootstrap.Modal($('axJoinModal')).show();
  }
  function openDetails(tid) {
    const t = S.tournaments[tid];
    if (!t) return;
    const g = S.games[t.gameId || ''];
    $('axDetailsTitle').textContent = t.name || 'Match Details';
    let html = '<p>' + statusPill(t.status) + ' <span class="small" style="color:var(--ax-muted)">🎮 ' + esc(g ? g.name : '') + ' · 👥 ' + (t.mode === 'duo' ? 'DUO' : 'SOLO') + '</span></p>';
    html += '<div class="tournament-info-strip"><div class="info-item"><span>PRIZE</span><strong style="color:var(--ax-accent)">🎟 ' + fmtN(t.prizePool) + '</strong></div><div class="info-item"><span>ENTRY</span><strong>🎟 ' + fmtN(t.entryFee) + '</strong></div><div class="info-item"><span>PER KILL</span><strong>🎟 ' + fmtN(t.perKillPrize) + '</strong></div></div>';
    html += '<p class="small">🕒 ' + esc(fmtD(t.matchDate)) + (t.map ? ' · 🗺 ' + esc(t.map) : '') + (t.perspective ? ' · ' + esc(t.perspective) : '') + '</p>';
    if (t.description) html += '<h6>Description</h6><pre class="ax-pre">' + esc(t.description) + '</pre>';
    if (t.prizeDistribution) html += '<h6>Prize Distribution</h6><pre class="ax-pre">' + esc(t.prizeDistribution) + '</pre>';
    if (t.winners && t.winners.length) {
      html += '<h6>🏆 Winners</h6>' + t.winners.map((w) => '<div class="txn-row"><div class="t-left"><strong>#' + esc(w.rank) + ' ' + esc(w.name || w.uid || '') + '</strong></div><div class="txn-pos">+' + fmtN(w.prize) + ' 🎟</div></div>').join('');
    }
    if (t.resultNote) html += '<p class="small" style="color:var(--ax-muted)">' + esc(t.resultNote) + '</p>';
    $('axDetailsBody').innerHTML = html;
    new bootstrap.Modal($('axDetailsModal')).show();
  }
  function openRoom(tid) {
    const t = S.tournaments[tid];
    if (!t || !S.myJoins[tid]) { toast('Join this contest to unlock room details.', 'err'); return; }
    $('axRoomId').textContent = t.roomId || '—';
    $('axRoomPass').textContent = t.roomPassword || '—';
    new bootstrap.Modal($('axRoomModal')).show();
  }

  // ── chat ───────────────────────────────────────────────────
  let chatOff = null;
  function openChat(tid) {
    const t = S.tournaments[tid];
    if (!t) return;
    if (!user) { toast('Login to chat.', 'err'); return; }
    S.chatTid = tid; S.chatReply = null;
    $('axChatTitle').textContent = '💬 ' + (t.name || 'Match Chat');
    $('chatMessagesEl').innerHTML = '<p class="text-center small" style="color:var(--ax-muted)">Loading messages…</p>';
    new bootstrap.Modal($('axChatModal')).show();
    if (chatOff) { try { chatOff.off(); } catch (_) {} chatOff = null; }
    const ref = db.ref('chats/' + tid).limitToLast(60);
    chatOff = ref;
    ref.on('value', (s) => {
      const box = $('chatMessagesEl');
      const msgs = [];
      s.forEach((c) => msgs.push({ id: c.key, ...c.val() }));
      if (!msgs.length) { box.innerHTML = '<p class="text-center small" style="color:var(--ax-muted)">No messages yet. Say hello! 👋</p>'; return; }
      box.innerHTML = msgs.map((m) => {
        const mine = m.uid === user.uid;
        return '<div class="chat-msg' + (mine ? ' mine' : '') + '" data-reply="' + esc(m.id) + '" data-rname="' + esc(m.senderName || 'Player') + '" data-rtext="' + esc(String(m.message || '').slice(0, 80)) + '">' +
          '<span class="c-name">' + esc(m.senderName || 'Player') + '</span><span class="c-time">' + esc(fmtD(m.timestamp)) + '</span>' +
          (m.replyTo ? '<div class="c-reply">↩️ ' + esc(m.replyTo) + '</div>' : '') +
          '<div>' + esc(m.message || '') + '</div></div>';
      }).join('');
      box.querySelectorAll('[data-reply]').forEach((el) => el.addEventListener('click', () => {
        S.chatReply = el.dataset.rname + ': ' + el.dataset.rtext;
        $('axReplyText').textContent = S.chatReply;
        $('axReplyBar').style.display = '';
      }));
      box.scrollTop = box.scrollHeight;
    });
  }

  // ── wallet / earnings ──────────────────────────────────────
  function renderWallet() {
    if (!profile) return;
    $('axBalTickets').textContent = fmtN(profile.tickets);
    $('axBalBonus').textContent = fmtN(profile.bonusTickets);
    $('axChipTickets').textContent = fmtN((profile.tickets || 0) + (profile.bonusTickets || 0));
  }
  function txnRow(l) {
    const amt = Number(l.amount || 0);
    const cls = amt > 0 ? 'txn-pos' : (amt < 0 ? 'txn-neg' : 'txn-zero');
    return '<div class="txn-row"><div class="t-left"><strong>' + esc(l.reason || l.type || '—') + '</strong><small>' + esc(l.type || '') + ' · ' + esc(fmtD(l.ts)) + '</small></div><div class="' + cls + '">' + (amt > 0 ? '+' : '') + fmtN(amt) + ' 🎟</div></div>';
  }
  function renderTxns() {
    $('axRecentTxns').innerHTML = S.txns.length
      ? S.txns.slice(0, 12).map(txnRow).join('')
      : '<p class="text-center small" style="color:var(--ax-muted)">No transactions yet.</p>';
  }
  function renderEarnings() {
    if (!profile) return;
    let win = 0, ads = 0, ref = 0;
    S.txns.forEach((t) => {
      const a = Number(t.amount || 0);
      if (a <= 0) return;
      if (t.type === 'winnings') win += a;
      else if (t.type === 'ad') ads += a;
      else if (t.type === 'referral' || t.type === 'bonus') ref += a;
    });
    $('axEarnTotal').textContent = fmtN(profile.totalEarnings);
    $('axEarnWin').textContent = fmtN(win);
    $('axEarnAds').textContent = fmtN(ads);
    $('axEarnRef').textContent = fmtN(ref);
  }
  function renderAdHistory() {
    $('axAdHistory').innerHTML = S.adHistory.length
      ? S.adHistory.slice(0, 15).map((a) => '<div class="txn-row"><div class="t-left"><strong>🎬 Ad watched</strong><small>' + esc(fmtD(a.ts)) + '</small></div><div class="txn-pos">+' + fmtN(a.tickets) + ' 🎟</div></div>').join('')
      : '<p class="text-center small" style="color:var(--ax-muted)">No ad rewards today yet.</p>';
  }
  function renderAdNote() {
    const st = S.settings;
    const limit = st.adDailyLimit === undefined ? 20 : Number(st.adDailyLimit);
    $('axAdDaily').textContent = `Today: ${S.adHistory.length}/${limit} rewards claimed`;
    const cd = Number(st.adCooldownSec === undefined ? 60 : st.adCooldownSec);
    const last = profile ? Number(profile.lastAdRewardAt || 0) : 0;
    const left = cd - Math.floor((Date.now() - last) / 1000);
    const btn = $('axWatchAdBtn');
    if (left > 0 && last > 0) {
      S.adCooldownUntil = Date.now() + left * 1000;
      btn.disabled = true;
      $('axAdNote').textContent = `⏳ Next reward in ${left}s`;
    } else if (S.adHistory.length >= limit) {
      btn.disabled = true;
      $('axAdNote').textContent = '✅ Daily limit reached. Come back tomorrow!';
    } else {
      btn.disabled = false;
      $('axAdNote').textContent = '';
    }
  }
  function tickTimers() {
    if (S.adCooldownUntil && Date.now() >= S.adCooldownUntil) { S.adCooldownUntil = 0; renderAdNote(); }
    else if (S.adCooldownUntil) {
      const left = Math.ceil((S.adCooldownUntil - Date.now()) / 1000);
      if (left > 0) $('axAdNote').textContent = `⏳ Next reward in ${left}s`;
    }
  }

  async function watchAdFlow() {
    if (!user) { toast('Login first.', 'err'); return; }
    const link = (S.settings.adLink || '').trim();
    if (link) window.open(link, '_blank', 'noopener');
    else toast('Loading reward… 🎬');
    const btn = $('axWatchAdBtn');
    btn.disabled = true;
    const old = btn.innerHTML;
    let secs = 8;
    btn.innerHTML = `⏳ Verifying… ${secs}s`;
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        secs--;
        if (secs <= 0) { clearInterval(iv); resolve(); }
        else btn.innerHTML = `⏳ Verifying… ${secs}s`;
      }, 1000);
    });
    try {
      const r = await api('claimAdReward', {});
      toast(`🎉 +${fmtN(r.reward)} tickets! (${r.usedToday}/${r.dailyLimit} today)`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.innerHTML = old;
    renderAdNote();
  }

  // ── leaderboard / profile / notifs ─────────────────────────
  function renderLeaderboard() {
    const box = $('axLeaderboard');
    if (!S.leaderboard.length) { box.innerHTML = ''; $('axNoLb').style.display = ''; return; }
    $('axNoLb').style.display = 'none';
    box.innerHTML = S.leaderboard.map((r) =>
      '<div class="lb-row lb-' + r.rank + (user && r.me ? ' me' : '') + '"><div class="lb-rank">' + (r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank) + '</div>' +
      '<div style="flex:1"><strong>' + esc(r.name || 'Player') + '</strong><br><small style="color:var(--ax-muted)">🏆 ' + fmtN(r.wins) + ' wins · ⚔️ ' + fmtN(r.matches) + ' matches</small></div>' +
      '<div style="text-align:right"><strong style="color:var(--ax-accent)">' + fmtN(r.points) + '</strong><br><small style="color:var(--ax-muted)">points</small></div></div>'
    ).join('');
  }
  function renderProfile() {
    if (!profile) return;
    $('axProfileName').textContent = profile.name || 'Player';
    $('axProfileEmail').textContent = profile.email || (user && user.email) || '';
    $('axStatMatches').textContent = fmtN(profile.matchesPlayed);
    $('axStatWins').textContent = fmtN(profile.matchesWon);
    $('axStatEarn').textContent = fmtN(profile.totalEarnings);
    $('axStatRank').textContent = profile.leaderboardRank ? '#' + profile.leaderboardRank : '—';
    $('axMyRefCode').textContent = profile.referralCode || '—';
  }
  function renderNotifBadge() {
    const mine = Object.keys(S.personalNotifs).map((id) => ({ id, ...S.personalNotifs[id] }));
    const unread = mine.filter((n) => n.read !== true).length + Object.keys(S.globalNotifs).length;
    const b = $('axBellBadge');
    const lastSeen = Number(localStorage.getItem('axNotifSeen') || 0);
    const freshGlobal = Object.values(S.globalNotifs).filter((n) => (n.createdAt || 0) > lastSeen).length;
    const total = unread > 0 ? freshGlobal + mine.filter((n) => n.read !== true).length : 0;
    b.style.display = total > 0 ? '' : 'none';
    b.textContent = total > 9 ? '9+' : total;
  }
  function openNotifs() {
    const mine = Object.keys(S.personalNotifs).map((id) => ({ id, scope: 'me', ...S.personalNotifs[id] }));
    const glob = Object.keys(S.globalNotifs).map((id) => ({ id, scope: 'global', ...S.globalNotifs[id] }));
    const all = [...mine, ...glob].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
    $('axNotifList').innerHTML = all.length ? all.map((n) =>
      '<div class="notif-item' + (n.read === false ? ' unread' : '') + '"><strong>' + esc(n.title || 'Arena') + '</strong><br>' + esc(n.message || '') +
      '<br><small>' + esc(fmtD(n.createdAt)) + '</small>' +
      (n.scope === 'me' && n.read === false ? '<br><button class="btn-custom-link small" data-nread="' + esc(n.id) + '">Mark read</button>' : '') + '</div>'
    ).join('') : '<p class="text-center small" style="color:var(--ax-muted)">No notifications yet.</p>';
    $('axNotifList').querySelectorAll('[data-nread]').forEach((btn) => btn.addEventListener('click', async () => {
      try { await api('markNotificationsRead', { ids: [btn.dataset.nread] }); } catch (e) { toast(e.message, 'err'); }
    }));
    localStorage.setItem('axNotifSeen', String(Date.now()));
    renderNotifBadge();
    new bootstrap.Modal($('axNotifModal')).show();
  }

  // ── theme ──────────────────────────────────────────────────
  function applySavedTheme() {
    const t = localStorage.getItem('axTheme') || 'midnight';
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('#axThemeDots .theme-dot').forEach((d) => d.classList.toggle('sel', d.dataset.theme === t));
  }

  // ── UI bindings ────────────────────────────────────────────
  function bindUI() {
    document.querySelectorAll('#axBottomNav .nav-item').forEach((b) => b.addEventListener('click', () => {
      if (!user) { showSection('login-section', true); return; }
      if (b.dataset.section === 'tournaments-section' && b.dataset.section !== document.querySelector('.section.active').id) { /* keep filter */ }
      showSection(b.dataset.section);
    }));
    $('axBackBtn').addEventListener('click', goBack);
    $('axWalletChip').addEventListener('click', () => showSection('wallet-section'));
    $('axBellBtn').addEventListener('click', () => { if (user) openNotifs(); else showSection('login-section', true); });
    $('axNotifReadAll').addEventListener('click', async () => {
      try { await api('markNotificationsRead', { all: true }); toast('All caught up ✓', 'ok'); } catch (e) { toast(e.message, 'err'); }
    });

    // auth
    $('axShowSignup').addEventListener('click', () => { $('axLoginForm').style.display = 'none'; $('axSignupForm').style.display = ''; });
    $('axShowLogin').addEventListener('click', () => { $('axSignupForm').style.display = 'none'; $('axLoginForm').style.display = ''; });
    $('axLoginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      fieldMsg('axLoginMsg', '');
      $('axLoginBtn').disabled = true;
      try {
        await auth.signInWithEmailAndPassword($('axLoginEmail').value.trim(), $('axLoginPass').value);
        toast('Welcome back! 🎮', 'ok');
      } catch (err) { fieldMsg('axLoginMsg', friendlyAuthError(err), true); }
      $('axLoginBtn').disabled = false;
    });
    $('axSignupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      fieldMsg('axSignupMsg', '');
      const ref = $('axSuRef').value.trim().toUpperCase();
      if (ref) sessionStorage.setItem('axPendingRef', ref);
      $('axSignupBtn').disabled = true;
      try {
        const cred = await auth.createUserWithEmailAndPassword($('axSuEmail').value.trim(), $('axSuPass').value);
        try { await cred.user.updateProfile({ displayName: $('axSuName').value.trim() }); } catch (_) {}
        toast('Account created! 🎉', 'ok');
      } catch (err) { fieldMsg('axSignupMsg', friendlyAuthError(err), true); }
      $('axSignupBtn').disabled = false;
    });
    $('axGoogleBtn').addEventListener('click', async () => {
      try {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        await auth.signInWithPopup(provider);
        toast('Welcome! 🎮', 'ok');
      } catch (e) {
        if (e && e.code === 'auth/popup-blocked') {
          try { await auth.signInWithRedirect(new window.firebase.auth.GoogleAuthProvider()); return; } catch (e2) { toast(e2.message, 'err'); return; }
        }
        toast(friendlyAuthError(e), 'err');
      }
    });
    $('axForgotPass').addEventListener('click', async () => {
      const em = $('axLoginEmail').value.trim();
      if (!em) { fieldMsg('axLoginMsg', 'Enter your email above first, then tap Forgot Password.', true); return; }
      try { await auth.sendPasswordResetEmail(em); fieldMsg('axLoginMsg', 'Reset link sent to ' + em + ' ✓'); }
      catch (e) { fieldMsg('axLoginMsg', friendlyAuthError(e), true); }
    });
    $('axLogoutBtn').addEventListener('click', async () => {
      if (!(await confirmDlg('Logout', 'Are you sure you want to logout?'))) return;
      await auth.signOut();
    });

    // tournaments
    document.querySelectorAll('#axTourTabs .tab-item').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#axTourTabs .tab-item').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      tourTab = b.dataset.status;
      renderTournaments();
    }));
    $('axTourSearch').addEventListener('input', debounce((e) => { tourSearch = e.target.value.trim(); renderTournaments(); }, 220));

    // join
    $('axJoinConfirm').addEventListener('click', async () => {
      const t = S.tournaments[joinTid];
      if (!t) return;
      fieldMsg('axJoinMsg', '');
      $('axJoinConfirm').disabled = true;
      try {
        const r = await api('joinTournament', {
          tournamentId: joinTid, mode: t.mode || 'solo',
          username: $('axJoinName').value.trim(), gameUid: $('axJoinUid').value.trim(),
          teammateName: $('axJoinMateName').value.trim(), teammateGameUid: $('axJoinMateUid').value.trim(),
          idempotencyKey: joinTid + '-' + Date.now(),
        });
        bootstrap.Modal.getInstance($('axJoinModal')).hide();
        toast(`✅ Joined! Paid 🎟${fmtN(r.fee)} (bonus 🎟${fmtN(r.fromBonus)} + wallet 🎟${fmtN(r.fromTickets)})`, 'ok');
        probeMyJoins();
      } catch (e) { fieldMsg('axJoinMsg', e.message, true); }
      $('axJoinConfirm').disabled = false;
    });

    // chat
    $('axChatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('axChatInput').value.trim();
      if (!text || !S.chatTid) return;
      $('axChatInput').value = '';
      try {
        await db.ref('chats/' + S.chatTid).push({
          uid: user.uid, senderName: (profile && profile.name) || 'Player',
          message: text.slice(0, 500), timestamp: SV.TIMESTAMP,
          replyTo: S.chatReply || '',
        });
        S.chatReply = null;
        $('axReplyBar').style.display = 'none';
      } catch (err) { toast('Could not send: ' + err.message, 'err'); }
    });
    $('axReplyCancel').addEventListener('click', () => { S.chatReply = null; $('axReplyBar').style.display = 'none'; });
    $('axCopyRoomId').addEventListener('click', () => copyText($('axRoomId').textContent));
    $('axCopyRoomPass').addEventListener('click', () => copyText($('axRoomPass').textContent));

    // wallet
    $('axWatchAdBtn').addEventListener('click', watchAdFlow);
    $('axRechargeBtn').addEventListener('click', () => showSection('recharge-section'));
    $('axHistoryBtn').addEventListener('click', () => openHistory('txns'));
    $('axEarnHistoryBtn').addEventListener('click', () => openHistory('earnings'));
    $('axGoHistory').addEventListener('click', () => openHistory('matches'));
    $('axGoEarnings').addEventListener('click', () => showSection('earnings-section'));
    $('axGoRecharge').addEventListener('click', () => showSection('recharge-section'));
    $('axWithdrawBtn').addEventListener('click', () => {
      $('axWdBalance').textContent = fmtN(profile ? profile.tickets : 0);
      fieldMsg('axWdMsg', '');
      new bootstrap.Modal($('axWithdrawModal')).show();
    });
    $('axWdSubmit').addEventListener('click', async () => {
      fieldMsg('axWdMsg', '');
      $('axWdSubmit').disabled = true;
      try {
        const r = await api('createWithdrawal', { amount: Number($('axWdAmount').value), method: $('axWdMethod').value, account: $('axWdAccount').value.trim() });
        bootstrap.Modal.getInstance($('axWithdrawModal')).hide();
        toast(`💸 Requested ${fmtN(r.amount)} tickets. Balance: ${fmtN(r.balanceAfter)}`, 'ok');
        $('axWdAmount').value = ''; $('axWdAccount').value = '';
      } catch (e) { fieldMsg('axWdMsg', e.message, true); }
      $('axWdSubmit').disabled = false;
    });

    // recharge
    document.querySelectorAll('#axRcPresets .amount-preset-btn').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#axRcPresets .amount-preset-btn').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      $('axRcAmount').value = b.dataset.amt;
    }));
    $('axCopyUpiBtn').addEventListener('click', () => copyText($('axUpiIdText').textContent));
    $('axRcSubmit').addEventListener('click', async () => {
      const amt = Number($('axRcAmount').value), utr = $('axRcUtr').value.trim();
      if (!amt || amt < 10) { toast('Minimum recharge is ₹10.', 'err'); return; }
      if (utr.length < 6) { toast('Enter the UTR number from your payment app.', 'err'); return; }
      $('axRcSubmit').disabled = true;
      try {
        await api('createDeposit', { amount: amt, utr });
        toast('🧾 Recharge submitted! Tickets credit after admin verification.', 'ok');
        $('axRcAmount').value = ''; $('axRcUtr').value = '';
      } catch (e) { toast(e.message, 'err'); }
      $('axRcSubmit').disabled = false;
    });

    // profile
    $('axEditNameBtn').addEventListener('click', () => {
      $('axNameInput').value = (profile && profile.name) || '';
      fieldMsg('axNameMsg', '');
      new bootstrap.Modal($('axNameModal')).show();
    });
    $('axNameSave').addEventListener('click', async () => {
      try {
        const r = await api('updateProfile', { name: $('axNameInput').value.trim() });
        bootstrap.Modal.getInstance($('axNameModal')).hide();
        toast('Name updated to ' + r.name + ' ✓', 'ok');
      } catch (e) { fieldMsg('axNameMsg', e.message, true); }
    });
    $('axCopyRefBtn').addEventListener('click', () => copyText($('axMyRefCode').textContent));
    $('axShareRefBtn').addEventListener('click', async () => {
      const code = $('axMyRefCode').textContent.trim();
      const text = `🎮 Join ${S.settings.appName || 'Arena X'} with my code ${code} and earn bonus tickets! ${location.origin}`;
      if (navigator.share) { try { await navigator.share({ title: 'Arena X', text }); } catch (_) {} }
      else copyText(text);
    });
    $('axThemeBtn').addEventListener('click', () => new bootstrap.Modal($('axThemeModal')).show());
    document.querySelectorAll('#axThemeDots .theme-dot').forEach((d) => d.addEventListener('click', () => {
      localStorage.setItem('axTheme', d.dataset.theme);
      applySavedTheme();
      bootstrap.Modal.getInstance($('axThemeModal')).hide();
    }));
    $('axSoundSwitch').checked = Sound.enabled();
    $('axSoundSwitch').addEventListener('change', (e) => localStorage.setItem('axSound', e.target.checked ? 'on' : 'off'));
    $('axNotifSwitch').checked = localStorage.getItem('axNotif') !== 'off';
    $('axNotifSwitch').addEventListener('change', (e) => localStorage.setItem('axNotif', e.target.checked ? 'on' : 'off'));

    // policies + contact
    const pol = () => (S.settings.policies || {});
    $('axAboutBtn').addEventListener('click', () => openPolicy('About Us', pol().about));
    $('axPrivacyBtn').addEventListener('click', () => openPolicy('Privacy Policy', pol().privacy));
    $('axTermsBtn').addEventListener('click', () => openPolicy('Terms & Conditions', pol().terms));
    $('axRefundBtn').addEventListener('click', () => openPolicy('Refund Policy', pol().refund));
    $('axContactBtn').addEventListener('click', () => {
      const st = S.settings;
      openPolicy('Contact Us', `${st.supportEmail ? '📧 Email: ' + st.supportEmail + '\n' : ''}${st.supportUrl ? '🔗 Support: ' + st.supportUrl + '\n' : ''}\nWe usually reply within 24 hours. For payment issues, keep your UTR ready.`);
    });
  }

  function openPolicy(title, body) {
    $('axPolicyTitle').textContent = title;
    $('axPolicyBody').textContent = body || 'Not published yet. Please check back soon.';
    new bootstrap.Modal($('axPolicyModal')).show();
  }
  function openHistory(kind) {
    const body = $('axHistoryBody');
    if (kind === 'txns' || kind === 'earnings') {
      $('axHistoryTitle').textContent = kind === 'earnings' ? 'Earnings History' : 'All Transactions';
      const list = kind === 'earnings' ? S.txns.filter((t) => Number(t.amount) > 0) : S.txns;
      body.innerHTML = list.length ? list.map(txnRow).join('') : '<p class="text-center small" style="color:var(--ax-muted)">Nothing here yet.</p>';
    } else {
      $('axHistoryTitle').textContent = 'Match History';
      const ids = Object.keys(S.myJoins);
      body.innerHTML = ids.length ? ids.map((tid) => {
        const t = S.tournaments[tid] || {};
        const j = S.myJoins[tid] || {};
        return '<div class="txn-row"><div class="t-left"><strong>' + esc(t.name || tid) + '</strong><small>' + esc(fmtD(t.matchDate)) + ' · fee 🎟' + fmtN(j.feePaid) + ' · ' + esc(t.status || '') + '</small></div><div>' + statusPill(t.status) + '</div></div>';
      }).join('') : '<p class="text-center small" style="color:var(--ax-muted)">No matches played yet.</p>';
    }
    new bootstrap.Modal($('axHistoryModal')).show();
  }

  function friendlyAuthError(e) {
    const map = {
      'auth/invalid-email': 'Invalid email address.',
      'auth/user-not-found': 'No account with this email. Sign up first.',
      'auth/wrong-password': 'Wrong password. Try again.',
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/email-already-in-use': 'This email is already registered. Login instead.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Try again later.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/popup-closed-by-user': 'Google popup closed. Try again.',
    };
    return (e && map[e.code]) || (e && e.message) || 'Authentication failed.';
  }
})();
