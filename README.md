# VK Auth Backend (Express)

- VK ID OAuth 2.1 (Authorization Code + PKCE) with **server-side** token exchange.
- Stores users in **Postgres (Neon)** with a local SQLite fallback (if `DATABASE_URL` is not set).
- Issues **HttpOnly** session cookie `sid` on the backend domain.

## ENV
See `.env.example`. Critical:
- `VK_REDIRECT_URI` must be EXACTLY the one in VK app settings.
- `FRONTEND_URL` is your Netlify URL (CORS + post-login redirect).
- `DATABASE_URL` — Postgres connection string (for Neon use `sslmode=require`, e.g. `postgresql://user:pass@host/db?sslmode=require`).
- Without `DATABASE_URL` the server will start with SQLite for local development only.

## Render
- Runtime: Node 18+
- Build Command: `npm ci`
- Post-deploy Command: `npm run migrate && npm run backfill`
- Start Command: `npm start`

`npm run migrate` applies SQL migrations from `migrations/postgres/` and `npm run backfill` fills `cluster_id`/`primary_user_id` for merged accounts. Both scripts are idempotent and safe to run multiple times.

## Endpoints
- `GET /api/auth/vk/start` → sets `state` + `code_verifier` cookies, redirects to `id.vk.com/authorize`.
- `GET /api/auth/vk/callback` → exchanges `code` (+`device_id`) for tokens, creates/updates user, sets `sid` cookie, redirects to `FRONTEND_URL?logged=1`.
- `GET /api/me` → returns user based on `sid` cookie.
- `GET /health` → healthcheck.
