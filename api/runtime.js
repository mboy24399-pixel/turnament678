// GET /api/runtime — tiny probe, booleans only, never secrets.
const { envStatus, setCors, ok } = require('./_admin');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const s = envStatus();
  return ok(res, {
    service: 'esport-arena-x/runtime',
    timestamp: new Date().toISOString(),
    node: process.version,
    vercelEnv: process.env.VERCEL_ENV || 'unknown',
    region: process.env.VERCEL_REGION || 'unknown',
    hasPublicConfig: Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL),
    hasServerCredentials: Boolean(s.clientEmailSet && s.privateKeySet),
    serverEnvBooleans: s,
  });
};
