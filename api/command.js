import { randomUUID } from 'node:crypto';
import { cleanId, cleanText, httpError, methodGuard, now, sendJson, serverTimestamp, verifyRequest } from './_lib/firebase-admin.js';

const ALLOWED_GAMES = new Set(['Free Fire', 'BGMI', 'Call of Duty Mobile', 'Valorant', 'EA FC', 'Other']);
const TOURNAMENT_STATUSES = new Set(['draft', 'open', 'live', 'completed', 'closed']);

function asNumber(value, min = 0, max = 1_000_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError('Invalid number');
  return Math.trunc(n);
}

function requestId(req, body) {
  return cleanId(req.headers['idempotency-key'] || body?.requestId || '') || randomUUID();
}

function isoDate(value, fallback) {
  const date = new Date(value || fallback);
  if (!Number.isFinite(date.getTime())) throw httpError('Invalid date');
  return date.toISOString();
}

function accountDefaults(current) {
  const a = current && typeof current === 'object' ? { ...current } : {};
  a.balance = Number(a.balance || 0);
  a.ledger = a.ledger && typeof a.ledger === 'object' ? { ...a.ledger } : {};
  a.registrations = a.registrations && typeof a.registrations === 'object' ? { ...a.registrations } : {};
  a.claimedTasks = a.claimedTasks && typeof a.claimedTasks === 'object' ? { ...a.claimedTasks } : {};
  return a;
}

async function withOperation(db, uid, key, handler) {
  const ref = db.ref(`operations/${uid}/${key}`);
  const existing = (await ref.get()).val();
  if (existing?.status === 'complete' && existing.result) return existing.result;
  if (existing?.status === 'processing' && Number(existing.startedAt || 0) > now() - 10 * 60 * 1000) {
    throw httpError('The same operation is already processing', 409, 'OPERATION_IN_PROGRESS');
  }
  const claimed = await ref.transaction(current => {
    if (current?.status === 'complete') return current;
    if (current?.status === 'processing' && Number(current.startedAt || 0) > now() - 10 * 60 * 1000) return;
    return { status: 'processing', startedAt: now() };
  });
  if (!claimed.committed) throw httpError('Could not reserve operation', 409, 'OPERATION_CONFLICT');
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
  await db.ref().update({
    [`users/${uid}/displayName`]: displayName,
    [`users/${uid}/gameId`]: gameId,
    [`users/${uid}/game`]: game,
    [`users/${uid}/uid`]: uid,
    [`users/${uid}/updatedAt`]: serverTimestamp,
    [`accounts/${uid}/displayName`]: displayName,
    [`accounts/${uid}/updatedAt`]: serverTimestamp,
  });
  return { ok: true, displayName, gameId, game };
}

