# VK Auth Backend (Express)

- VK ID OAuth 2.1 (Authorization Code + PKCE) with **server-side** token exchange.
- Stores users in **Postgres (Neon)** via `pg` (requires `DATABASE_URL` with `sslmode=require`). Falls back to SQLite locally if
  `DATABASE_URL` is not provided.
- Issues **HttpOnly** session cookie `sid` on the backend domain.

## ENV
See `.env.example`. Critical:
- `VK_REDIRECT_URI` must be EXACTLY the one in VK app settings.
- `FRONTEND_URL` is your Netlify URL (CORS + post-login redirect).
- `DATABASE_URL` must include `sslmode=require` for Neon (example: `postgres://<user>:<pass>@<host>/<db>?sslmode=require`).

## Render
- Runtime: Node 18+
- Build Command: `npm ci`
- Start Command: `npm start`

### Local/Postgres setup

```bash
npm ci
DATABASE_URL="postgres://user:pass@ep-example.neon.tech/mydb?sslmode=require" npm run migrate
DATABASE_URL="postgres://user:pass@ep-example.neon.tech/mydb?sslmode=require" npm run backfill
```

The migrate script runs SQL files from `migrations/postgres/` in order. The backfill script populates `cluster_id`/
`primary_user_id` for already linked accounts and logs `merge_auto` events. Both commands are safe to re-run.

## Endpoints
- `GET /api/auth/vk/start` → sets `state` + `code_verifier` cookies, redirects to `id.vk.com/authorize`.
- `GET /api/auth/vk/callback` → exchanges `code` (+`device_id`) for tokens, creates/updates user, sets `sid` cookie, redirects to `FRONTEND_URL?logged=1`.
- `GET /api/me` → returns user based on `sid` cookie.
- `GET /health` → healthcheck.
