export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Standard names are preferred. Legacy aliases are accepted so an
  // existing Vercel setup does not break while the variables are renamed.
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain:
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
      process.env.NEXT_PUBLIC_FIREBASE_H_DOMAIN,
    databaseURL:
      process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
      process.env.NEXT_PUBLIC_FIREBASE_BASE_URL,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_BUCKET,
    messagingSenderId:
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
      process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value || !String(value).trim())
    .map(([key]) => key);

  if (missing.length) {
    res.status(500).json({
      error: 'Firebase configuration is incomplete',
      missing,
    });
    return;
  }

  res.status(200).json(config);
}
