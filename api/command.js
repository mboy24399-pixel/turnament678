import { randomUUID } from 'node:crypto';
import { adminServices, cleanId, cleanText, httpError, methodGuard, now, sendJson, serverTimestamp, verifyRequest } from './_lib/firebase-admin.js';

const ALLOWED_GAMES = new Set(['Free Fire','BGMI','Call of Duty Mobile','Valorant','EA FC','Other']);

function asNumber(value, min = 0, max = 1_000_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError('Invalid number');
  return Math.trunc(n);
}

function requestId(req, body) {
  return cleanId(req.headers['idempotency-key'] || body?.requestId || '') || randomUUID();
}

async function withOperation(db, uid, key, handler) {
  const ref = db.ref(`operations/${uid}/${key}`);
  const snap = await ref.get();
  const existing = snap.val();
  if (existing?.status === 'complete' && existing.result) return existing.result;
  if (existing?.status === 'processing' && Number(existing.startedAt || 0) > now() - 10 * 60 * 1000) {
    throw httpError('The same operation is already processing', 409, 'OPERATION_IN_PROGRESS');
  }
  const claimed = await ref.transaction(current => {
    if (current?.status === 'complete') return current;
    if (current?.status === 'processing' && Number(current.startedAt || 0) > now() - 10 * 60 * 1000) return;
    return { status: 'processing', startedAt: now() };
  });
  if (!claimed.committed) {
    const current = (await ref.get()).val();
    if (current?.status === 'complete' && current.result) return current.result;
    throw httpError('Could not reserve operation', 409, 'OPERATION_CONFLICT');
  }
  try {
    const result = await handler();
    await ref.set({ status: 'complete', completedAt: serverTimestamp, result });
    return result;
  } catch (error) {
    await ref.update({ status: 'failed', failedAt: serverTimestamp, error: cleanText(error.message, 300) });
    throw error;
  }
}

async function updateProfile(db, uid, payload, decoded) {
  const displayName = cleanText(payload.displayName, 40) || decoded.name || 'Player';
  const gameId = cleanText(payload.gameId, 80);
  const game = ALLOWED_GAMES.has(payload.game) ? payload.game : 'Other';
  const updates = {
    [`users/${uid}/displayName`]: displayName,
    [`users/${uid}/gameId`]: gameId,
    [`users/${uid}/game`]: game,
    [`users/${uid}/updatedAt`]: serverTimestamp,
    [`users/${uid}/uid`]: uid,
    [`accounts/${uid}/displayName`]: displayName,
    [`accounts/${uid}/updatedAt`]: serverTimestamp,
  };
  await db.ref().update(updates);
  return { ok: true, displayName, gameId, game };
}

