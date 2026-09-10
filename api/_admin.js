// ═══════════════════════════════════════════════════════════════
//  E-SPORT ARENA X — shared backend helper (Vercel Serverless, CommonJS)
//  Firebase Admin init + auth + admin-gate + http helpers + rate limit.
// ═══════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

let _db = null;
let _initError = null;

function envStatus() {
  return {
    projectIdSet: Boolean(process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    clientEmailSet: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
    privateKeySet: Boolean(process.env.FIREBASE_PRIVATE_KEY),
    databaseUrlSet: Boolean(process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL),
  };
}

function getDb() {
  if (_db) return _db;
  if (_initError) throw _initError;
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    const databaseURL = process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;
    if (!projectId || !clientEmail || !privateKey || !databaseURL) {
      const missing = [];
      if (!projectId) missing.push('FIREBASE_PROJECT_ID');
      if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
      if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');
      if (!databaseURL) missing.push('FIREBASE_DATABASE_URL');
      throw new Error('Missing server Firebase env: ' + missing.join(', '));
    }
    privateKey = privateKey.replace(/\\n/g, '\n');
    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) || (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
      privateKey = privateKey.slice(1, -1);
    }
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        databaseURL,
      });
    }
    _db = admin.database();
    return _db;
  } catch (e) {
    _initError = e;
    throw e;
  }
}

function getAdmin() { getDb(); return admin; }
function bootstrapAdminUids() {
  return String(process.env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Admin = ADMIN_UIDS env (bootstrap) OR adminConfig/adminUid in DB (first-setup flow).
async function isAdminUid(uid) {
  if (!uid) return false;
  if (bootstrapAdminUids().includes(uid)) return true;
  try {
    const snap = await getDb().ref('adminConfig/adminUid').get();
    return snap.val() === uid;
  } catch { return false; }
}

function getBearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function requireAuth(req) {
  const token = getBearerToken(req);
  if (!token) {
    const e = new Error('Login required. Please sign in again.');
    e.status = 401; e.code = 'UNAUTHENTICATED';
    throw e;
  }
  try {
    return await getAdmin().auth().verifyIdToken(token);
  } catch {
    const e = new Error('Session expired. Please sign in again.');
    e.status = 401; e.code = 'UNAUTHENTICATED';
    throw e;
  }
}

async function requireAdmin(decoded) {
  if (!(await isAdminUid(decoded.uid))) {
    const e = new Error('Admin access required.');
    e.status = 403; e.code = 'PERMISSION_DENIED';
    throw e;
  }
  return true;
}

async function requireActiveUser(db, uid) {
  const snap = await db.ref('users/' + uid).get();
  if (!snap.exists()) {
    const e = new Error('Account record not found. Please login again.');
    e.status = 404; e.code = 'USER_NOT_FOUND';
    throw e;
  }
  const u = snap.val() || {};
  if (u.blocked === true) {
    const e = new Error('Your account has been blocked by admin. Contact support.');
    e.status = 403; e.code = 'ACCOUNT_BLOCKED';
    throw e;
  }
  return u;
}

function parseBody(req) {
  return new Promise((resolve) => {
    try {
      if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === 'object') return resolve(req.body);
        if (typeof req.body === 'string') {
          const t = req.body.trim();
          if (!t) return resolve({});
          try { return resolve(JSON.parse(t)); } catch { return resolve({}); }
        }
      }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 512 * 1024) { try { req.destroy(); } catch {} } });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
      setTimeout(() => resolve({}), 4000);
    } catch { resolve({}); }
  });
}

function setCors(req, res) {
  const origin = req.headers && req.headers.origin;
  const allowList = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.setHeader('Vary', 'Origin');
  if (!origin) return;
  if (allowList.length && (allowList.includes('*') || allowList.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowList.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-firebase-appcheck');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

function ok(res, data) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: true, ...data }));
}

function fail(res, status, code, message, extra) {
  res.statusCode = status || 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error: { code: code || 'INTERNAL', message: message || 'Something went wrong' }, ...(extra || {}) }));
}

const _hits = new Map();
function rateLimit(key, maxPerMin) {
  const nowMs = Date.now();
  const arr = (_hits.get(key) || []).filter((t) => nowMs - t < 60000);
  arr.push(nowMs);
  _hits.set(key, arr);
  if (_hits.size > 3000) _hits.delete(_hits.keys().next().value);
  return arr.length <= (maxPerMin || 60);
}

module.exports = {
  admin, getDb, getAdmin, envStatus, bootstrapAdminUids, isAdminUid,
  requireAuth, requireAdmin, requireActiveUser, getBearerToken,
  parseBody, setCors, ok, fail, rateLimit,
};
