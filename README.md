# VK Auth Backend (Express)

Backend for VK/TG auth flows with Postgres (Neon) storage and admin tooling.

## Stack

- **Express** + cookies for session handling.
- **Postgres** via [`pg`](https://www.npmjs.com/package/pg) (Neon-compatible).
- SQLite is supported only as a local development fallback when `DATABASE_URL` is not set.

## Environment variables

Configure `.env` (see `.env.example`):

- `DATABASE_URL=postgresql://...` — required in staging/production (Neon). Include `sslmode=require` for Neon.
- `ADMIN_PASSWORD=...` — password for `/admin/*` endpoints.
- `JWT_SECRET=...` — used to sign the `sid` cookie.
- `VK_CLIENT_ID`, `VK_CLIENT_SECRET`, `VK_REDIRECT_URI` — VK OAuth settings.
- `FRONTEND_URL` — UI base URL (CORS + redirects).

## Local development

```bash
npm install
npm run dev
```

Without `DATABASE_URL` the server spins up with a SQLite database in `./data.sqlite` (auto-migrated). Use Postgres for every deploy.

## Database migrations

Postgres schema is managed via SQL migrations in `migrations/postgres`.

```bash
npm run migrate      # apply migrations
npm run backfill     # fill cluster_id/primary_user_id + merge_auto events
```

Both commands expect `DATABASE_URL` to point to Postgres. If it is missing they exit successfully without touching the database (handy for local dev without Postgres).

## Deploy to Render + Neon

1. Provision a Neon Postgres database and copy its connection string with `sslmode=require`.
2. In Render service settings set environment variables:
   - `DATABASE_URL=<neon-connection-string>`
   - `ADMIN_PASSWORD=<your-admin-password>`
   - `JWT_SECRET=<strong-secret>`
   - plus VK/TG settings from the previous section.
3. Build command: `npm ci`
4. Start command: `npm start`
5. After first deploy (and every schema change):
   ```bash
   npm run migrate
   npm run backfill
   ```
   Run these from the Render shell or via deploy hooks.

## Admin top-up API

`POST /admin/topup` with header `Authorization: Bearer <ADMIN_PASSWORD>`.

Body:

```json
{ "userId": 123, "amount": 123.9 }
```

- Amount is converted to integer rubles: positive values are `Math.floor`, negative — `Math.ceil`. Zero is rejected.
- The request resolves the target primary account, updates the balance inside one transaction, and stores a `balance_update` event with metadata (`requested_user_id`, `resolved_user_id`, `delta`, `balance`).

## Events

The backend writes structured events (`auth_success`, `merge_auto`, `merge_manual`, `balance_update`) into the `events` table for auditing.

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) runs `npm ci` + `npm test` on pushes and pull requests.