async function joinTournament(db, uid, decoded, payload) {
  const tid = cleanId(payload.tournamentId);
  if (!tid) throw httpError('Tournament ID is required');
  const tournamentSnap = await db.ref(`tournaments/${tid}`).get();
  if (!tournamentSnap.exists()) throw httpError('Tournament not found', 404, 'TOURNAMENT_NOT_FOUND');
  const t = tournamentSnap.val() || {};
  if (String(t.status || '').toLowerCase() === 'completed' || String(t.status || '').toLowerCase() === 'closed') throw httpError('Tournament is closed', 409, 'TOURNAMENT_CLOSED');
  const startAt = Date.parse(t.startAt || '') || 0;
  const deadline = Date.parse(t.registrationDeadline || '') || startAt;
  if (deadline && now() > deadline) throw httpError('Registration deadline has passed', 409, 'REGISTRATION_CLOSED');
  const fee = asNumber(t.entryFeeCoins ?? t.entryFee ?? 0, 0, 1_000_000);
  const capacity = asNumber(t.capacity ?? 0, 0, 1_000_000);
  const name = cleanText(payload.displayName || decoded.name || 'Player', 40) || 'Player';
  const gameId = cleanText(payload.gameId, 80);
  if (!gameId) throw httpError('Game / player ID is required');

  const existingRegistration = await db.ref(`accounts/${uid}/registrations/${tid}`).get();
  if (existingRegistration.exists() && existingRegistration.val()?.status === 'confirmed') {
    return { ok: true, tournamentId: tid, balance: Number((await db.ref(`accounts/${uid}/balance`).get()).val() || 0), fee: 0, alreadyJoined: true };
  }

  const joinId = randomUUID();
  const seatRef = db.ref(`tournamentSeats/${tid}`);
  const seatTx = await seatRef.transaction(current => {
    const seats = current && typeof current === 'object' ? { ...current } : {};
    const existing = seats[uid];
    if (existing && existing.status === 'confirmed') return seats;
    const cutoff = now() - 15 * 60 * 1000;
    for (const [key, seat] of Object.entries(seats)) {
      if (seat?.status === 'reserved' && Number(seat.reservedAt || 0) < cutoff) delete seats[key];
    }
    const active = Object.values(seats).filter(x => x && (x.status === 'confirmed' || x.status === 'reserved')).length;
    if (capacity && active >= capacity) return;
    seats[uid] = { status: 'reserved', reservedAt: now(), uid };
    return seats;
  });
  if (!seatTx.committed) throw httpError('Tournament is full', 409, 'TOURNAMENT_FULL');

  let charged = false;
  try {
    const accountRef = db.ref(`accounts/${uid}`);
    const tx = await accountRef.transaction(current => {
      const a = current && typeof current === 'object' ? { ...current } : { balance: 0, ledger: {}, registrations: {}, claimedTasks: {} };
      a.balance = Number(a.balance || 0);
      a.ledger = a.ledger && typeof a.ledger === 'object' ? { ...a.ledger } : {};
      a.registrations = a.registrations && typeof a.registrations === 'object' ? { ...a.registrations } : {};
      if (a.registrations[tid]?.status === 'confirmed') return a;
      if (a.balance < fee) return;
      const ledgerId = `join_${tid}_${now()}`;
      a.balance -= fee;
      a.registrations[tid] = { tournamentId: tid, tournamentName: cleanText(t.name, 160), status: 'confirmed', entryFeeCoins: fee, gameId, displayName: name, joinId, joinedAt: serverTimestamp };
      a.ledger[ledgerId] = { type: 'tournament_entry', amount: -fee, balanceAfter: a.balance, tournamentId: tid, description: `Entry fee: ${cleanText(t.name, 120)}`, createdAt: serverTimestamp, joinId };
      a.updatedAt = serverTimestamp;
      return a;
    });
    if (!tx.committed || tx.snapshot.val()?.registrations?.[tid]?.joinId !== joinId) {
      const latest = tx.snapshot.val()?.registrations?.[tid];
      if (latest?.status === 'confirmed') return { ok: true, tournamentId: tid, balance: Number((await accountRef.child('balance').get()).val() || 0), fee: 0, alreadyJoined: true };
      throw httpError(fee ? 'Not enough coins' : 'Could not complete registration', 409, 'INSUFFICIENT_COINS');
    }
    charged = true;
    const registration = { userId: uid, displayName: name, gameId, game: cleanText(t.game, 60), tournamentId: tid, tournamentName: cleanText(t.name, 160), joinedAt: serverTimestamp, status: 'confirmed' };
    await db.ref().update({
      [`tournamentSeats/${tid}/${uid}`]: { status: 'confirmed', uid, confirmedAt: serverTimestamp },
      [`tournaments/${tid}/registeredCount`]: { '.sv': { 'increment': 1 } },
      [`tournamentParticipants/${tid}/${uid}`]: registration,
      [`matchesByUser/${uid}/pending/${tid}`]: { tournamentId: tid, tournamentName: cleanText(t.name, 160), status: 'registered', createdAt: serverTimestamp },
      [`audit/${uid}/${randomUUID()}`]: { action: 'join_tournament', tournamentId: tid, amount: fee, createdAt: serverTimestamp },
    });
    return { ok: true, tournamentId: tid, balance: Number((await accountRef.child('balance').get()).val() || 0), fee };
  } catch (error) {
    if (charged) {
      const accountRef = db.ref(`accounts/${uid}`);
      await accountRef.transaction(current => {
        const a = current && typeof current === 'object' ? { ...current } : { balance: 0, ledger: {}, registrations: {}, claimedTasks: {} };
        const reg = a.registrations?.[tid];
        if (!reg || reg.status !== 'confirmed') return a;
        const ledgerId = `refund_${tid}_${now()}`;
        a.balance = Number(a.balance || 0) + fee;
        a.registrations = { ...(a.registrations || {}) };
        delete a.registrations[tid];
        a.ledger = { ...(a.ledger || {}), [ledgerId]: { type: 'entry_refund', amount: fee, balanceAfter: a.balance, tournamentId: tid, description: 'Automatic registration rollback', createdAt: serverTimestamp } };
        a.updatedAt = serverTimestamp;
        return a;
      });
    }
    await seatRef.child(uid).remove();
    throw error;
  }
}

