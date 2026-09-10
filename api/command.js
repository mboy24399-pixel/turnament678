// POST /api/command — the ONLY trusted writer for coins, entries, tasks, matches, admin data.
// Every request must send: Authorization: Bearer <Firebase ID token>
// Body: { action: string, ...params }
// Admin actions additionally require /admins/{uid} === true (or ADMIN_UIDS bootstrap).
const { getDb, requireAuth, requireAdmin, parseBody, setCors, ok, fail, rateLimit } = require('./_admin');

const PLAYER_ACTIONS = new Set(['syncUser', 'joinTournament', 'claimTask', 'markNotificationRead']);
const ADMIN_ACTIONS = new Set([
  'adminPing', 'upsertTournament', 'deleteTournament',
  'upsertTask', 'deleteTask', 'verifyTask',
  'adjustCoins', 'upsertMatch', 'deleteMatch', 'setResult',
  'announce', 'deleteAnnouncement', 'notify', 'deleteNotification',
  'adConfig', 'setAdmin', 'adminListUsers', 'adminListClaims', 'adminListEntries',
]);

const now = () => Date.now();
const asInt = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };
const cleanStr = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max || 500);
const cleanId = (v) => cleanStr(v, 120).replace(/[^a-zA-Z0-9_-]/g, '');
function need(cond, msg) { if (!cond) { const e = new Error(msg); e.status = 400; e.code = 'INVALID_ARGUMENT'; throw e; } }

function checkAppCheck(req) {
  if (String(process.env.APP_CHECK_ENFORCE || 'false').toLowerCase() !== 'true') return;
  const tok = req.headers['x-firebase-appcheck'] || req.headers['X-Firebase-AppCheck'] || '';
  // NOTE: full cryptographic verification needs reCAPTCHA Enterprise API wiring.
  // In enforce mode we at least require a token to be present (bot deterrent).
  if (!tok || String(tok).length < 20) {
    const e = new Error('Missing App Check token.');
    e.status = 403; e.code = 'APP_CHECK_REQUIRED';
    throw e;
  }
}

// Atomically adjust coins + write ledger. Returns balanceAfter.
async function adjustCoinsTx(db, uid, amount, reason, refId) {
  need(uid, 'uid required');
  need(Number.isInteger(amount) && amount !== 0, 'amount must be a non-zero integer');
  need(Math.abs(amount) <= 1000000, 'amount too large');
  const userRef = db.ref('users/' + uid);
  const snap = await userRef.get();
  if (!snap.exists()) {
    const e = new Error('User record not found. Ask the player to login once (syncUser).');
    e.status = 404; e.code = 'USER_NOT_FOUND';
    throw e;
  }
  const tx = await userRef.child('coins').transaction((cur) => {
    const c = typeof cur === 'number' ? cur : 0;
    const next = c + amount;
    if (next < 0) return; // abort
    return next;
  });
  if (!tx.committed) {
    const e = new Error('Insufficient coin balance.');
    e.status = 400; e.code = 'INSUFFICIENT_COINS';
    throw e;
  }
  const balanceAfter = tx.snapshot.val();
  await userRef.update({ updatedAt: now() });
  await db.ref('walletLedger/' + uid).push({
    type: amount > 0 ? 'credit' : 'debit',
    amount, balanceAfter,
    reason: cleanStr(reason, 200) || 'adjustment',
    refId: cleanStr(refId, 120) || '',
    createdAt: now(),
  });
  return balanceAfter;
}

// ── Player handlers ──────────────────────────────────────────────

async function h_syncUser(db, decoded, p) {
  const uid = decoded.uid;
  const ref = db.ref('users/' + uid);
  const snap = await ref.get();
  const base = {
    name: cleanStr(p.name || decoded.name, 80) || (snap.val() && snap.val().name) || 'Player',
    email: cleanStr(decoded.email, 120) || (snap.val() && snap.val().email) || '',
    photo: cleanStr(p.photo || decoded.picture, 300) || (snap.val() && snap.val().photo) || '',
    updatedAt: now(),
  };
  if (!snap.exists()) {
    await ref.set({ ...base, coins: 0, createdAt: now() });
    await db.ref('walletLedger/' + uid).push({ type: 'info', amount: 0, balanceAfter: 0, reason: 'account created', refId: '', createdAt: now() });
    return { user: { ...base, coins: 0 }, created: true };
  }
  await ref.update(base);
  const fresh = (await ref.get()).val();
  return { user: fresh, created: false };
}

