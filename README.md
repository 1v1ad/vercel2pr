# GGRoom Auth+Link Backend

Express + Postgres service that accepts VK and Telegram login events and performs *background account linking* via a signed device cookie (`aid`).

## Endpoints
- `POST /api/log-auth` — body: `{ userId, action, timestamp, userData }` where `userData.provider` is `vk` or `telegram`.
  - For Telegram, the signature is verified with `TELEGRAM_BOT_TOKEN`.
  - On first request, backend sets a signed `aid` cookie tying the device to the merged user.
- `GET /api/me` — returns `{ user, identities[] }` for the device bound by the `aid` cookie.
- `GET /api/health` — liveness check.

## Tables
- `users`, `identities(provider, provider_user_id)`, `device_links(aid → user_id)`, `user_actions`, `link_audit`.
The service creates them on start (requires `pgcrypto` extension — enabled automatically).

## Deploy (Render)
1. Create a **Web Service** (Node).
2. Set **Start Command**: `node server.js`
3. Environment:
   - `DATABASE_URL` (Neon / Render PG)
   - `PORT=3001`
   - `AID_SECRET=<long random>`
   - `CORS_ORIGINS=https://<your-netlify-app>.netlify.app`
   - `TELEGRAM_BOT_TOKEN=<from @BotFather>`
4. Redeploy. Test: `GET /api/health` and `GET /api/me`.
