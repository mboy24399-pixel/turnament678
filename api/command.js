// ═══════════════════════════════════════════════════════════════
//  E-SPORT ARENA X — /api/command : the ONLY trusted game-logic writer.
//  Tickets, joins, ad-rewards, withdrawals, referrals, winnings — sab kuch
//  yahin verify hota hai. Browser se koi balance change kabhi trust nahi hota.
//  Auth: Authorization: Bearer <Firebase ID token>  Body: {action, ...params}
// ═══════════════════════════════════════════════════════════════
const { getDb, getAdmin, requireAuth, requireAdmin, requireActiveUser, parseBody, setCors, ok, fail, rateLimit } = require('./_admin');

const PLAYER_ACTIONS = new Set(['syncUser', 'updateProfile', 'joinTournament', 'claimAdReward', 'createWithdrawal', 'createDeposit', 'markNotificationsRead']);
const ADMIN_ACTIONS = new Set([
  'setupAdmin', 'adminPing',
  'upsertGame', 'deleteGame', 'upsertPromotion', 'deletePromotion',
  'upsertTournament', 'deleteTournament', 'setRoom', 'declareWinners',
  'adjustBalance', 'toggleBlock', 'createUser', 'deleteUserData',
  'approveWithdrawal', 'rejectWithdrawal', 'approveDeposit', 'rejectDeposit',
  'approveReferral', 'rejectReferral',
  'sendGlobalNotification', 'sendUserNotification', 'deleteChatMessage',
  'updateSettings', 'recomputeLeaderboard', 'listUsers', 'getUserDetail',
  'recentTransactions', 'analyticsSnapshot', 'seedDemoData', 'auditList', 'adminFeed',
]);

const now = () => Date.now();
const asInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const cleanStr = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max || 500);
const cleanId = (v) => cleanStr(v, 120).replace(/[.#$\[\]]/g, '');
function need(cond, msg) { if (!cond) { const e = new Error(msg); e.status = 400; e.code = 'INVALID_ARGUMENT'; throw e; } }

function checkAppCheck(req) {
  if (String(process.env.APP_CHECK_ENFORCE || 'false').toLowerCase() !== 'true') return;
  const tok = req.headers['x-firebase-appcheck'] || req.headers['X-Firebase-AppCheck'] || '';
  if (!tok || String(tok).length < 20) {
    const e = new Error('Security check failed. Update the app and retry.');
    e.status = 403; e.code = 'APP_CHECK_REQUIRED';
    throw e;
  }
}

// ── settings (cached per warm instance, short TTL) ────────────
let _settingsCache = { at: 0, data: null };
async function getSettings(db) {
  if (_settingsCache.data && Date.now() - _settingsCache.at < 30000) return _settingsCache.data;
  const snap = await db.ref('settings').get();
  const s = snap.val() || {};
  _settingsCache = { at: Date.now(), data: s };
  return s;
}
const S = (s, k, d) => (s[k] === undefined || s[k] === null || s[k] === '' ? d : s[k]);

// ── audit + idempotency ───────────────────────────────────────
async function audit(db, by, action, detail) {
  try { await db.ref('auditLog').push({ by: cleanStr(by, 128), action: cleanStr(action, 60), detail: cleanStr(detail, 500), ts: now() }); } catch {}
}
async function idemFresh(db, key, ttlMs) {
  if (!key) return true;
  const k = cleanStr(key, 120).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!k) return true;
  const ref = db.ref('idempotency/' + k);
  const tx = await ref.transaction((cur) => {
    if (cur && (now() - cur.ts) < (ttlMs || 120000)) return; // seen recently → abort
    return { ts: now() };
  });
  return tx.committed;
}

// ── ticket engine (atomic node transactions) ─────────────────
async function recordTxn(db, uid, { amount, type, reason, refId, balanceAfter }) {
  await db.ref('transactions/' + uid).push({
    amount: asInt(amount, 0), type: cleanStr(type, 40) || 'adjust',
    reason: cleanStr(reason, 200) || '', refId: cleanStr(refId, 120) || '',
    balanceAfter: asInt(balanceAfter, 0), ts: now(),
  });
}
async function notifyUser(db, uid, { title, message, imageUrl }) {
  try {
    await db.ref(`users/${uid}/notifications`).push({
      title: cleanStr(title, 140) || 'Arena', message: cleanStr(message, 1000),
      imageUrl: cleanStr(imageUrl, 500) || '', read: false, createdAt: now(),
    });
  } catch {}
}

// Add (or remove if negative) TICKETS atomically. Floor at 0.
async function moveTickets(db, uid, delta, { reason, refId, type, earnable }) {
  need(Number.isInteger(delta) && delta !== 0, 'Invalid ticket amount.');
  need(Math.abs(delta) <= 10000000, 'Amount too large.');
  const ref = db.ref('users/' + uid);
  const tx = await ref.transaction((u) => {
    if (!u) return u; // no user → abort below
    u = { ...u };
    const t = typeof u.tickets === 'number' ? u.tickets : 0;
    const next = t + delta;
    if (next < 0) return; // abort: insufficient
    u.tickets = next;
    if (earnable && delta > 0) u.totalEarnings = (typeof u.totalEarnings === 'number' ? u.totalEarnings : 0) + delta;
    u.updatedAt = now();
    return u;
  });
  if (!tx.committed || !tx.snapshot.val()) {
    const e = new Error(delta < 0 ? 'Insufficient ticket balance.' : 'Balance update failed.');
    e.status = 400; e.code = delta < 0 ? 'INSUFFICIENT_TICKETS' : 'TX_FAILED';
    throw e;
  }
  const after = tx.snapshot.val().tickets;
  await recordTxn(db, uid, { amount: delta, type: type || (delta > 0 ? 'credit' : 'debit'), reason, refId, balanceAfter: after });
  return after;
}

// Bonus-first debit for tournament entry. Returns {fromBonus, fromTickets}.
async function debitEntryFee(db, uid, fee) {
  need(Number.isInteger(fee) && fee >= 0, 'Invalid entry fee.');
  if (fee === 0) return { fromBonus: 0, fromTickets: 0 };
  const ref = db.ref('users/' + uid);
  let split = null;
  const tx = await ref.transaction((u) => {
    if (!u) return u;
    u = { ...u };
    const b = typeof u.bonusTickets === 'number' ? u.bonusTickets : 0;
    const t = typeof u.tickets === 'number' ? u.tickets : 0;
    if (b + t < fee) return; // abort
    const fromBonus = Math.min(b, fee);
    const fromTickets = fee - fromBonus;
    u.bonusTickets = b - fromBonus;
    u.tickets = t - fromTickets;
    u.updatedAt = now();
    split = { fromBonus, fromTickets };
    return u;
  });
  if (!tx.committed || !tx.snapshot.val()) {
    const e = new Error('Not enough tickets (wallet + bonus) for this entry fee.');
    e.status = 400; e.code = 'INSUFFICIENT_TICKETS';
    throw e;
  }
  return { ...split, balanceAfter: tx.snapshot.val().tickets, bonusAfter: tx.snapshot.val().bonusTickets };
}

function genReferralCode(uid) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const seed = (uid + Date.now() + Math.random()).split('');
  let h = 0;
  for (const ch of seed.join('')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 0; i < 8; i++) { h = (h * 1103515245 + 12345) >>> 0; code += alphabet[h % alphabet.length]; }
  return code;
}
async function uniqueReferralCode(db) {
  for (let i = 0; i < 6; i++) {
    const code = genReferralCode('u' + i);
    const q = await db.ref('users').orderByChild('referralCode').equalTo(code).limitToFirst(1).get();
    if (!q.exists()) return code;
  }
  return 'AX' + Date.now().toString(36).toUpperCase();
}