async function h_joinTournament(db, decoded, p) {
  const uid = decoded.uid;
  const tid = cleanId(p.tournamentId);
  need(tid, 'tournamentId required');
  const inGameName = cleanStr(p.inGameName, 60);

  const tSnap = await db.ref('tournaments/' + tid).get();
  need(tSnap.exists(), 'Tournament not found.');
  const t = tSnap.val();
  need(t.status !== 'completed' && t.status !== 'cancelled', 'This tournament is closed.');
  const maxPlayers = asInt(t.maxPlayers, 0);
  const playersCount = asInt(t.playersCount, 0);
  if (maxPlayers > 0 && playersCount >= maxPlayers) {
    const e = new Error('Tournament is full.');
    e.status = 400; e.code = 'TOURNAMENT_FULL';
    throw e;
  }
  const existing = await db.ref(`tournamentPlayers/${tid}/${uid}`).get();
  if (existing.exists()) {
    const e = new Error('You have already joined this tournament.');
    e.status = 400; e.code = 'ALREADY_JOINED';
    throw e;
  }
  const entry = asInt(t.entryCoins, 0);
  if (entry > 0) {
    const uSnap = await db.ref('users/' + uid + '/coins').get();
    const bal = typeof uSnap.val() === 'number' ? uSnap.val() : 0;
    if (bal < entry) {
      const e = new Error(`Not enough coins. Entry is ${entry}, your balance is ${bal}.`);
      e.status = 400; e.code = 'INSUFFICIENT_COINS';
      throw e;
    }
  }
  // Deduct entry (if any) + record entry atomically-ish (deduct first, then join).
  let balanceAfter = null;
  if (entry > 0) {
    balanceAfter = await adjustCoinsTx(db, uid, -entry, `Tournament entry: ${t.title || tid}`, tid);
  }
  await db.ref(`tournamentPlayers/${tid}/${uid}`).set({
    joinedAt: now(), inGameName: inGameName || '',
    email: cleanStr(decoded.email, 120) || '',
  });
  await db.ref('tournaments/' + tid + '/playersCount').transaction((c) => (typeof c === 'number' ? c : 0) + 1);
  await db.ref('tournaments/' + tid).update({ updatedAt: now() });
  if (balanceAfter === null) {
    balanceAfter = (await db.ref('users/' + uid + '/coins').get()).val() || 0;
  }
  return { joined: true, tournamentId: tid, balanceAfter };
}

async function h_claimTask(db, decoded, p) {
  const uid = decoded.uid;
  const taskId = cleanId(p.taskId);
  need(taskId, 'taskId required');
  const tSnap = await db.ref('tasks/' + taskId).get();
  need(tSnap.exists(), 'Task not found.');
  const task = tSnap.val();
  need(task.active !== false, 'This task is not active.');
  const claimRef = db.ref(`taskClaims/${uid}/${taskId}`);
  const existing = await claimRef.get();
  if (existing.exists() && (existing.val().status === 'approved' || existing.val().status === 'pending')) {
    const e = new Error(existing.val().status === 'pending' ? 'Your claim is pending admin verification.' : 'You have already claimed this task.');
    e.status = 400; e.code = 'ALREADY_CLAIMED';
    throw e;
  }
  const reward = asInt(task.rewardCoins, 0);
  need(reward > 0, 'Task has no reward configured.');
  const mode = cleanStr(task.verification, 20) || 'auto';
  if (mode === 'manual') {
    await claimRef.set({ status: 'pending', claimedAt: now(), proof: cleanStr(p.proof, 500) || '', rewardCoins: reward });
    return { status: 'pending', message: 'Claim submitted. Admin will verify it.' };
  }
  await claimRef.set({ status: 'approved', claimedAt: now(), approvedAt: now(), rewardCoins: reward, auto: true });
  const balanceAfter = await adjustCoinsTx(db, uid, reward, `Task reward: ${task.title || taskId}`, taskId);
  return { status: 'approved', balanceAfter, rewardCoins: reward };
}

async function h_markNotificationRead(db, decoded, p) {
  const uid = decoded.uid;
  const id = cleanId(p.id);
  if (!id) { // mark all read
    await db.ref('notifications/' + uid).update({ _lastReadAt: now() });
    return { readAll: true };
  }
  await db.ref(`notifications/${uid}/${id}`).update({ read: true, readAt: now() });
  return { read: id };
}

