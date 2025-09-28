GGRoom backend (Auth + Admin + Health) — Render + Neon setup
=============================================================

Основные шаги:

1. Создай базу в Neon и возьми `DATABASE_URL` (с `sslmode=require`).
2. На Render в Environment поставь:
   - `DATABASE_URL=<из Neon>`
   - `ADMIN_PASSWORD=<придумай>`
   - `JWT_SECRET=<длинная случайная строка>`
   - `VK_CLIENT_ID` / `VK_CLIENT_SECRET` / `VK_REDIRECT_URI`
   - `FRONTEND_URL=https://sweet-twilight-63a9b6.netlify.app`
3. Build command: `npm ci`
4. Start command: `node server.js`
5. После деплоя выполни в Render shell:
   ```
   npm run migrate
   npm run backfill
   ```
6. Смоук-тест:
   - `POST /admin/topup` с `X-Admin-Password`/Bearer и body `{"userId": 1, "amount": 123.9}` → округление до 123 рублей, событие `balance_update`.
   - `GET /api/admin/health` → 200 JSON.

Локально можно запускать без Postgres — тогда используется SQLite (`./data.sqlite`), но прод и стейдж обязаны работать только с Postgres.