// ══════════════ PLAYER HANDLERS ══════════════

async function h_syncUser(db, decoded, p) {
  const uid = decoded.uid;
  const ref = db.ref('users/' + uid);
  const snap = await ref.get();
  const email = cleanStr(decoded.email, 120);
  if (!snap.exists()) {
    const settings = await getSettings(db);
    const signupBonus = Math.max(0, asInt(S(settings, 'signupBonusTickets', 0), 0));
    const code = cleanStr(p.referralCode, 20).toUpperCase();
    let referredBy = '';
    let referrerUid = '';
    if (code) {
      const q = await db.ref('users').orderByChild('referralCode').equalTo(code).limitToFirst(1).get();
      if (q.exists()) { q.forEach((c) => { referrerUid = c.key; }); referredBy = code; }
    }
    const mine = await uniqueReferralCode(db);
    const doc = {
      name: cleanStr(p.name || decoded.name, 60) || 'Player',
      email, photoURL: cleanStr(p.photoURL || decoded.picture, 500) || '',
      tickets: signupBonus, bonusTickets: 0, totalEarnings: 0,
      points: 0, leaderboardRank: 0, matchesPlayed: 0, matchesWon: 0,
      referralCode: mine, referredBy, blocked: false,
      createdAt: now(), updatedAt: now(), lastLoginAt: now(),
    };
    await ref.set(doc);
    await recordTxn(db, uid, { amount: 0, type: 'account', reason: 'Account created', refId: '', balanceAfter: signupBonus });
    if (signupBonus > 0) await recordTxn(db, uid, { amount: signupBonus, type: 'bonus', reason: 'Signup bonus', refId: 'signup', balanceAfter: signupBonus });
    if (referrerUid) {
      await db.ref('pendingReferrals').push({ newUid: uid, newEmail: email, newName: doc.name, code, referrerUid, status: 'pending', createdAt: now() });
    }
    await notifyUser(db, uid, { title: 'Welcome to the Arena! 🎮', message: 'Your account is ready. Join tournaments, watch ads and climb the leaderboard!' });
    return { user: (await ref.get()).val(), created: true, referralApplied: !!referrerUid };
  }
  const patch = { lastLoginAt: now(), updatedAt: now() };
  if (p.name) patch.name = cleanStr(p.name, 60);
  if (p.photoURL) patch.photoURL = cleanStr(p.photoURL, 500);
  await ref.update(patch);
  return { user: (await ref.get()).val(), created: false };
}

async function h_updateProfile(db, decoded, p) {
  const uid = decoded.uid;
  await requireActiveUser(db, uid);
  const name = cleanStr(p.name, 60);
  need(name.length >= 2, 'Name must be at least 2 characters.');
  await db.ref('users/' + uid).update({ name, updatedAt: now() });
  return { name };
}

