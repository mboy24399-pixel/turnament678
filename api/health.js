import { adminServices, sendJson } from './_lib/firebase-admin.js';

function normalizedUrl(value) {
  try { return new URL(String(value).trim()).toString().replace(/\/$/, ''); } catch { return ''; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

  const publicRequired = [
    'NEXT_PUBLIC_FIREBASE_API_KEY','NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN','NEXT_PUBLIC_FIREBASE_DATABASE_URL',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID','NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET','NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID','NEXT_PUBLIC_FIREBASE_APP_ID'
  ];
  const adminRequired = ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_DATABASE_URL'];
  const publicMissing = publicRequired.filter(name => !String(process.env[name] || '').trim());
  const adminMissing = adminRequired.filter(name => !String(process.env[name] || '').trim());

  let adminOk = false;
  let adminError = '';
  try {
    if (!adminMissing.length) {
      adminServices();
      adminOk = true;
    }
  } catch (error) {
    adminError = error.message;
  }

  const projectAligned = Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_PROJECT_ID &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === process.env.FIREBASE_PROJECT_ID
  );
  const databaseAligned = Boolean(
    normalizedUrl(process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL) &&
    normalizedUrl(process.env.FIREBASE_DATABASE_URL) &&
    normalizedUrl(process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL) === normalizedUrl(process.env.FIREBASE_DATABASE_URL)
  );

  const configAligned = projectAligned && databaseAligned;
  const ok = publicMissing.length === 0 && adminMissing.length === 0 && adminOk && configAligned;

  return sendJson(res, ok ? 200 : 503, {
    ok,
    service: 'podmen-x',
    firebaseWeb: { configured: publicMissing.length === 0, missing: publicMissing },
    firebaseAdmin: { configured: adminOk, missing: adminMissing, error: adminOk ? undefined : adminError },
    firebaseAlignment: { projectId: projectAligned, databaseUrl: databaseAligned },
    appCheckEnforced: String(process.env.ENFORCE_APP_CHECK || '').toLowerCase() === 'true',
  });
}
