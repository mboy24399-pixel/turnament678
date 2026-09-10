# Arena X — E-Sport Tournament System (v2)

Complete secure rebuild of the E-Sport tournament app: player app + admin panel +
server-authorized game backend on Firebase Realtime Database + Vercel.

**🔒 Zero-secrets repo:** no Firebase keys, no tokens, no ad links in this repository.
The browser fetches its public config at runtime from `/api/config` (Vercel env vars).

- **Player app:** `/index.html` — login/signup + referral, home + promos + games +
  my contests, tournament tabs + search, ticket wallet, watch-ad earn (cooldown +
  daily cap enforced on server), earnings, leaderboard, profile + themes, recharge
  (UPI + UTR), match chat, room ID/password, notifications, policies.
- **Admin panel:** `/admin.html` — first-time setup, dashboard + charts, games,
  promotions, tournaments, match control (room + players + winners auto-pay),
  leaderboard mgmt, users (adjust / block / detail / PDF), analytics,
  notifications, transactions, withdrawals / recharges / referrals approval queues,
  theme, settings, audit log + health.
- **Backend:** `/api/command` — every ticket movement verified on the server
  (atomic transactions, bonus-first entry debit, idempotent joins).
- **Health:** `/api/health` · **Runtime:** `/api/runtime` · **Config:** `/api/config`

## Security model

- Browser NEVER holds secrets. Service-account key lives only in Vercel env.
- Tickets/bonus/earnings/ranks cannot be written from the client (rules enforce
  equality unless the writer is the designated admin UID).
- Joins, ad rewards (cooldown + daily cap), withdrawals (balance lock + refund on
  reject), recharges, referral bonuses and winner payouts run in `/api/command`
  after Firebase ID-token verification; admin actions additionally require
  `adminConfig/adminUid` (or `ADMIN_UIDS` bootstrap).
- Rate limiting + audit log on every privileged action.
- Security headers + strict Content-Security-Policy in `vercel.json`.

## Environment variables (Vercel → Settings → Environment Variables)

Public (served via `/api/config`): `NEXT_PUBLIC_FIREBASE_API_KEY`,
`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_DATABASE_URL`,
`NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
`NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
(+ optional `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`).

Server-only: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `FIREBASE_DATABASE_URL`.

Optional: `ADMIN_UIDS` (bootstrap admins), `APP_CHECK_ENFORCE`, `ALLOWED_ORIGINS`.

See `.env.example`.

## Setup

1. Firebase: create project → Realtime Database (locked mode) → Auth: enable
   **Email/Password** + **Google** → Web app config → Service-account key.
2. Database → Rules → paste `firebase-database.rules.json` → Publish.
3. Push this folder to GitHub → Import in Vercel → add env vars → Deploy.
4. Open `/admin.html`: first login runs **one-time setup** (you become admin).
   (Or pre-set `ADMIN_UIDS` in Vercel and redeploy.)
5. Admin → Dashboard → **Seed demo data** → create games/tournaments → play!

## Structure

| Path | Purpose |
|---|---|
| `index.html`, `assets/css/user.css`, `assets/js/user-app.js` | Player app |
| `admin.html`, `assets/css/admin.css`, `assets/js/admin-app.js` | Admin panel |
| `assets/js/boot.js` | Secure boot: runtime config + Firebase init, zero keys |
| `api/command.js` | Trusted game logic (joins, tickets, payouts, admin ops) |
| `api/config.js` | Runtime public-config endpoint |
| `api/health.js`, `api/runtime.js`, `api/_admin.js` | Health, probe, shared helpers |
| `firebase-database.rules.json` | Hardened rules (client balance writes denied) |
| `vercel.json` | Headers + CSP + rewrites |

`npm run build` runs syntax checks on every JS file.