async function claimTask(db, uid, payload) {
  const taskId = cleanId(payload.taskId);
  if (!taskId) throw httpError('Task ID is required');
  const taskSnap = await db.ref(`tasks/${taskId}`).get();
  if (!taskSnap.exists()) throw httpError('Task not found', 404, 'TASK_NOT_FOUND');
  const task = taskSnap.val() || {};
  if (task.active !== true) throw httpError('Task is not active', 409, 'TASK_INACTIVE');
  const reward = asNumber(task.rewardCoins ?? task.reward ?? 0, 0, 1_000_000);
  if (!reward) throw httpError('Task has no coin reward', 409, 'TASK_NO_REWARD');
  const accountRef = db.ref(`accounts/${uid}`);
  const claimId = randomUUID();
  const existingSnap = await accountRef.child(`claimedTasks/${taskId}`).get();
  if (existingSnap.exists()) throw httpError('Task was already claimed', 409, 'TASK_ALREADY_CLAIMED');
  const tx = await accountRef.transaction(current => {
    const a = current && typeof current === 'object' ? { ...current } : { balance: 0, ledger: {}, registrations: {}, claimedTasks: {} };
    a.balance = Number(a.balance || 0);
    a.claimedTasks = a.claimedTasks && typeof a.claimedTasks === 'object' ? { ...a.claimedTasks } : {};
    a.ledger = a.ledger && typeof a.ledger === 'object' ? { ...a.ledger } : {};
    if (a.claimedTasks[taskId]) return a;
    a.balance += reward;
    a.claimedTasks[taskId] = { claimId, claimedAt: serverTimestamp, reward };
    const ledgerId = `task_${taskId}_${claimId}`;
    a.ledger[ledgerId] = { type: 'task_reward', amount: reward, balanceAfter: a.balance, taskId, description: cleanText(task.title, 120), createdAt: serverTimestamp };
    a.updatedAt = serverTimestamp;
    return a;
  });
  if (!tx.committed || tx.snapshot.val()?.claimedTasks?.[taskId]?.claimId !== claimId) throw httpError('Task was already claimed', 409, 'TASK_ALREADY_CLAIMED');
  return { ok: true, reward, balance: Number((await accountRef.child('balance').get()).val() || 0) };
}

