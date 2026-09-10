function clean(value) {
  return String(value ?? '').trim();
}

function normalizeDatabaseUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    if (!/(?:^|\.)firebaseio\.com$/.test(url.hostname) && !/(?:^|\.)firebasedatabase\.app$/.test(url.hostname)) return '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const config = {
    apiKey: clean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
    authDomain: clean(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    databaseURL: normalizeDatabaseUrl(process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL),
    projectId: clean(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    storageBucket: clean(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: clean(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID),
    appId: clean(process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
    recaptchaSiteKey: clean(process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY),
    appCheckEnabled: String(process.env.ENFORCE_APP_CHECK || '').toLowerCase() === 'true',
  };

  const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  const missing = required.filter(key => !config[key]);
  if (missing.length) {
    return res.status(503).json({ ok: false, error: 'Firebase configuration is incomplete or invalid', missing });
  }
  if (config.appCheckEnabled && !config.recaptchaSiteKey) {
    return res.status(503).json({ ok: false, error: 'App Check is enforced but the public reCAPTCHA Enterprise site key is missing', missing: ['recaptchaSiteKey'] });
  }

  return res.status(200).json({ ok: true, ...config });
}