async function h_joinTournament(db, decoded, p) {
  const uid = decoded.uid;
  const me = await requireActiveUser(db, uid);
  const tid = cleanId(p.tournamentId);
  need(tid, 'tournamentId required.');
  if (p.idempotencyKey && !(await idemFresh(db, uid + ':' + p.idempotencyKey, 120000))) {
    return { joined: true, deduped: true };
  }
  const tSnap = await db.ref('tournaments/' + tid).get();
  need(tSnap.exists(), 'Tournament not found.');
  const t = tSnap.val();
  need(t.status !== 'completed' && t.status !== 'cancelled', 'This tournament is closed.');
  const maxPlayers = asInt(t.maxPlayers, 0);
  const filled = asInt(t.spotsFilled, 0);
  if (maxPlayers > 0 && filled >= maxPlayers) {
    const e = new Error('Tournament is full.');
    e.status = 400; e.code = 'TOURNAMENT_FULL';
    throw e;
  }
  const existing = await db.ref(`tournaments/${tid}/registeredPlayers/${uid}`).get();
  if (existing.exists()) {
    const e = new Error('You have already joined this tournament.');
    e.status = 400; e.code = 'ALREADY_JOINED';
    throw e;
  }
  const mode = cleanStr(p.mode, 10) === 'duo' ? 'duo' : (cleanStr(t.mode, 10) === 'duo' ? 'duo' : 'solo');
  const username = cleanStr(p.username, 40) || me.name || 'Player';
  const gameUid = cleanStr(p.gameUid, 40);
  need(gameUid, 'Your in-game UID is required to join.');
  if (mode === 'duo') {
    need(cleanStr(p.teammateName, 40), 'Teammate name is required for DUO.');
    need(cleanStr(p.teammateGameUid, 40), 'Teammate game UID is required for DUO.');
  }
  const fee = Math.max(0, asInt(t.entryFee, 0));
  const split = await debitEntryFee(db, uid, fee);
  await db.ref(`tournaments/${tid}/registeredPlayers/${uid}`).set({
    name: username, gameUid, mode,
    teammateName: mode === 'duo' ? cleanStr(p.teammateName, 40) : '',
    teammateGameUid: mode === 'duo' ? cleanStr(p.teammateGameUid, 40) : '',
    feePaid: fee, fromBonus: split.fromBonus || 0, fromTickets: split.fromTickets || 0,
    joinedAt: now(),
  });
  await db.ref('tournaments/' + tid + '/spotsFilled').transaction((c) => (typeof c === 'number' ? c : 0) + 1);
  await db.ref('tournaments/' + tid).update({ updatedAt: now() });
  await db.ref('users/' + uid + '/matchesPlayed').transaction((c) => (typeof c === 'number' ? c : 0) + 1);
  await recordTxn(db, uid, { amount: -fee, type: 'join', reason: `Joined: ${t.name || tid}`, refId: tid, balanceAfter: split.balanceAfter });
  await notifyUser(db, uid, { title: 'Contest joined! ⚔️', message: `You joined ${t.name || 'the tournament'}. Room ID/password will unlock here before the match.` });
  return { joined: true, tournamentId: tid, fee, ...split };
}

async function h_claimAdReward(db, decoded) {
  const uid = decoded.uid;
  const me = await requireActiveUser(db, uid);
  const settings = await getSettings(db);
  const reward = Math.max(1, asInt(S(settings, 'adRewardTickets', 5), 5));
  const cooldownSec = Math.max(10, asInt(S(settings, 'adCooldownSec', 60), 60));
  const dailyLimit = Math.max(1, asInt(S(settings, 'adDailyLimit', 20), 20));
  const lastAt = asInt(me.lastAdRewardAt, 0);
  const waitLeft = cooldownSec - Math.floor((now() - lastAt) / 1000);
  if (lastAt > 0 && waitLeft > 0) {
    const e = new Error(`Next reward in ${waitLeft}s. Please wait for the cooldown.`);
    e.status = 429; e.code = 'AD_COOLDOWN'; e.retryAfterSec = waitLeft;
    throw e;
  }
  const d = new Date();
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daySnap = await db.ref(`users/${uid}/adRewards/${dateKey}`).get();
  const used = daySnap.exists() ? daySnap.numChildren() : 0;
  if (used >= dailyLimit) {
    const e = new Error(`Daily limit reached (${dailyLimit}/${dailyLimit}). Come back tomorrow!`);
    e.status = 429; e.code = 'AD_DAILY_LIMIT';
    throw e;
  }
  await db.ref(`users/${uid}/adRewards/${dateKey}`).push({ tickets: reward, ts: now() });
  await db.ref('users/' + uid).update({ lastAdRewardAt: now() });
  const balanceAfter = await moveTickets(db, uid, reward, { reason: 'Watch-ad reward', refId: 'ad', type: 'ad', earnable: true });
  return { reward, balanceAfter, usedToday: used + 1, dailyLimit, cooldownSec };
}

async function h_createWithdrawal(db, decoded, p) {
  const uid = decoded.uid;
  const me = await requireActiveUser(db, uid);
  const settings = await getSettings(db);
  const minW = Math.max(1, asInt(S(settings, 'minWithdrawTickets', 100), 100));
  const amount = asInt(p.amount, NaN);
  need(Number.isInteger(amount) && amount > 0, 'Enter a valid ticket amount.');
  need(amount >= minW, `Minimum withdrawal is ${minW} tickets.`);
  const method = cleanStr(p.method, 20).toLowerCase();
  need(['upi', 'bank', 'paytm', 'phonepe'].includes(method), 'Choose a valid payout method.');
  const account = cleanStr(p.account, 120);
  need(account.length >= 4, 'Enter your payout account / UPI ID.');
  const pendQ = await db.ref('withdrawals').orderByChild('uid').equalTo(uid).limitToLast(30).get();
  let pendingCount = 0;
  if (pendQ.exists()) pendQ.forEach((c) => { if ((c.val() || {}).status === 'pending') pendingCount++; });
  need(pendingCount < 3, 'You already have 3 pending requests. Wait for admin approval.');
  const balanceAfter = await moveTickets(db, uid, -amount, { reason: `Withdrawal request (${method})`, refId: 'wd', type: 'withdraw' });
  const ref = await db.ref('withdrawals').push({
    uid, name: me.name || '', email: me.email || '', amount, method, account,
    status: 'pending', note: '', createdAt: now(), processedAt: 0, processedBy: '',
  });
  await notifyUser(db, uid, { title: 'Withdrawal requested 💸', message: `${amount} tickets locked. Admin will approve and pay to ${account} soon.` });
  return { id: ref.key, amount, balanceAfter };
}

async function h_createDeposit(db, decoded, p) {
  const uid = decoded.uid;
  const me = await requireActiveUser(db, uid);
  const amount = asInt(p.amount, NaN);
  need(Number.isInteger(amount) && amount > 0 && amount <= 100000, 'Enter a valid amount.');
  const utr = cleanStr(p.utr, 40);
  need(utr.length >= 6, 'Enter the 12-digit UTR / transaction number from your payment app.');
  const ref = await db.ref('deposits').push({
    uid, name: me.name || '', email: me.email || '', amount, utr,
    status: 'pending', note: '', createdAt: now(), processedAt: 0, processedBy: '',
  });
  await notifyUser(db, uid, { title: 'Recharge submitted 🧾', message: `₹${amount} (UTR ${utr}) received. Tickets will credit after admin verification.` });
  return { id: ref.key, amount };
}