async function adminAction(db, uid, payload) {
  const action = cleanId(payload.action);
  if (action === 'getAdminStats') {
    const snap = await db.ref().get();
    const root = snap.val() || {};
    const tournaments = Object.values(root.tournaments || {});
    const matches = Object.values(root.matches || {});
    const users = Object.values(root.users || {});
    const tasks = Object.values(root.tasks || {});
    const registrations = Object.values(root.tournamentParticipants || {}).reduce((n, group) => n + Object.keys(group || {}).length, 0);
    return { ok: true, stats: { tournaments: tournaments.length, live: tournaments.filter(t => String(t.status || '').toLowerCase() === 'live').length, matches: matches.length, users: users.length, registrations, tasks: tasks.length }, serverTime: now() };
  }
  if (action === 'createTournament') {
    const name = cleanText(payload.name, 160); if (!name) throw httpError('Tournament name is required');
    const id = cleanId(payload.id) || db.ref('tournaments').push().key;
    const capacity = asNumber(payload.capacity || 32, 2, 1_000_000);
    const startAt = new Date(payload.startAt || Date.now() + 86_400_000).toISOString();
    const endAt = new Date(payload.endAt || Date.now() + 172_800_000).toISOString();
    const entryFeeCoins = asNumber(payload.entryFeeCoins || 0, 0, 1_000_000);
    const data = { id, name, game: cleanText(payload.game || 'Esports', 60), mode: cleanText(payload.mode || 'Solo', 40), format: cleanText(payload.format || 'Single Elimination', 60), capacity, entryFeeCoins, prizeCoins: asNumber(payload.prizeCoins || 0, 0, 100_000_000), startAt, endAt, registrationDeadline: new Date(payload.registrationDeadline || startAt).toISOString(), description: cleanText(payload.description, 3000), rules: cleanText(payload.rules, 5000), status: 'open', createdAt: serverTimestamp, createdBy: uid, updatedAt: serverTimestamp, registeredCount: 0 };
    await db.ref(`tournaments/${id}`).set(data); return { ok: true, id };
  }
  if (action === 'updateTournament') {
    const tid = cleanId(payload.tournamentId); if (!tid) throw httpError('Tournament ID is required');
    const patch = {};
    for (const key of ['name','game','mode','format','description','rules','status','startAt','endAt','registrationDeadline']) if (payload[key] !== undefined) patch[key] = cleanText(payload[key], key === 'description' ? 3000 : key === 'rules' ? 5000 : 300);
    for (const key of ['capacity','entryFeeCoins','prizeCoins']) if (payload[key] !== undefined) patch[key] = asNumber(payload[key], 0, 100_000_000);
    patch.updatedAt = serverTimestamp; patch.updatedBy = uid;
    await db.ref(`tournaments/${tid}`).update(patch); return { ok: true, id: tid };
  }
  if (action === 'closeTournament') {
    const tid = cleanId(payload.tournamentId); if (!tid) throw httpError('Tournament ID is required');
    await db.ref(`tournaments/${tid}`).update({ status: 'completed', closedAt: serverTimestamp, closedBy: uid, updatedAt: serverTimestamp }); return { ok: true };
  }
  if (action === 'createTask') {
    const title = cleanText(payload.title, 160); if (!title) throw httpError('Task title is required');
    const id = cleanId(payload.id) || db.ref('tasks').push().key;
    const data = { id, title, description: cleanText(payload.description, 1000), type: cleanText(payload.type || 'external', 30), url: cleanText(payload.url, 1000), rewardCoins: asNumber(payload.rewardCoins || 0, 0, 1_000_000), active: payload.active !== false, createdAt: serverTimestamp, createdBy: uid, updatedAt: serverTimestamp };
    await db.ref(`tasks/${id}`).set(data); return { ok: true, id };
  }
  if (action === 'updateTask') {
    const id = cleanId(payload.taskId); if (!id) throw httpError('Task ID is required');
    const patch = { updatedAt: serverTimestamp, updatedBy: uid };
    for (const key of ['title','description','type','url']) if (payload[key] !== undefined) patch[key] = cleanText(payload[key], 1000);
    if (payload.rewardCoins !== undefined) patch.rewardCoins = asNumber(payload.rewardCoins, 0, 1_000_000);
    if (payload.active !== undefined) patch.active = payload.active === true;
    await db.ref(`tasks/${id}`).update(patch); return { ok: true };
  }
  if (action === 'deleteTask') {
    const id = cleanId(payload.taskId); if (!id) throw httpError('Task ID is required'); await db.ref(`tasks/${id}`).remove(); return { ok: true };
  }
  if (action === 'adjustCoins') {
    const targetUid = cleanId(payload.uid); if (!targetUid) throw httpError('User UID is required');
    const amount = asNumber(payload.amount, -100_000_000, 100_000_000); if (!amount) throw httpError('Amount cannot be zero');
    const reason = cleanText(payload.reason, 200) || 'Admin adjustment';
    const accountRef = db.ref(`accounts/${targetUid}`);
    const tx = await accountRef.transaction(current => {
      const a = current && typeof current === 'object' ? { ...current } : { balance: 0, ledger: {}, registrations: {}, claimedTasks: {} };
      a.balance = Number(a.balance || 0);
      a.ledger = a.ledger && typeof a.ledger === 'object' ? { ...a.ledger } : {};
      const next = a.balance + amount; if (next < 0) return;
      a.balance = next;
      const ledgerId = `admin_${now()}_${randomUUID()}`;
      a.ledger[ledgerId] = { type: 'admin_adjustment', amount, balanceAfter: next, reason, adminUid: uid, createdAt: serverTimestamp };
      a.updatedAt = serverTimestamp;
      return a;
    });
    if (!tx.committed) throw httpError('Insufficient balance for this adjustment', 409, 'NEGATIVE_BALANCE');
    return { ok: true, uid: targetUid, amount, balance: Number((await accountRef.child('balance').get()).val() || 0) };
  }
  if (action === 'saveMatch') {
    const matchId = cleanId(payload.matchId) || db.ref('matches').push().key;
    const tournamentId = cleanId(payload.tournamentId); if (!tournamentId) throw httpError('Tournament ID is required');
    const p1 = cleanId(payload.player1); const p2 = cleanId(payload.player2); if (!p1 || !p2) throw httpError('Both player UIDs are required');
    const score1 = asNumber(payload.score1 || 0, 0, 100000); const score2 = asNumber(payload.score2 || 0, 0, 100000);
    const winner = score1 === score2 ? 'draw' : score1 > score2 ? p1 : p2;
    const tSnap = await db.ref(`tournaments/${tournamentId}`).get(); const t = tSnap.val() || {};
    const match = { id: matchId, tournamentId, tournamentName: cleanText(t.name, 160), player1: p1, player2: p2, score1, score2, round: cleanText(payload.round || 'Match', 80), status: 'completed', winner, updatedAt: serverTimestamp, updatedBy: uid };
    const updates = { [`matches/${matchId}`]: match, [`matchesByUser/${p1}/${matchId}`]: match, [`matchesByUser/${p2}/${matchId}`]: match };
    if (winner !== 'draw') updates[`leaderboard/${winner}/points`] = { '.sv': { 'increment': asNumber(payload.points || 3, 0, 1000) } };
    await db.ref().update(updates); return { ok: true, id: matchId, winner };
  }
  if (action === 'publishAnnouncement' || action === 'publishNotification') {
    const title = cleanText(payload.title, 160); const body = cleanText(payload.body, 2000); if (!title || !body) throw httpError('Title and message are required');
    const node = action === 'publishAnnouncement' ? 'announcements' : 'notifications'; const id = db.ref(node).push().key;
    await db.ref(`${node}/${id}`).set({ id, title, body, createdAt: serverTimestamp, createdBy: uid, active: true }); return { ok: true, id };
  }
  if (action === 'saveAdConfig') {
    const providers = Array.isArray(payload.providers) ? payload.providers.slice(0, 12).map(p => ({ network: cleanText(p.network, 40), clientId: cleanText(p.clientId, 200), slotId: cleanText(p.slotId, 200), enabled: p.enabled === true })) : [];
    await db.ref('adConfig').set({ enabled: payload.enabled !== false, providers, updatedAt: serverTimestamp, updatedBy: uid }); return { ok: true };
  }
  throw httpError('Unknown admin action');
}

export default async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { decoded, isAdmin, db } = await verifyRequest(req);
    const action = cleanId(body.action);
    const key = requestId(req, body);
    const result = await withOperation(db, decoded.uid, key, async () => {
      if (action === 'updateProfile') return updateProfile(db, decoded.uid, body, decoded);
      if (action === 'joinTournament') return joinTournament(db, decoded.uid, decoded, body);
      if (action === 'claimTask') return claimTask(db, decoded.uid, body);
      if (!isAdmin) throw httpError('Administrator access required', 403, 'ADMIN_REQUIRED');
      return adminAction(db, decoded.uid, { ...body, action });
    });
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('command_error', error);
    return sendJson(res, Number(error.status || 500), { ok: false, error: error.message || 'Server error', code: error.code || 'INTERNAL_ERROR' });
  }
}
