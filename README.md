# Podmen

Static Firebase tournament app for Vercel.

## Vercel setup

This repository must be deployed from **mboy24399-pixel/Podmen-**. Do not point the Vercel project at a different repository.

Set these seven **Production** environment variables in the Vercel project:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_DATABASE_URL`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

The values come from Firebase Console → Project settings → Your apps → Web app configuration.

Do **not** commit a Firebase service-account/Admin SDK JSON file. The browser app uses the Firebase Web SDK; the `/api/firebase-config` function reads the seven Vercel environment variables at request time.

## Health check

After deployment, open `/api/health`.

- HTTP 200 with `"ok": true` means all seven variables are present.
- HTTP 503 lists only the missing variable names; it never returns secret values.

Then open `/api/firebase-config`. A valid deployment returns the seven Firebase Web configuration fields. If it returns 404, the deployed Vercel project is not deploying this repository's `/api` directory.