async function h_markNotificationsRead(db, decoded, p) {
  const uid = decoded.uid;
  const base = db.ref(`users/${uid}/notifications`);
  if (p.all === true || !p.ids) {
    const snap = await base.limitToLast(50).get();
    const updates = {};
    if (snap.exists()) snap.forEach((c) => { updates[c.key + '/read'] = true; });
    if (Object.keys(updates).length) await base.update(updates);
    return { readAll: true, count: Object.keys(updates).length };
  }
  const ids = (Array.isArray(p.ids) ? p.ids : [p.ids]).map((x) => cleanId(x)).filter(Boolean).slice(0, 50);
  const updates = {};
  ids.forEach((id) => { updates[id + '/read'] = true; });
  if (Object.keys(updates).length) await base.update(updates);
  return { read: ids.length };
}

// ══════════════ ADMIN HANDLERS ══════════════

async function h_setupAdmin(db, decoded) {
  const ref = db.ref('adminConfig/adminUid');
  const snap = await ref.get();
  if (snap.exists() && snap.val()) {
    const e = new Error('Admin is already set up.');
    e.status = 400; e.code = 'ALREADY_SETUP';
    throw e;
  }
  await ref.set(decoded.uid);
  await audit(db, decoded.uid, 'setupAdmin', 'First admin claimed');
  return { adminUid: decoded.uid };
}

async function h_upsertGame(db, p, by) {
  const id = cleanId(p.id) || db.ref('games').push().key;
  need(cleanStr(p.name, 80), 'Game name required.');
  const data = {
    name: cleanStr(p.name, 80), imageUrl: cleanStr(p.imageUrl, 800),
    active: p.active === false ? false : true, order: asInt(p.order, 0), updatedAt: now(),
  };
  const ref = db.ref('games/' + id);
  if (!(await ref.get()).exists()) await ref.set({ ...data, createdAt: now() });
  else await ref.update(data);
  await audit(db, by, 'upsertGame', id);
  return { id, game: (await ref.get()).val() };
}

async function h_upsertPromotion(db, p, by) {
  const id = cleanId(p.id) || db.ref('promotions').push().key;
  need(cleanStr(p.imageUrl, 800), 'Promotion image URL required.');
  const data = {
    title: cleanStr(p.title, 120), imageUrl: cleanStr(p.imageUrl, 800), link: cleanStr(p.link, 800),
    active: p.active === false ? false : true, order: asInt(p.order, 0), updatedAt: now(),
  };
  const ref = db.ref('promotions/' + id);
  if (!(await ref.get()).exists()) await ref.set({ ...data, createdAt: now() });
  else await ref.update(data);
  await audit(db, by, 'upsertPromotion', id);
  return { id, promotion: (await ref.get()).val() };
}

async function h_upsertTournament(db, p, by) {
  const id = cleanId(p.id) || db.ref('tournaments').push().key;
  need(cleanStr(p.name, 120), 'Tournament name required.');
  const status = cleanStr(p.status, 20);
  need(['upcoming', 'ongoing', 'completed', 'cancelled'].includes(status), 'Invalid status.');
  const data = {
    name: cleanStr(p.name, 120), gameId: cleanId(p.gameId),
    entryFee: Math.max(0, asInt(p.entryFee, 0)), prizePool: Math.max(0, asInt(p.prizePool, 0)),
    maxPlayers: Math.max(0, asInt(p.maxPlayers, 100)),
    mode: cleanStr(p.mode, 10) === 'duo' ? 'duo' : 'solo',
    status, matchDate: asInt(p.matchDate, 0) || now(),
    description: cleanStr(p.description, 3000), prizeDistribution: cleanStr(p.prizeDistribution, 2000),
    perKillPrize: Math.max(0, asInt(p.perKillPrize, 0)),
    bannerUrl: cleanStr(p.bannerUrl || p.imageUrl, 800),
    map: cleanStr(p.map, 60), perspective: cleanStr(p.perspective, 20),
    updatedAt: now(),
  };
  const ref = db.ref('tournaments/' + id);
  const snap = await ref.get();
  if (!snap.exists()) await ref.set({ ...data, spotsFilled: 0, roomId: '', roomPassword: '', showIdPass: false, createdAt: now() });
  else {
    delete data.spotsFilled;
    await ref.update(data);
  }
  await audit(db, by, 'upsertTournament', id + ' [' + status + ']');
  return { id, tournament: (await ref.get()).val() };
}

async function h_setRoom(db, p, by) {
  const id = cleanId(p.tournamentId);
  need(id, 'tournamentId required.');
  need((await db.ref('tournaments/' + id).get()).exists(), 'Tournament not found.');
  await db.ref('tournaments/' + id).update({
    roomId: cleanStr(p.roomId, 60), roomPassword: cleanStr(p.roomPassword, 60),
    showIdPass: p.showIdPass !== false, updatedAt: now(),
  });
  await db.ref('notifications').push({ title: 'Room ID/Password is LIVE 🔑', message: `Open your joined contest to view room details.`, tournamentId: id, createdAt: now() });
  await audit(db, by, 'setRoom', id);
  return { id };
}

async function h_declareWinners(db, p, by) {
  const id = cleanId(p.tournamentId);
  need(id, 'tournamentId required.');
  const tSnap = await db.ref('tournaments/' + id).get();
  need(tSnap.exists(), 'Tournament not found.');
  const t = tSnap.val();
  const winners = Array.isArray(p.winners) ? p.winners.slice(0, 50) : [];
  need(winners.length > 0, 'Add at least one winner.');
  const credited = [];
  let rank = 0;
  for (const w of winners) {
    rank++;
    const uid = cleanStr(w.uid, 128);
    const prize = Math.max(0, asInt(w.prize, 0));
    if (!uid || prize <= 0) continue;
    try {
      const bal = await moveTickets(db, uid, prize, { reason: `Won: ${t.name || id} (#${rank})`, refId: id, type: 'winnings', earnable: true });
      if (rank === 1) { try { await db.ref('users/' + uid + '/matchesWon').transaction((c) => (typeof c === 'number' ? c : 0) + 1); } catch {} }
      await notifyUser(db, uid, { title: `You won ${prize} tickets! 🏆`, message: `Rank #${rank} in ${t.name || 'tournament'}. Prize credited to your wallet.` });
      credited.push({ uid, name: cleanStr(w.name, 60), rank, prize, balanceAfter: bal });
    } catch (e) { credited.push({ uid, rank, prize, error: e.message }); }
  }
  await db.ref('tournaments/' + id).update({ status: 'completed', winners: credited, resultNote: cleanStr(p.note, 500), updatedAt: now() });
  await db.ref('notifications').push({ title: 'Results declared 🏁', message: `${t.name || 'Tournament'} — congratulations to all winners!`, tournamentId: id, createdAt: now() });
  await audit(db, by, 'declareWinners', id + ' paid=' + credited.filter((c) => !c.error).length);
  return { tournamentId: id, credited };
}

