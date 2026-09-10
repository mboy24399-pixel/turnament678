// GET /api/health — full system health: public config + Admin SDK + DB probe + time.
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
  const server = envStatus();
  const adminSdk = { configured: false, ...server, canRead: false, error: null, serverTime: Date.now() };
  try {
    const db = getDb();
    await db.ref('adminConfig/adminUid').get();
    adminSdk.configured = true;
    adminSdk.canRead = true;
  } catch (e) {
    adminSdk.error = String((e && e.message) || e).slice(0, 250);
  }
  return ok(res, {
    service: 'esport-arena-x',
    timestamp: new Date().toISOString(),
    runtime: { node: process.version, vercelEnv: process.env.VERCEL_ENV || 'unknown', region: process.env.VERCEL_REGION || 'unknown' },
    publicConfigPresent: missingPublic.length === 0,
    missingPublic,
    adminSdk,
    appCheckEnforce: String(process.env.APP_CHECK_ENFORCE || 'false').toLowerCase() === 'true',
    bootstrapAdminsSet: String(process.env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean).length,
  });
};