async function joinTournament(db, uid, decoded, payload) {
  const tid = cleanId(payload.tournamentId);
  if (!tid) throw httpError('Tournament ID is required');
  const snap = await db.ref(`tournaments/${tid}`).get();
  if (!snap.exists()) throw httpError('Tournament not found', 404, 'TOURNAMENT_NOT_FOUND');
  const t = snap.val() || {};
  const status = String(t.status || 'open').toLowerCase();
  if (['completed', 'closed', 'draft'].includes(status)) throw httpError('Tournament is not open for registration', 409, 'TOURNAMENT_CLOSED');
  const startAt = Date.parse(t.startAt || '') || 0;
  const deadline = Date.parse(t.registrationDeadline || '') || startAt;
  if (deadline && now() > deadline) throw httpError('Registration deadline has passed', 409, 'REGISTRATION_CLOSED');
  if (startAt && now() >= startAt && status !== 'open') throw httpError('Tournament registration is closed', 409, 'REGISTRATION_CLOSED');

  const fee = asNumber(t.entryFeeCoins ?? t.entryFee ?? 0, 0, 1_000_000);
  const capacity = asNumber(t.capacity ?? 32, 2, 1_000_000);
  const name = cleanText(payload.displayName || decoded.name || 'Player', 40) || 'Player';
  const gameId = cleanText(payload.gameId, 80);
  if (!gameId) throw httpError('Game / player ID is required');

  const existing = await db.ref(`accounts/${uid}/registrations/${tid}`).get();
  if (existing.val()?.status === 'confirmed') {
    return { ok: true, tournamentId: tid, balance: Number((await db.ref(`accounts/${uid}/balance`).get()).val() || 0), fee: 0, alreadyJoined: true };
  }

  const seatRef = db.ref(`tournamentSeats/${tid}`);
  const joinId = randomUUID();
  const seatTx = await seatRef.transaction(current => {
    const seats = current && typeof current === 'object' ? { ...current } : {};
    if (seats[uid]?.status === 'confirmed') return seats;
    const cutoff = now() - 15 * 60 * 1000;
    for (const [key, seat] of Object.entries(seats)) {
      if (seat?.status === 'reserved' && Number(seat.reservedAt || 0) < cutoff) delete seats[key];
    }
    const active = Object.values(seats).filter(x => x && ['confirmed', 'reserved'].includes(x.status)).length;
    if (active >= capacity) return;
    seats[uid] = { status: 'reserved', uid, reservedAt: now(), joinId };
    return seats;
  });
  if (!seatTx.committed) throw httpError('Tournament is full', 409, 'TOURNAMENT_FULL');

  let charged = false;
  try {
    const accountRef = db.ref(`accounts/${uid}`);
    const tx = await accountRef.transaction(current => {
      const a = accountDefaults(current);
      if (a.registrations[tid]?.status === 'confirmed') return a;
      if (a.balance < fee) return;
      a.balance -= fee;
      a.registrations[tid] = { tournamentId: tid, tournamentName: cleanText(t.name, 160), status: 'confirmed', entryFeeCoins: fee, gameId, displayName: name, joinId, joinedAt: serverTimestamp };
      a.ledger[`join_${tid}_${joinId}`] = { type: 'tournament_entry', amount: -fee, balanceAfter: a.balance, tournamentId: tid, description: `Entry fee: ${cleanText(t.name, 120)}`, createdAt: serverTimestamp, joinId };
      a.updatedAt = serverTimestamp;
      return a;
    });
    const registration = tx.snapshot.val()?.registrations?.[tid];
    if (!tx.committed || registration?.joinId !== joinId) {
      if (registration?.status === 'confirmed') return { ok: true, tournamentId: tid, balance: Number((await accountRef.child('balance').get()).val() || 0), fee: 0, alreadyJoined: true };
      throw httpError('Not enough coins', 409, 'INSUFFICIENT_COINS');
    }
    charged = true;

    const participant = { userId: uid, displayName: name, gameId, game: cleanText(t.game, 60), tournamentId: tid, tournamentName: cleanText(t.name, 160), joinedAt: serverTimestamp, status: 'confirmed' };
    await db.ref().update({
      [`tournamentSeats/${tid}/${uid}`]: { status: 'confirmed', uid, confirmedAt: serverTimestamp },
      [`tournamentParticipants/${tid}/${uid}`]: participant,
      [`matchesByUser/${uid}/pending/${tid}`]: { tournamentId: tid, tournamentName: cleanText(t.name, 160), status: 'registered', createdAt: serverTimestamp },
      [`audit/${uid}/${randomUUID()}`]: { action: 'join_tournament', tournamentId: tid, amount: fee, createdAt: serverTimestamp },
    });
    await db.ref(`tournaments/${tid}/registeredCount`).transaction(value => Number(value || 0) + 1);
    return { ok: true, tournamentId: tid, balance: Number((await accountRef.child('balance').get()).val() || 0), fee };
  } catch (error) {
    if (charged) {
      const accountRef = db.ref(`accounts/${uid}`);
      await accountRef.transaction(current => {
        const a = accountDefaults(current);
        const reg = a.registrations[tid];
        if (!reg || reg.status !== 'confirmed') return a;
        a.balance += fee;
        delete a.registrations[tid];
        a.ledger[`refund_${tid}_${joinId}`] = { type: 'entry_refund', amount: fee, balanceAfter: a.balance, tournamentId: tid, description: 'Automatic registration rollback', createdAt: serverTimestamp };
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
  const snap = await db.ref(`tasks/${taskId}`).get();
  if (!snap.exists()) throw httpError('Task not found', 404, 'TASK_NOT_FOUND');
  const task = snap.val() || {};
  if (task.active !== true) throw httpError('Task is not active', 409, 'TASK_INACTIVE');
  const reward = asNumber(task.rewardCoins ?? task.reward ?? 0, 0, 1_000_000);
  if (!reward) throw httpError('Task has no coin reward', 409, 'TASK_NO_REWARD');
  if (String(task.verification || 'manual').toLowerCase() !== 'instant') {
    throw httpError('This task requires server verification before coins are awarded', 409, 'TASK_VERIFICATION_REQUIRED');
  }
  const accountRef = db.ref(`accounts/${uid}`);
  const claimId = randomUUID();
  const tx = await accountRef.transaction(current => {
    const a = accountDefaults(current);
    if (a.claimedTasks[taskId]) return a;
    a.balance += reward;
    a.claimedTasks[taskId] = { claimId, claimedAt: serverTimestamp, reward };
    a.ledger[`task_${taskId}_${claimId}`] = { type: 'task_reward', amount: reward, balanceAfter: a.balance, taskId, description: cleanText(task.title, 120), createdAt: serverTimestamp };
    a.updatedAt = serverTimestamp;
    return a;
  });
  if (!tx.committed || tx.snapshot.val()?.claimedTasks?.[taskId]?.claimId !== claimId) throw httpError('Task was already claimed', 409, 'TASK_ALREADY_CLAIMED');
  return { ok: true, reward, balance: Number((await accountRef.child('balance').get()).val() || 0) };
}

async function createTournament(db, uid, payload) {
  const name = cleanText(payload.name, 160);
  if (!name) throw httpError('Tournament name is required');
  const id = cleanId(payload.id) || db.ref('tournaments').push().key;
  const startAt = isoDate(payload.startAt, Date.now() + 86_400_000);
  const endAt = isoDate(payload.endAt, Date.now() + 172_800_000);
  const registrationDeadline = isoDate(payload.registrationDeadline, startAt);
  if (new Date(endAt) <= new Date(startAt)) throw httpError('End time must be after start time');
  if (new Date(registrationDeadline) > new Date(startAt)) throw httpError('Registration deadline cannot be after start time');
  const status = TOURNAMENT_STATUSES.has(String(payload.status || 'open').toLowerCase()) ? String(payload.status || 'open').toLowerCase() : 'open';
  const data = { id, name, game: cleanText(payload.game || 'Other', 60), mode: cleanText(payload.mode || 'Solo', 40), format: cleanText(payload.format || 'Single Elimination', 60), capacity: asNumber(payload.capacity || 32, 2, 1_000_000), entryFeeCoins: asNumber(payload.entryFeeCoins || 0, 0, 1_000_000), prizeCoins: asNumber(payload.prizeCoins || 0, 0, 100_000_000), startAt, endAt, registrationDeadline, description: cleanText(payload.description, 3000), rules: cleanText(payload.rules, 5000), status, registeredCount: 0, createdAt: serverTimestamp, createdBy: uid, updatedAt: serverTimestamp };
  await db.ref(`tournaments/${id}`).set(data);
  return { ok: true, id };
}

async function generateBracket(db, uid, payload) {
  const tid = cleanId(payload.tournamentId);
  if (!tid) throw httpError('Tournament ID is required');
  const tSnap = await db.ref(`tournaments/${tid}`).get();
  if (!tSnap.exists()) throw httpError('Tournament not found', 404, 'TOURNAMENT_NOT_FOUND');
  const t = tSnap.val() || {};
  const pSnap = await db.ref(`tournamentParticipants/${tid}`).get();
  const participants = Object.values(pSnap.val() || {}).filter(p => p?.status === 'confirmed');
  if (participants.length < 2) throw httpError('At least two confirmed players are required');
  if (participants.length % 2 !== 0) throw httpError('Bracket generation currently requires an even number of players', 409, 'ODD_PLAYER_COUNT');
  const ordered = participants.sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
  const updates = {};
  const matchIds = [];
  for (let i = 0; i < ordered.length; i += 2) {
    const p1 = ordered[i]; const p2 = ordered[i + 1];
    const id = `m_${tid}_r1_${i / 2 + 1}`;
    const match = { id, tournamentId: tid, tournamentName: cleanText(t.name, 160), round: 'Round 1', player1: p1.userId, player2: p2.userId, player1Name: cleanText(p1.displayName, 80), player2Name: cleanText(p2.displayName, 80), score1: 0, score2: 0, status: 'pending', winner: null, createdAt: serverTimestamp, updatedAt: serverTimestamp, updatedBy: uid };
    updates[`matches/${id}`] = match;
    updates[`matchesByUser/${p1.userId}/${id}`] = match;
    updates[`matchesByUser/${p2.userId}/${id}`] = match;
    matchIds.push(id);
  }
  updates[`tournaments/${tid}/bracket`] = { generatedAt: serverTimestamp, generatedBy: uid, round1: matchIds };
  updates[`tournaments/${tid}/status`] = 'live';
  updates[`tournaments/${tid}/updatedAt`] = serverTimestamp;
  await db.ref().update(updates);
  return { ok: true, tournamentId: tid, matchesCreated: matchIds.length };
}

async function saveMatch(db, uid, payload) {
  const matchId = cleanId(payload.matchId) || db.ref('matches').push().key;
  const tournamentId = cleanId(payload.tournamentId);
  const p1 = cleanId(payload.player1); const p2 = cleanId(payload.player2);
  if (!tournamentId || !p1 || !p2 || p1 === p2) throw httpError('Two different player UIDs are required');
  const score1 = asNumber(payload.score1, 0, 100000); const score2 = asNumber(payload.score2, 0, 100000);
  if (score1 === score2) throw httpError('A completed elimination match cannot end in a draw');
  const winner = score1 > score2 ? p1 : p2;
  const points = asNumber(payload.points ?? 3, 0, 1000);
  const matchRef = db.ref(`matches/${matchId}`);
  const existing = (await matchRef.get()).val();
  if (existing?.status === 'completed') throw httpError('Match is already finalized', 409, 'MATCH_ALREADY_FINALIZED');
  const tSnap = await db.ref(`tournaments/${tournamentId}`).get();
  if (!tSnap.exists()) throw httpError('Tournament not found', 404, 'TOURNAMENT_NOT_FOUND');
  const t = tSnap.val() || {};
  const match = { id: matchId, tournamentId, tournamentName: cleanText(t.name, 160), player1: p1, player2: p2, score1, score2, round: cleanText(payload.round || 'Match', 80), status: 'completed', winner, points, updatedAt: serverTimestamp, updatedBy: uid };
  const tx = await matchRef.transaction(current => current || match);
  const confirmed = tx.snapshot.val();
  if (!tx.committed || confirmed?.winner !== winner || confirmed?.status !== 'completed') throw httpError('Match finalization conflict', 409, 'MATCH_CONFLICT');
  if (tx.committed) {
    await db.ref().update({
      [`matchesByUser/${p1}/${matchId}`]: confirmed,
      [`matchesByUser/${p2}/${matchId}`]: confirmed,
      [`leaderboard/${winner}/points`]: { '.sv': { increment: points } },
      [`leaderboard/${winner}/displayName`]: cleanText(payload.winnerName || winner, 80),
      [`leaderboard/${winner}/updatedAt`]: serverTimestamp,
    });
  }
  return { ok: true, id: matchId, winner, points };
}

async function adminAction(db, uid, payload) {
  const action = cleanId(payload.action);
  if (action === 'getAdminStats') {
    const [tournamentsSnap, matchesSnap, usersSnap, tasksSnap, participantsSnap] = await Promise.all([db.ref('tournaments').get(), db.ref('matches').get(), db.ref('users').get(), db.ref('tasks').get(), db.ref('tournamentParticipants').get()]);
    const tournaments = Object.values(tournamentsSnap.val() || {});
    const registrations = Object.values(participantsSnap.val() || {}).reduce((n, group) => n + Object.keys(group || {}).length, 0);
    return { ok: true, stats: { tournaments: tournaments.length, live: tournaments.filter(t => String(t.status || '').toLowerCase() === 'live').length, matches: Object.keys(matchesSnap.val() || {}).length, users: Object.keys(usersSnap.val() || {}).length, registrations, tasks: Object.keys(tasksSnap.val() || {}).length }, serverTime: now() };
  }
  if (action === 'createTournament') return createTournament(db, uid, payload);
  if (action === 'generateBracket') return generateBracket(db, uid, payload);
  if (action === 'saveMatch') return saveMatch(db, uid, payload);

  if (action === 'updateTournament') {
    const tid = cleanId(payload.tournamentId); if (!tid) throw httpError('Tournament ID is required');
    const patch = {};
    for (const key of ['name', 'game', 'mode', 'format', 'description', 'rules']) if (payload[key] !== undefined) patch[key] = cleanText(payload[key], key === 'description' ? 3000 : key === 'rules' ? 5000 : 300);
    if (payload.status !== undefined) { const status = String(payload.status).toLowerCase(); if (!TOURNAMENT_STATUSES.has(status)) throw httpError('Invalid tournament status'); patch.status = status; }
    for (const key of ['startAt', 'endAt', 'registrationDeadline']) if (payload[key] !== undefined) patch[key] = isoDate(payload[key]);
    for (const key of ['capacity', 'entryFeeCoins', 'prizeCoins']) if (payload[key] !== undefined) patch[key] = asNumber(payload[key], 0, 100_000_000);
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
    const verification = String(payload.verification || 'manual').toLowerCase() === 'instant' ? 'instant' : 'manual';
    const data = { id, title, description: cleanText(payload.description, 1000), type: cleanText(payload.type || 'external', 30), url: cleanText(payload.url, 1000), verification, rewardCoins: asNumber(payload.rewardCoins || 0, 0, 1_000_000), active: payload.active !== false, createdAt: serverTimestamp, createdBy: uid, updatedAt: serverTimestamp };
    await db.ref(`tasks/${id}`).set(data); return { ok: true, id };
  }
  if (action === 'updateTask') {
    const id = cleanId(payload.taskId); if (!id) throw httpError('Task ID is required');
    const patch = { updatedAt: serverTimestamp, updatedBy: uid };
    for (const key of ['title', 'description', 'type', 'url']) if (payload[key] !== undefined) patch[key] = cleanText(payload[key], 1000);
    if (payload.rewardCoins !== undefined) patch.rewardCoins = asNumber(payload.rewardCoins, 0, 1_000_000);
    if (payload.active !== undefined) patch.active = payload.active === true;
    if (payload.verification !== undefined) patch.verification = String(payload.verification).toLowerCase() === 'instant' ? 'instant' : 'manual';
    await db.ref(`tasks/${id}`).update(patch); return { ok: true };
  }
  if (action === 'deleteTask') { const id = cleanId(payload.taskId); if (!id) throw httpError('Task ID is required'); await db.ref(`tasks/${id}`).remove(); return { ok: true }; }
  if (action === 'adjustCoins') {
    const targetUid = cleanId(payload.uid); if (!targetUid) throw httpError('User UID is required');
    const amount = Number(payload.amount); if (!Number.isInteger(amount) || amount < -100_000_000 || amount > 100_000_000 || amount === 0) throw httpError('Invalid coin adjustment');
    const reason = cleanText(payload.reason, 200) || 'Admin adjustment'; const accountRef = db.ref(`accounts/${targetUid}`);
    const tx = await accountRef.transaction(current => { const a = accountDefaults(current); const next = a.balance + amount; if (next < 0) return; a.balance = next; a.ledger[`admin_${randomUUID()}`] = { type: 'admin_adjustment', amount, balanceAfter: next, reason, adminUid: uid, createdAt: serverTimestamp }; a.updatedAt = serverTimestamp; return a; });
    if (!tx.committed) throw httpError('Adjustment would create a negative balance', 409, 'NEGATIVE_BALANCE');
    return { ok: true, uid: targetUid, amount, balance: Number((await accountRef.child('balance').get()).val() || 0) };
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
  throw httpError('Unknown admin action', 400, 'UNKNOWN_ACTION');
}

export default async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { decoded, isAdmin, db } = await verifyRequest(req);
    const action = cleanId(body.action); if (!action) throw httpError('Action is required');
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
    const status = Number(error?.status || 500);
    return sendJson(res, status >= 400 && status <= 599 ? status : 500, { ok: false, error: cleanText(error?.message || 'Server error', 300), code: cleanId(error?.code || 'INTERNAL_ERROR') || 'INTERNAL_ERROR' });
  }
}
