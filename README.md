# Prisma Admin Backend (feature/prisma-admin)

Минимальный backend на Express + Prisma с фича-флагом админки.

## Быстрый старт локально
```bash
cp .env.example .env
npm i
npx prisma generate
node server.js
# или
npm run dev
```
Открой `http://localhost:3001/healthz`

Админ-роуты (пример):
```
GET /api/admin/health
GET /api/admin/users?skip=0&take=50
GET /api/admin/transactions?skip=0&take=50
GET /api/admin/summary
```
Добавляй заголовок:
`X-Admin-Password: <ADMIN_PASSWORD>`

## Render
Build Command:
```
npm ci && npm run migrate:deploy || true
```
Start Command:
```
npm start
```
Environment:
- FEATURE_ADMIN=true
- ADMIN_PASSWORD=<задай>
- DATABASE_URL=file:./dev.db (для быстрого стендапа) или postgres://...

> Важно: на Free Render SQLite-файл не сохраняется между рестартами. Для продакшена используй PostgreSQL (Neon/Render PG).