async function h_adjustBalance(db, p, by) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required.');
  need((await db.ref('users/' + uid).get()).exists(), 'User not found.');
  const tDelta = asInt(p.tickets, 0);
  const bDelta = asInt(p.bonusTickets, 0);
  need(tDelta !== 0 || bDelta !== 0, 'Enter a non-zero ticket change.');
  const reason = cleanStr(p.reason, 200) || 'Admin adjustment';
  const out = {};
  if (tDelta !== 0) out.ticketsAfter = await moveTickets(db, uid, tDelta, { reason, refId: 'admin', type: 'admin', earnable: tDelta > 0 && p.earnable !== false });
  if (bDelta !== 0) {
    const ref = db.ref('users/' + uid);
    const tx = await ref.transaction((u) => {
      if (!u) return u;
      u = { ...u };
      const b = typeof u.bonusTickets === 'number' ? u.bonusTickets : 0;
      if (b + bDelta < 0) return;
      u.bonusTickets = b + bDelta;
      u.updatedAt = now();
      return u;
    });
    if (!tx.committed) { const e = new Error('Bonus would go negative.'); e.status = 400; e.code = 'INVALID_ARGUMENT'; throw e; }
    out.bonusAfter = tx.snapshot.val().bonusTickets;
    await recordTxn(db, uid, { amount: bDelta, type: 'admin-bonus', reason: reason + ' (bonus)', refId: 'admin', balanceAfter: tx.snapshot.val().tickets || 0 });
  }
  await notifyUser(db, uid, { title: 'Wallet updated 💰', message: `${reason}: ${tDelta !== 0 ? (tDelta > 0 ? '+' : '') + tDelta + ' tickets ' : ''}${bDelta !== 0 ? (bDelta > 0 ? '+' : '') + bDelta + ' bonus' : ''}` });
  await audit(db, by, 'adjustBalance', `${uid} t=${tDelta} b=${bDelta} :: ${reason}`);
  return { uid, ...out };
}

async function h_toggleBlock(db, p, by) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required.');
  const blocked = !(p.blocked === false || p.blocked === 'false');
  await db.ref('users/' + uid).update({ blocked, updatedAt: now() });
  await audit(db, by, blocked ? 'blockUser' : 'unblockUser', uid);
  return { uid, blocked };
}

async function h_createUser(db, p, by) {
  const email = cleanStr(p.email, 120);
  const password = String(p.password || '');
  need(email && email.includes('@'), 'Valid email required.');
  need(password.length >= 6, 'Password must be 6+ characters.');
  const name = cleanStr(p.name, 60) || 'Player';
  const auth = getAdmin().auth();
  const rec = await auth.createUser({ email, password, displayName: name });
  const code = await uniqueReferralCode(db);
  const initial = Math.max(0, asInt(p.initialTickets, 0));
  await db.ref('users/' + rec.uid).set({
    name, email, photoURL: '', tickets: initial, bonusTickets: 0, totalEarnings: 0,
    points: 0, leaderboardRank: 0, matchesPlayed: 0, matchesWon: 0,
    referralCode: code, referredBy: '', blocked: false,
    createdAt: now(), updatedAt: now(), lastLoginAt: 0,
  });
  await audit(db, by, 'createUser', rec.uid);
  return { uid: rec.uid, referralCode: code };
}

async function h_deleteUserData(db, p, by) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required.');
  await db.ref('users/' + uid).remove();
  await db.ref('transactions/' + uid).remove();
  try { await getAdmin().auth().deleteUser(uid); } catch {}
  await audit(db, by, 'deleteUser', uid);
  return { deleted: uid };
}

async function h_decideWithdrawal(db, p, by, approve) {
  const id = cleanId(p.id);
  need(id, 'id required.');
  const ref = db.ref('withdrawals/' + id);
  const snap = await ref.get();
  need(snap.exists(), 'Request not found.');
  const w = snap.val();
  need(w.status === 'pending', 'Request already processed.');
  if (approve) {
    await ref.update({ status: 'completed', note: cleanStr(p.note, 300), processedAt: now(), processedBy: by });
    await recordTxn(db, w.uid, { amount: 0, type: 'withdraw-done', reason: `Withdrawal paid (${w.method})`, refId: id, balanceAfter: asInt((await db.ref('users/' + w.uid + '/tickets').get()).val(), 0) });
    await notifyUser(db, w.uid, { title: 'Withdrawal paid ✅', message: `${w.amount} tickets paid to ${w.account}. Thank you for playing!` });
  } else {
    await ref.update({ status: 'rejected', note: cleanStr(p.note, 300) || 'Rejected by admin', processedAt: now(), processedBy: by });
    await moveTickets(db, w.uid, asInt(w.amount, 0), { reason: 'Withdrawal rejected — refunded', refId: id, type: 'refund', earnable: false });
    await notifyUser(db, w.uid, { title: 'Withdrawal rejected ❌', message: `${w.amount} tickets refunded to your wallet. Reason: ${cleanStr(p.note, 300) || '—'}` });
  }
  await audit(db, by, approve ? 'approveWithdrawal' : 'rejectWithdrawal', id);
  return { id, status: approve ? 'completed' : 'rejected' };
}

