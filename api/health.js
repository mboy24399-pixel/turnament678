import { adminServices, sendJson } from './_lib/firebase-admin.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  const publicRequired = [
    'NEXT_PUBLIC_FIREBASE_API_KEY','NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN','NEXT_PUBLIC_FIREBASE_DATABASE_URL',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID','NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET','NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID','NEXT_PUBLIC_FIREBASE_APP_ID'
  ];
  const publicMissing = publicRequired.filter(name => !String(process.env[name] || '').trim());
  let adminOk = false; let adminError = '';
  try { adminServices(); adminOk = true; } catch (error) { adminError = error.message; }
  const ok = publicMissing.length === 0 && adminOk;
  return sendJson(res, ok ? 200 : 503, { ok, service: 'podmen-x', firebaseWeb: { configured: publicMissing.length === 0, missing: publicMissing }, firebaseAdmin: { configured: adminOk, error: adminOk ? undefined : adminError }, appCheckEnforced: String(process.env.ENFORCE_APP_CHECK || '').toLowerCase() === 'true' });
}
