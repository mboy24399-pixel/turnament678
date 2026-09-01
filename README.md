# Podmen X Tournament Arena

Production-oriented Firebase Realtime Database + Vercel tournament web app. This repository is the tournament system target.

## Included

- Real-time tournament discovery, search and status filters
- Server-authorized tournament entry with coin deduction
- Server-authorized task rewards and wallet ledger entries
- Real-time matches and player match feed
- Admin-controlled tournaments, tasks, coin adjustments, results, announcements, notifications and ad configuration
- Firebase Email/Password admin authentication
- Anonymous player authentication with protected server commands
- Firebase Realtime Database security rules with client writes disabled for privileged data
- Optional Firebase App Check / reCAPTCHA Enterprise enforcement for the custom backend
- Security headers and a content security policy
- Health endpoint that checks both public Firebase configuration and server-only Admin SDK configuration

## Security model

The Firebase Web API key is not a backend authorization secret. Firebase documents that Web API keys do not themselves authorize backend data access; Security Rules and App Check provide that protection.

Coin balances, tournament entry, task rewards, match writes and admin changes are not trusted from the browser. They are processed by `/api/command` after Firebase ID-token verification and, for admin operations, an `admins/{uid}: true` authorization check on the server.

The browser must never receive a Firebase service-account private key.

## Vercel environment variables

### Public Firebase Web configuration

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_DATABASE_URL`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

Optional:

- `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`

### Server-only Firebase Admin configuration

Required for the protected command API:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_DATABASE_URL`

`FIREBASE_PRIVATE_KEY` is sensitive and must be stored as a Vercel sensitive environment variable. When copied from a service-account JSON file, keep the escaped `\\n` line breaks; the server converts them to real newlines.

Optional:

- `ENFORCE_APP_CHECK=true`

Only enable App Check enforcement after the Web app is registered in Firebase App Check with reCAPTCHA Enterprise and the public site key is configured. Otherwise requests will intentionally fail.

## Firebase setup

1. Enable Anonymous authentication for players.
2. Enable Email/Password authentication for the admin account.
3. Create the Realtime Database.
4. Apply `firebase.database.rules.json` in Realtime Database → Rules.
5. Create the first administrator by adding `admins/<ADMIN_UID>: true` from a trusted Firebase Admin environment. The client cannot create admin flags.
6. Generate Firebase service-account credentials and store only the server-side fields in Vercel environment variables.
7. Redeploy after changing Vercel environment variables.

## Admin

Open `/admin.html` after deployment and sign in with an Email/Password Firebase user whose UID is present under `admins`.

Admin capabilities:

- Create and close tournaments
- Set entry coins, capacity, schedule, prize and rules
- Create and remove tasks with coin rewards
- Grant or deduct coins with a ledger reason
- Record official match results and winner points
- Publish announcements and notifications
- Configure supported ad provider identifiers
- Review player profiles

## Ads

The application has an ad configuration layer and a safe Google AdSense integration. It deliberately does not execute arbitrary JavaScript supplied from the database. Other ad networks require their official SDK, account identifiers and CSP allow-list entries; no honest implementation can guarantee that every ad network will work without those network-specific credentials and policies.

## Production verification

- `/api/health` must return HTTP 200 with `ok: true`.
- The browser must show `● Live` after Firebase authentication.
- Tournament and account data should update without a page refresh.
- Privileged writes should go only through `/api/command`.

No demo balances, fake tournaments or hard-coded production data are included by this repository.
