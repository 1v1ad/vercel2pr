# VK Auth Backend (Express)

- VK ID OAuth 2.1 (Authorization Code + PKCE) with **server-side** token exchange.
- Stores users in **Postgres (Neon)**.
- Issues **HttpOnly** session cookie `sid` on the backend domain.

## ENV
See `.env.example`. Critical:
- `VK_REDIRECT_URI` must be EXACTLY the one in VK app settings.
- `FRONTEND_URL` is your Netlify URL (CORS + post-login redirect).
- `DATABASE_URL` must include `sslmode=require` for Neon.

## Render
- Runtime: Node 18+
- Build Command: `npm ci`
- Start Command: `npm start`

(Миграций нет — таблицы создаются автоматически при старте.)

## Endpoints
- `GET /api/auth/vk/start` → sets `state` + `code_verifier` cookies, redirects to `id.vk.com/authorize`.
- `GET /api/auth/vk/callback` → exchanges `code` (+`device_id`) for tokens, creates/updates user, sets `sid` cookie, redirects to `FRONTEND_URL?logged=1`.
- `GET /api/me` → returns user based on `sid` cookie.
- `GET /health` → healthcheck.
