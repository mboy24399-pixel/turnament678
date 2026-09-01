import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { getDatabase } from 'firebase-admin/database';

let cached;

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) throw new Error(`Missing ${name}`);
  return String(value).trim();
}

function requiredUrl(name) {
  const value = required(name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Invalid ${name}`);
  return parsed.toString().replace(/\/$/, '');
}

export function adminServices() {
  if (cached) return cached;
  const projectId = required('FIREBASE_PROJECT_ID');
  const clientEmail = required('FIREBASE_CLIENT_EMAIL');
  if (!clientEmail.includes('@')) throw new Error('Invalid FIREBASE_CLIENT_EMAIL');
  const privateKey = required('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) throw new Error('Invalid FIREBASE_PRIVATE_KEY');
  const databaseURL = requiredUrl('FIREBASE_DATABASE_URL');
  const app = getApps().length ? getApps()[0] : initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    databaseURL,
  });
  cached = { app, auth: getAuth(app), appCheck: getAppCheck(app), db: getDatabase(app) };
  return cached;
}

export async function verifyRequest(req, { adminOnly = false } = {}) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }
  const token = header.slice(7).trim();
  if (!token) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }
  const { auth, appCheck, db } = adminServices();
  if (String(process.env.ENFORCE_APP_CHECK || '').toLowerCase() === 'true') {
    const appCheckToken = req.headers['x-firebase-appcheck'];
    if (!appCheckToken) {
      const error = new Error('App Check token required');
      error.status = 401;
      throw error;
    }
    try {
      await appCheck.verifyToken(String(appCheckToken));
    } catch {
      const error = new Error('Invalid App Check token');
      error.status = 401;
      throw error;
    }
  }
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token, true);
  } catch {
    const error = new Error('Invalid or expired authentication token');
    error.status = 401;
    throw error;
  }
  const adminSnap = await db.ref(`admins/${decoded.uid}`).get();
  const isAdmin = adminSnap.val() === true;
  if (adminOnly && !isAdmin) {
    const error = new Error('Administrator access required');
    error.status = 403;
    throw error;
  }
  return { decoded, isAdmin, auth, db };
}

export function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.json(payload);
}

export function methodGuard(req, res, method = 'POST') {
  if (req.method !== method) {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return false;
  }
  return true;
}

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function cleanId(value) {
  const id = cleanText(value, 120);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return id;
}

export const serverTimestamp = { '.sv': 'timestamp' };

export function now() {
  return Date.now();
}

export function httpError(message, status = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
