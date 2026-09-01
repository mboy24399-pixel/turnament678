export default function handler(req, res) {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '';
  const databaseURL = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
    (projectId ? `https://${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app` : '');

  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_H_DOMAIN || '',
    databaseURL,
    projectId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_BUCKET || '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID || '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || process.env.NEXT_PUBLIC_FIREBASE_OBJECT_ID || ''
  };

  const missing = Object.entries(config)
    .filter(([key, value]) => !value && key !== 'databaseURL')
    .map(([key]) => key);

  if (missing.length) {
    return res.status(500).json({ error: 'Firebase client configuration is incomplete', missing });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(config);
}