async function h_decideDeposit(db, p, by, approve) {
  const id = cleanId(p.id);
  need(id, 'id required.');
  const ref = db.ref('deposits/' + id);
  const snap = await ref.get();
  need(snap.exists(), 'Request not found.');
  const d = snap.val();
  need(d.status === 'pending', 'Request already processed.');
  if (approve) {
    await ref.update({ status: 'completed', note: cleanStr(p.note, 300), processedAt: now(), processedBy: by });
    const bal = await moveTickets(db, d.uid, asInt(d.amount, 0), { reason: `Recharge verified (UTR ${d.utr || ''})`, refId: id, type: 'recharge', earnable: false });
    await notifyUser(db, d.uid, { title: 'Recharge credited ✅', message: `${d.amount} tickets added to your wallet. Enjoy!` });
    await audit(db, by, 'approveDeposit', id);
    return { id, status: 'completed', balanceAfter: bal };
  }
  await ref.update({ status: 'rejected', note: cleanStr(p.note, 300) || 'Invalid payment proof', processedAt: now(), processedBy: by });
  await notifyUser(db, d.uid, { title: 'Recharge rejected ❌', message: `Payment could not be verified. Contact support with UTR ${d.utr || ''}.` });
  await audit(db, by, 'rejectDeposit', id);
  return { id, status: 'rejected' };
}

async function h_decideReferral(db, p, by, approve) {
  const id = cleanId(p.id);
  need(id, 'id required.');
  const ref = db.ref('pendingReferrals/' + id);
  const snap = await ref.get();
  need(snap.exists(), 'Request not found.');
  const r = snap.val();
  need(r.status === 'pending', 'Request already processed.');
  if (!approve) {
    await ref.update({ status: 'rejected', processedAt: now(), processedBy: by });
    await audit(db, by, 'rejectReferral', id);
    return { id, status: 'rejected' };
  }
  const settings = await getSettings(db);
  const refBonus = Math.max(0, asInt(S(settings, 'referralBonus', 20), 20));
  const joinBonus = Math.max(0, asInt(S(settings, 'joinBonusTickets', 10), 10));
  if (refBonus > 0 && r.referrerUid) {
    await moveTickets(db, r.referrerUid, refBonus, { reason: `Referral bonus (${r.newName || 'friend'} joined)`, refId: id, type: 'referral', earnable: true });
    await notifyUser(db, r.referrerUid, { title: 'Referral bonus! 🎁', message: `+${refBonus} tickets — your friend joined the arena.` });
  }
  if (joinBonus > 0 && r.newUid) {
    await moveTickets(db, r.newUid, joinBonus, { reason: 'Welcome bonus (referral)', refId: id, type: 'bonus', earnable: true });
    await notifyUser(db, r.newUid, { title: 'Welcome bonus! 🎁', message: `+${joinBonus} tickets for joining with a referral code.` });
  }
  await ref.update({ status: 'completed', refBonus, joinBonus, processedAt: now(), processedBy: by });
  await audit(db, by, 'approveReferral', id);
  return { id, status: 'completed', refBonus, joinBonus };
}

async function h_updateSettings(db, p, by) {
  const allow = ['appName', 'logoUrl', 'tagline', 'adRewardTickets', 'adCooldownSec', 'adDailyLimit', 'adLink',
    'minWithdrawTickets', 'referralBonus', 'joinBonusTickets', 'signupBonusTickets',
    'upiId', 'upiName', 'upiQrUrl', 'supportUrl', 'supportEmail', 'announcement',
    'maintenanceMode', 'theme', 'accentColor', 'policies'];
  const patch = { updatedAt: now() };
  for (const k of allow) {
    if (p[k] === undefined) continue;
    if (['adRewardTickets', 'adCooldownSec', 'adDailyLimit', 'minWithdrawTickets', 'referralBonus', 'joinBonusTickets', 'signupBonusTickets'].includes(k)) {
      patch[k] = Math.max(0, asInt(p[k], 0));
    } else if (k === 'maintenanceMode') {
      patch[k] = p[k] === true || p[k] === 'true';
    } else if (k === 'policies' && typeof p[k] === 'object') {
      patch[k] = {
        about: cleanStr(p[k].about, 5000), privacy: cleanStr(p[k].privacy, 8000),
        terms: cleanStr(p[k].terms, 8000), refund: cleanStr(p[k].refund, 5000),
      };
    } else {
      patch[k] = cleanStr(p[k], 1000);
    }
  }
  await db.ref('settings').update(patch);
  _settingsCacheSafe();
  await audit(db, by, 'updateSettings', Object.keys(patch).join(','));
  return { updated: Object.keys(patch) };
}
function _settingsCacheSafe() { _settingsCache = { at: 0, data: null }; }

async function h_recomputeLeaderboard(db, by) {
  const snap = await db.ref('users').limitToLast(1000).get();
  const arr = [];
  if (snap.exists()) snap.forEach((c) => {
    const u = c.val() || {};
    if (u.blocked === true) return;
    const score = (asInt(u.totalEarnings, 0)) + (asInt(u.matchesWon, 0) * 100) + (asInt(u.matchesPlayed, 0) * 5);
    arr.push({ uid: c.key, score });
  });
  arr.sort((a, b) => b.score - a.score);
  const updates = {};
  arr.slice(0, 500).forEach((r, i) => {
    updates[`${r.uid}/leaderboardRank`] = i + 1;
    updates[`${r.uid}/points`] = r.score;
  });
  if (Object.keys(updates).length) await db.ref('users').update(updates);
  await audit(db, by, 'recomputeLeaderboard', 'ranked=' + Math.min(arr.length, 500));
  return { ranked: Math.min(arr.length, 500), total: arr.length };
}

async function h_listUsers(db, p) {
  const limit = Math.min(300, Math.max(1, asInt(p.limit, 100)));
  const q = cleanStr(p.search, 80).toLowerCase();
  const snap = await db.ref('users').limitToLast(500).get();
  let users = [];
  if (snap.exists()) snap.forEach((c) => users.push({ uid: c.key, ...(c.val() || {}) }));
  users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (q) users = users.filter((u) => ((u.name || '') + ' ' + (u.email || '') + ' ' + u.uid + ' ' + (u.referralCode || '')).toLowerCase().includes(q));
  return { users: users.slice(0, limit), total: users.length };
}