// ── Admin handlers ───────────────────────────────────────────────

async function h_upsertTournament(db, p) {
  const id = cleanId(p.id) || db.ref('tournaments').push().key;
  const data = {
    title: cleanStr(p.title, 120) || 'Untitled Tournament',
    game: cleanStr(p.game, 60) || 'BGMI',
    description: cleanStr(p.description, 2000),
    rules: cleanStr(p.rules, 3000),
    entryCoins: Math.max(0, asInt(p.entryCoins, 0)),
    prizeCoins: Math.max(0, asInt(p.prizeCoins, 0)),
    maxPlayers: Math.max(0, asInt(p.maxPlayers, 100)),
    status: ['upcoming', 'live', 'completed', 'cancelled'].includes(p.status) ? p.status : 'upcoming',
    startAt: asInt(p.startAt, 0) || now(),
    endAt: asInt(p.endAt, 0) || 0,
    bannerUrl: cleanStr(p.bannerUrl, 500),
    roomId: cleanStr(p.roomId, 100),
    roomPass: cleanStr(p.roomPass, 100),
    updatedAt: now(),
  };
  const ref = db.ref('tournaments/' + id);
  const snap = await ref.get();
  if (!snap.exists()) {
    await ref.set({ ...data, playersCount: 0, createdAt: now() });
  } else {
    await ref.update(data);
  }
  return { id, tournament: (await ref.get()).val() };
}

async function h_deleteTournament(db, p) {
  const id = cleanId(p.id);
  need(id, 'id required');
  await db.ref('tournaments/' + id).remove();
  return { deleted: id };
}

async function h_upsertTask(db, p) {
  const id = cleanId(p.id) || db.ref('tasks').push().key;
  const data = {
    title: cleanStr(p.title, 120) || 'Untitled Task',
    description: cleanStr(p.description, 1500),
    rewardCoins: Math.max(0, asInt(p.rewardCoins, 0)),
    link: cleanStr(p.link, 500),
    active: p.active === false ? false : true,
    verification: p.verification === 'manual' ? 'manual' : 'auto',
    updatedAt: now(),
  };
  const ref = db.ref('tasks/' + id);
  if (!(await ref.get()).exists()) await ref.set({ ...data, createdAt: now() });
  else await ref.update(data);
  return { id, task: (await ref.get()).val() };
}

async function h_deleteTask(db, p) {
  const id = cleanId(p.id);
  need(id, 'id required');
  await db.ref('tasks/' + id).remove();
  return { deleted: id };
}

async function h_verifyTask(db, p, adminUid) {
  const uid = cleanStr(p.uid, 128);
  const taskId = cleanId(p.taskId);
  need(uid && taskId, 'uid and taskId required');
  const claimRef = db.ref(`taskClaims/${uid}/${taskId}`);
  const snap = await claimRef.get();
  need(snap.exists(), 'Claim not found.');
  const claim = snap.val();
  if (claim.status === 'approved' && p.approve !== false) return { status: 'approved', already: true };
  if (p.approve === false || p.approve === 'false') {
    await claimRef.update({ status: 'rejected', verifiedAt: now(), verifiedBy: adminUid, note: cleanStr(p.note, 300) });
    return { status: 'rejected' };
  }
  const reward = asInt(claim.rewardCoins, 0) || asInt((await db.ref('tasks/' + taskId).get()).val()?.rewardCoins, 0);
  need(reward > 0, 'No reward configured.');
  await claimRef.update({ status: 'approved', verifiedAt: now(), verifiedBy: adminUid, note: cleanStr(p.note, 300) });
  const balanceAfter = await adjustCoinsTx(db, uid, reward, `Task verified: ${taskId}`, taskId);
  return { status: 'approved', balanceAfter, rewardCoins: reward };
}

async function h_adjustCoins(db, p) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required');
  const amount = asInt(p.amount, NaN);
  need(Number.isInteger(amount) && amount !== 0, 'amount must be a non-zero integer');
  const balanceAfter = await adjustCoinsTx(db, uid, amount, p.reason || 'admin adjustment', 'admin');
  return { uid, balanceAfter, amount };
}

