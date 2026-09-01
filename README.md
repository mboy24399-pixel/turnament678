# Podmen X Tournament Arena

Firebase-backed tournament web app for Vercel.

## Player app

- Tournament discovery and search
- Open/live/upcoming/completed filters
- Registration with capacity checks
- Player profile and game ID
- Personal match feed
- Leaderboard
- Wallet read-only view
- Announcements/notifications hooks

## Admin app

Open `/admin.html` after deployment.

Admin access uses Firebase Email/Password authentication plus an `admins/{uid}: true` flag in Realtime Database. Admins can publish/close tournaments, record match results, and publish announcements.

## Firebase / Vercel

Set these seven **Production** environment variables in Vercel:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_DATABASE_URL`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

The values come from Firebase Console → Project settings → Your apps → Web app configuration.

Do **not** commit a Firebase service-account/Admin SDK JSON. The browser uses the Firebase Web SDK; `/api/firebase-config` reads the seven Vercel variables at request time.

## Database rules

`firebase.database.rules.json` contains the intended Realtime Database security model:

- Players can read public tournament/match/leaderboard/announcement data after anonymous sign-in.
- Players can write only their own profile and registration.
- Wallet writes, match writes, tournament management and announcements are admin-only.
- Admin access is controlled by `admins/{uid}`.

Apply the rules in Firebase Console → Realtime Database → Rules before using the production data store.

## Health check

Open `/api/health` after deployment. HTTP 200 with `ok: true` means all seven Firebase variables are present. `/api/firebase-config` returns only the Firebase Web configuration and never a service-account key.