async function h_getUserDetail(db, p) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required.');
  const u = (await db.ref('users/' + uid).get()).val();
  need(u, 'User not found.');
  const txSnap = await db.ref('transactions/' + uid).limitToLast(20).get();
  const txns = [];
  if (txSnap.exists()) txSnap.forEach((c) => txns.push({ id: c.key, ...c.val() }));
  txns.reverse();
  const wdSnap = await db.ref('withdrawals').orderByChild('uid').equalTo(uid).limitToLast(10).get();
  const withdrawals = [];
  if (wdSnap.exists()) wdSnap.forEach((c) => withdrawals.push({ id: c.key, ...c.val() }));
  return { user: { uid, ...u }, txns, withdrawals: withdrawals.reverse() };
}

async function h_recentTransactions(db, p) {
  const limit = Math.min(100, Math.max(1, asInt(p.limit, 40)));
  const uSnap = await db.ref('users').limitToLast(200).get();
  const all = [];
  const jobs = [];
  if (uSnap.exists()) uSnap.forEach((c) => {
    const uid = c.key;
    const name = (c.val() || {}).name || '';
    jobs.push(db.ref('transactions/' + uid).limitToLast(5).get().then((s) => {
      if (s.exists()) s.forEach((t) => all.push({ uid, name, id: t.key, ...(t.val() || {}) }));
    }));
  });
  await Promise.all(jobs);
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { txns: all.slice(0, limit) };
}

async function h_analyticsSnapshot(db) {
  const [uSnap, tSnap, wSnap, dSnap, rSnap] = await Promise.all([
    db.ref('users').get(), db.ref('tournaments').get(),
    db.ref('withdrawals').orderByChild('status').equalTo('pending').get(),
    db.ref('deposits').orderByChild('status').equalTo('pending').get(),
    db.ref('pendingReferrals').orderByChild('status').equalTo('pending').get(),
  ]);
  let totalUsers = 0, blocked = 0, new7d = 0, ticketsInWallets = 0;
  const weekAgo = now() - 7 * 86400000;
  const perDay = {};
  if (uSnap.exists()) uSnap.forEach((c) => {
    const u = c.val() || {};
    totalUsers++;
    if (u.blocked === true) blocked++;
    if ((u.createdAt || 0) > weekAgo) new7d++;
    ticketsInWallets += asInt(u.tickets, 0) + asInt(u.bonusTickets, 0);
    const day = new Date(u.createdAt || 0).toISOString().slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  });
  let tournaments = 0, live = 0, upcoming = 0, registrations = 0;
  if (tSnap.exists()) tSnap.forEach((c) => {
    const t = c.val() || {};
    tournaments++;
    if (t.status === 'ongoing') live++;
    if (t.status === 'upcoming') upcoming++;
    registrations += asInt(t.spotsFilled, 0);
  });
  let pendW = 0, pendWSum = 0;
  if (wSnap.exists()) wSnap.forEach((c) => { pendW++; pendWSum += asInt((c.val() || {}).amount, 0); });
  return {
    totalUsers, blocked, new7d, ticketsInWallets,
    tournaments, live, upcoming, registrations,
    pendingWithdrawals: pendW, pendingWithdrawalsSum: pendWSum,
    pendingDeposits: dSnap.exists() ? dSnap.numChildren() : 0,
    pendingReferrals: rSnap.exists() ? rSnap.numChildren() : 0,
    signupsPerDay: perDay,
  };
}

async function h_seedDemoData(db, by) {
  const out = {};
  const settings = await getSettings(db);
  if (!settings.appName) {
    await db.ref('settings').update({
      appName: 'Arena X', tagline: 'Play. Win. Repeat.',
      adRewardTickets: 5, adCooldownSec: 60, adDailyLimit: 20, adLink: '',
      minWithdrawTickets: 100, referralBonus: 20, joinBonusTickets: 10, signupBonusTickets: 5,
      upiId: '', upiName: '', upiQrUrl: '', supportUrl: '', supportEmail: '',
      announcement: 'Welcome to Arena X! Daily tournaments are live. 🎮',
      maintenanceMode: false, theme: 'midnight', updatedAt: now(),
      policies: { about: 'Arena X — play esports tournaments and win tickets.', privacy: 'We store your name, email and game activity to run tournaments.', terms: 'Fair play only. Cheating leads to a ban.', refund: 'Entry fees are non-refundable once a match starts.' },
    });
    out.settings = 'created';
  } else out.settings = 'exists';
  const hasGames = (await db.ref('games').limitToFirst(1).get()).exists();
  if (!hasGames) {
    const demo = [
      { name: 'Battle Royale', imageUrl: '', order: 1 },
      { name: 'Squad Clash', imageUrl: '', order: 2 },
      { name: 'Sniper Arena', imageUrl: '', order: 3 },
    ];
    for (const g of demo) await db.ref('games').push({ ...g, active: true, createdAt: now(), updatedAt: now() });
    out.games = demo.length;
  } else out.games = 'exists';
  const hasPromo = (await db.ref('promotions').limitToFirst(1).get()).exists();
  if (!hasPromo) {
    await db.ref('promotions').push({ title: 'Mega Weekend Cup', imageUrl: '', link: '', active: true, order: 1, createdAt: now(), updatedAt: now() });
    out.promotions = 1;
  } else out.promotions = 'exists';
  await audit(db, by, 'seedDemoData', JSON.stringify(out));
  return out;
}