async function h_upsertMatch(db, p) {
  const id = cleanId(p.id) || db.ref('matches').push().key;
  const data = {
    tournamentId: cleanId(p.tournamentId),
    title: cleanStr(p.title, 140) || 'Match',
    teamA: cleanStr(p.teamA, 80),
    teamB: cleanStr(p.teamB, 80),
    scoreA: asInt(p.scoreA, 0),
    scoreB: asInt(p.scoreB, 0),
    status: ['upcoming', 'live', 'completed', 'cancelled'].includes(p.status) ? p.status : 'upcoming',
    startAt: asInt(p.startAt, 0) || now(),
    roomId: cleanStr(p.roomId, 100),
    roomPass: cleanStr(p.roomPass, 100),
    streamUrl: cleanStr(p.streamUrl, 500),
    updatedAt: now(),
  };
  const ref = db.ref('matches/' + id);
  if (!(await ref.get()).exists()) await ref.set({ ...data, createdAt: now() });
  else await ref.update(data);
  return { id, match: (await ref.get()).val() };
}

async function h_deleteMatch(db, p) {
  const id = cleanId(p.id);
  need(id, 'id required');
  await db.ref('matches/' + id).remove();
  return { deleted: id };
}

async function h_setResult(db, p) {
  const tournamentId = cleanId(p.tournamentId);
  need(tournamentId, 'tournamentId required');
  const winnerUid = cleanStr(p.winnerUid, 128);
  const winnerName = cleanStr(p.winnerName, 80);
  const prizeCoins = Math.max(0, asInt(p.prizeCoins, 0));
  const note = cleanStr(p.note, 500);
  const tRef = db.ref('tournaments/' + tournamentId);
  need((await tRef.get()).exists(), 'Tournament not found.');
  await tRef.update({ status: 'completed', winnerUid, winnerName, prizeCoins, updatedAt: now() });
  await db.ref('results/' + tournamentId).set({ tournamentId, winnerUid, winnerName, prizeCoins, note, declaredAt: now() });
  let balanceAfter = null;
  if (winnerUid && prizeCoins > 0) {
    try { balanceAfter = await adjustCoinsTx(db, winnerUid, prizeCoins, `Tournament prize: ${tournamentId}`, tournamentId); }
    catch (e) { /* winner user record missing — still keep result */ }
  }
  await db.ref('notificationsGlobal').push({ title: 'Result declared', body: `${winnerName || 'Winner'} won ${prizeCoins} coins!`, tournamentId, createdAt: now() });
  return { tournamentId, winnerUid, winnerName, prizeCoins, balanceAfter };
}

async function h_announce(db, p) {
  const text = cleanStr(p.text, 1000);
  need(text, 'text required');
  const ref = await db.ref('announcements').push({ title: cleanStr(p.title, 140), text, createdAt: now() });
  return { id: ref.key };
}

async function h_deleteAnnouncement(db, p) {
  const id = cleanId(p.id);
  need(id, 'id required');
  await db.ref('announcements/' + id).remove();
  return { deleted: id };
}

async function h_notify(db, p) {
  const title = cleanStr(p.title, 140) || 'Notification';
  const body = cleanStr(p.body, 1000);
  need(body, 'body required');
  if (p.mode === 'user') {
    const uid = cleanStr(p.uid, 128);
    need(uid, 'uid required for user notification');
    const ref = await db.ref('notifications/' + uid).push({ title, body, read: false, createdAt: now() });
    return { id: ref.key, mode: 'user' };
  }
  const ref = await db.ref('notificationsGlobal').push({ title, body, createdAt: now() });
  return { id: ref.key, mode: 'all' };
}

async function h_deleteNotification(db, p) {
  const id = cleanId(p.id);
  need(id, 'id required');
  if (p.scope === 'global') await db.ref('notificationsGlobal/' + id).remove();
  else {
    const uid = cleanStr(p.uid, 128);
    need(uid, 'uid required');
    await db.ref(`notifications/${uid}/${id}`).remove();
  }
  return { deleted: id };
}

async function h_adConfig(db, p) {
  const data = {
    enabled: p.enabled !== false,
    topBannerEnabled: p.topBannerEnabled !== false,
    bannerText: cleanStr(p.bannerText, 300),
    bannerLink: cleanStr(p.bannerLink, 500),
    interstitialEnabled: p.interstitialEnabled === true,
    interstitialText: cleanStr(p.interstitialText, 300),
    updatedAt: now(),
  };
  await db.ref('ads/config').set(data);
  return { ads: data };
}

