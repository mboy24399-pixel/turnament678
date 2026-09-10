// GET /api/health — checks public Firebase config + server Admin SDK config.
// Also returns the PUBLIC web config so plain static HTML pages can init Firebase
// without a build step (public keys are safe to expose by Firebase design).
const { getDb, envStatus, setCors, ok } = require('./_admin');

const REQUIRED_PUBLIC = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_DATABASE_URL',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
];

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' } })); }

  const missingPublic = REQUIRED_PUBLIC.filter((k) => !process.env[k]);
  const publicConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || '',
  };

  const server = envStatus();
  let adminSdk = { configured: false, ...server, canRead: false, error: null };
  try {
    const db = getDb();
    await db.ref('meta/healthProbe').get(); // cheap read to prove credentials work
    adminSdk.configured = true;
    adminSdk.canRead = true;
  } catch (e) {
    adminSdk.error = String((e && e.message) || e).slice(0, 300);
    adminSdk.configured = false;
  }

  return ok(res, {
    service: 'podmen-x-tournament-arena',
    timestamp: new Date().toISOString(),
    runtime: { node: process.version, vercelEnv: process.env.VERCEL_ENV || 'unknown', region: process.env.VERCEL_REGION || 'unknown' },
    publicConfigPresent: missingPublic.length === 0,
    missingPublic,
    publicConfig,
    adminSdk,
    appCheckEnforce: String(process.env.APP_CHECK_ENFORCE || 'false').toLowerCase() === 'true',
  });
};