// ══════════════ ROUTER ══════════════
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST');
  try {
    checkAppCheck(req);
    const body = await parseBody(req);
    const action = cleanStr(body.action, 40);
    if (!action) return fail(res, 400, 'INVALID_ARGUMENT', 'action required');
    if (!PLAYER_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) {
      return fail(res, 400, 'UNKNOWN_ACTION', 'Unknown action: ' + action);
    }
    const decoded = await requireAuth(req);
    if (!rateLimit('uid:' + decoded.uid, 90)) return fail(res, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    const db = getDb();
    const p = body || {};

    if (action === 'syncUser') return ok(res, await h_syncUser(db, decoded, p));
    if (action === 'updateProfile') return ok(res, await h_updateProfile(db, decoded, p));
    if (action === 'joinTournament') return ok(res, await h_joinTournament(db, decoded, p));
    if (action === 'claimAdReward') return ok(res, await h_claimAdReward(db, decoded));
    if (action === 'createWithdrawal') return ok(res, await h_createWithdrawal(db, decoded, p));
    if (action === 'createDeposit') return ok(res, await h_createDeposit(db, decoded, p));
    if (action === 'markNotificationsRead') return ok(res, await h_markNotificationsRead(db, decoded, p));
    if (action === 'getLeaderboard') return ok(res, await h_getLeaderboard(db, decoded));

    if (action === 'setupAdmin') {
      // setup allowed for any authed user ONLY if no admin exists yet (first-setup).
      const snap = await db.ref('adminConfig/adminUid').get();
      if (snap.exists() && snap.val()) await requireAdmin(decoded);
      return ok(res, await h_setupAdmin(db, decoded));
    }
    await requireAdmin(decoded);
    const by = decoded.uid;
    if (action === 'adminPing') return ok(res, { admin: true, uid: by });
    if (action === 'upsertGame') return ok(res, await h_upsertGame(db, p, by));
    if (action === 'deleteGame') { need(cleanId(p.id), 'id required'); await db.ref('games/' + cleanId(p.id)).remove(); await audit(db, by, 'deleteGame', p.id); return ok(res, { deleted: p.id }); }
    if (action === 'upsertPromotion') return ok(res, await h_upsertPromotion(db, p, by));
    if (action === 'deletePromotion') { need(cleanId(p.id), 'id required'); await db.ref('promotions/' + cleanId(p.id)).remove(); await audit(db, by, 'deletePromotion', p.id); return ok(res, { deleted: p.id }); }
    if (action === 'upsertTournament') return ok(res, await h_upsertTournament(db, p, by));
    if (action === 'deleteTournament') { need(cleanId(p.id), 'id required'); await db.ref('tournaments/' + cleanId(p.id)).remove(); await audit(db, by, 'deleteTournament', p.id); return ok(res, { deleted: p.id }); }
    if (action === 'setRoom') return ok(res, await h_setRoom(db, p, by));
    if (action === 'declareWinners') return ok(res, await h_declareWinners(db, p, by));
    if (action === 'adjustBalance') return ok(res, await h_adjustBalance(db, p, by));
    if (action === 'toggleBlock') return ok(res, await h_toggleBlock(db, p, by));
    if (action === 'createUser') return ok(res, await h_createUser(db, p, by));
    if (action === 'deleteUserData') return ok(res, await h_deleteUserData(db, p, by));
    if (action === 'approveWithdrawal') return ok(res, await h_decideWithdrawal(db, p, by, true));
    if (action === 'rejectWithdrawal') return ok(res, await h_decideWithdrawal(db, p, by, false));
    if (action === 'approveDeposit') return ok(res, await h_decideDeposit(db, p, by, true));
    if (action === 'rejectDeposit') return ok(res, await h_decideDeposit(db, p, by, false));
    if (action === 'approveReferral') return ok(res, await h_decideReferral(db, p, by, true));
    if (action === 'rejectReferral') return ok(res, await h_decideReferral(db, p, by, false));
    if (action === 'sendGlobalNotification') {
      need(cleanStr(p.message, 1000), 'message required');
      const ref = await db.ref('notifications').push({ title: cleanStr(p.title, 140) || 'Arena', message: cleanStr(p.message, 1000), imageUrl: cleanStr(p.imageUrl, 800) || '', createdAt: now() });
      await audit(db, by, 'sendGlobalNotification', ref.key);
      return ok(res, { id: ref.key });
    }
    if (action === 'sendUserNotification') {
      need(cleanStr(p.uid, 128), 'uid required');
      need(cleanStr(p.message, 1000), 'message required');
      await notifyUser(db, cleanStr(p.uid, 128), { title: p.title, message: p.message, imageUrl: p.imageUrl });
      await audit(db, by, 'sendUserNotification', p.uid);
      return ok(res, { sent: true });
    }
    if (action === 'deleteChatMessage') {
      need(cleanId(p.tournamentId) && cleanId(p.messageId), 'tournamentId + messageId required');
      await db.ref(`chats/${cleanId(p.tournamentId)}/${cleanId(p.messageId)}`).remove();
      await audit(db, by, 'deleteChatMessage', p.tournamentId + '/' + p.messageId);
      return ok(res, { deleted: true });
    }
    if (action === 'updateSettings') return ok(res, await h_updateSettings(db, p, by));
    if (action === 'recomputeLeaderboard') return ok(res, await h_recomputeLeaderboard(db, by));
    if (action === 'listUsers') return ok(res, await h_listUsers(db, p));
    if (action === 'getUserDetail') return ok(res, await h_getUserDetail(db, p));
    if (action === 'recentTransactions') return ok(res, await h_recentTransactions(db, p));
    if (action === 'analyticsSnapshot') return ok(res, await h_analyticsSnapshot(db));
    if (action === 'seedDemoData') return ok(res, await h_seedDemoData(db, by));
    if (action === 'auditList') {
      const snap = await db.ref('auditLog').limitToLast(Math.min(100, Math.max(1, asInt(p.limit, 40)))).get();
      const items = [];
      if (snap.exists()) snap.forEach((c) => items.push({ id: c.key, ...c.val() }));
      return ok(res, { items: items.reverse() });
    }
    return fail(res, 400, 'UNKNOWN_ACTION', 'Unknown action');
  } catch (e) {
    const status = e.status || 500;
    const code = e.code || 'INTERNAL';
    const extra = e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : undefined;
    return fail(res, status, code, e.message || 'Something went wrong', extra);
  }
};
