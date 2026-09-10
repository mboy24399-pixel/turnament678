# Podmen X Tournament Arena

Production-oriented Firebase Realtime Database + Vercel tournament web app. This repository is the tournament system target.

**Player app:** `/user.html` · **Admin panel:** `/admin.html` · **Health:** `/api/health` · **Runtime probe:** `/api/runtime`

## Included

- Real-time tournament discovery, search and status filters
- Server-authorized tournament entry with coin deduction
- Server-authorized task rewards and wallet ledger entries
- Real-time matches and player match feed
- Admin-controlled tournaments, tasks, coin adjustments, results, announcements, notifications and ad configuration
- Firebase Email/Password admin authentication
- Google player authentication for protected actions
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

Required (Firebase Console → Project Settings → General → Your apps → Web app):

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_DATABASE_URL`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`

Optional:

- `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`

### Server-only Admin SDK configuration (never expose)

Required (Firebase Console → Project Settings → Service accounts → Generate new private key):

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (keep `\n` newlines, keep the quotes)
- `FIREBASE_DATABASE_URL` (same value as the public database URL)

### Bootstrap admin + hardening (optional)

- `ADMIN_UIDS` — comma-separated Firebase Auth UIDs treated as admin before `/admins/{uid}` exists
- `APP_CHECK_ENFORCE` — `true` to require an `x-firebase-appcheck` header on `/api/command`
- `RECAPTCHA_ENTERPRISE_KEY`, `ALLOWED_ORIGINS`

See `.env.example` for the full template.

## Setup (step by step)

1. **Firebase project**
   - Create a project at https://console.firebase.google.com
   - Build → Realtime Database → Create database (choose region, start in locked mode)
   - Build → Authentication → Sign-in method → enable **Google** and **Email/Password**
   - Project Settings → General → Add a **Web app** → copy the config values
   - Project Settings → Service accounts → **Generate new private key** (server only!)
2. **Security rules**
   - Realtime Database → Rules → paste `firebase-database.rules.json` → Publish
3. **Deploy to Vercel**
   - Push this folder to GitHub, Import in Vercel (no framework, no build command needed)
   - Settings → Environment Variables → add all variables above → **Redeploy**
4. **First admin**
   - Create your admin user: Firebase Console → Authentication → Add user (email/password)
   - Copy its UID → set `ADMIN_UIDS=<uid>` in Vercel → Redeploy
   - Login at `/admin.html` → Users → *Make admin* (writes `/admins/{uid}=true`, permanent)
5. **Verify**
   - Open `/api/health` — public config OK + Admin SDK connected
   - Open `/user.html` — login with Google, join a tournament, claim a task
   - Open `/admin.html` — create tournament → declare result → prize auto-credits

## Project structure

| Path | Purpose |
|---|---|
| `index.html` | Landing page, routes player entry to the tournament app |
| `user.html` / `app.js` | Player app: discovery, join, tasks, matches, wallet, alerts |
| `admin.html` / `admin.js` | Admin panel: brackets/matches, tasks + verification, coins, results, push, ads |
| `styles.css` | Tournament platform UI system |
| `api/command.js` | Trusted backend: all coin/entry/task/match/admin writes |
| `api/health.js` | Public-config + Admin-SDK health check (also serves public web config) |
| `api/runtime.js` | Serverless runtime probe (booleans only, no secrets) |
| `api/_admin.js` | Shared Admin SDK init, auth, CORS, rate-limit helpers |
| `firebase-database.rules.json` | Locked-down rules (client writes disabled for privileged data) |
| `vercel.json` | Security headers + CSP (no `runtime` key — auto-detected) |
| `404.html` | Friendly static 404 page |

## Notes

- `npm run build` runs production syntax checks (`node --check` on every JS file).
- Match room IDs/passwords are only rendered to players who joined that tournament.
- `APP_CHECK_ENFORCE=true` currently enforces token *presence*; wire reCAPTCHA Enterprise verify API for full cryptographic checks.