async function h_setAdmin(db, p) {
  const uid = cleanStr(p.uid, 128);
  need(uid, 'uid required');
  if (p.allow === false || p.allow === 'false') {
    await db.ref('admins/' + uid).remove();
    return { uid, admin: false };
  }
  await db.ref('admins/' + uid).set(true);
  return { uid, admin: true };
}

async function h_adminListUsers(db, p) {
  const limit = Math.min(200, Math.max(1, asInt(p.limit, 50)));
  const snap = await db.ref('users').limitToLast(limit).get();
  const users = [];
  snap.forEach((c) => users.push({ uid: c.key, ...c.val() }));
  users.reverse();
  return { users };
}

async function h_adminListClaims(db, p) {
  const wantStatus = cleanStr(p.status, 20) || 'pending';
  const snap = await db.ref('taskClaims').get();
  const out = [];
  if (snap.exists()) {
    const tasksSnap = await db.ref('tasks').get();
    const tasks = tasksSnap.val() || {};
    snap.forEach((userNode) => {
      userNode.forEach((claimNode) => {
        const claim = claimNode.val() || {};
        if (wantStatus === 'all' || claim.status === wantStatus) {
          out.push({ uid: userNode.key, taskId: claimNode.key, ...claim, taskTitle: (tasks[claimNode.key] || {}).title || claimNode.key });
        }
      });
    });
  }
  out.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));
  return { claims: out.slice(0, 200) };
}

async function h_adminListEntries(db, p) {
  const tid = cleanId(p.tournamentId);
  need(tid, 'tournamentId required');
  const snap = await db.ref('tournamentPlayers/' + tid).get();
  const entries = [];
  snap.forEach((c) => entries.push({ uid: c.key, ...c.val() }));
  entries.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  // Attach names/coins (best effort, capped)
  const capped = entries.slice(0, 300);
  for (const e of capped) {
    try {
      const u = (await db.ref('users/' + e.uid).get()).val() || {};
      e.name = u.name || ''; e.coins = typeof u.coins === 'number' ? u.coins : 0;
    } catch { /* ignore */ }
  }
  return { tournamentId: tid, count: entries.length, entries: capped };
}

// ── Router ───────────────────────────────────────────────────────

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

    // Player actions
    if (action === 'syncUser') return ok(res, await h_syncUser(db, decoded, p));
    if (action === 'joinTournament') return ok(res, await h_joinTournament(db, decoded, p));
    if (action === 'claimTask') return ok(res, await h_claimTask(db, decoded, p));
    if (action === 'markNotificationRead') return ok(res, await h_markNotificationRead(db, decoded, p));

    // Admin actions
    await requireAdmin(decoded);
    if (action === 'adminPing') return ok(res, { admin: true, uid: decoded.uid });
    if (action === 'upsertTournament') return ok(res, await h_upsertTournament(db, p));
    if (action === 'deleteTournament') return ok(res, await h_deleteTournament(db, p));
    if (action === 'upsertTask') return ok(res, await h_upsertTask(db, p));
    if (action === 'deleteTask') return ok(res, await h_deleteTask(db, p));
    if (action === 'verifyTask') return ok(res, await h_verifyTask(db, p, decoded.uid));
    if (action === 'adjustCoins') return ok(res, await h_adjustCoins(db, p));
    if (action === 'upsertMatch') return ok(res, await h_upsertMatch(db, p));
    if (action === 'deleteMatch') return ok(res, await h_deleteMatch(db, p));
    if (action === 'setResult') return ok(res, await h_setResult(db, p));
    if (action === 'announce') return ok(res, await h_announce(db, p));
    if (action === 'deleteAnnouncement') return ok(res, await h_deleteAnnouncement(db, p));
    if (action === 'notify') return ok(res, await h_notify(db, p));
    if (action === 'deleteNotification') return ok(res, await h_deleteNotification(db, p));
    if (action === 'adConfig') return ok(res, await h_adConfig(db, p));
    if (action === 'setAdmin') return ok(res, await h_setAdmin(db, p));
    if (action === 'adminListUsers') return ok(res, await h_adminListUsers(db, p));
    if (action === 'adminListClaims') return ok(res, await h_adminListClaims(db, p));
    if (action === 'adminListEntries') return ok(res, await h_adminListEntries(db, p));

    return fail(res, 400, 'UNKNOWN_ACTION', 'Unknown action');
  } catch (e) {
    const status = e.status || 500;
    const code = e.code || 'INTERNAL';
    return fail(res, status, code, e.message || 'Something went wrong');
  }
};
