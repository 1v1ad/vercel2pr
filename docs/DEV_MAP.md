# GGRoom — DEV MAP (что за что отвечает)

## Backend (vercel2pr)
- `server.js` — сборка приложения, монтирование роутов, CORS/cookies/geoip, `ensureTables()`.
  - [GG:SECTION mounts] Подключение: `/api/public`, `/api/admin`, `/api/auth`, `/api/tg`, `/api/link`, `/api/profile-link`.
- `src/db.js` — пул PG + миграции `ensureTables()`, `logEvent()`, `updateUserCountryIfNull()`, базовые admin‑операции.
- `src/routes_admin.js`
  - [GG:API GET /api/admin/stats] краткие метрики.
  - [GG:API GET /api/admin/range] дневные ряды (`?analytics=1` добавляет `auth_unique_analytics`).
  - [GG:API GET /api/admin/cluster] состав HUM‑кластера.
  - [GG:API POST /api/admin/unmerge] расклейка user_ids внутри HUM.
  - [GG:API GET /api/admin/merge_suggestions] аналитические предложения.
  - [GG:API POST /api/admin/merge_apply] ручная склейка.
  - Алиасы: `/users/merge/suggestions`, `/users/merge` → совместимость старой админки.
- `src/merge.js`
  - `autoMergeByDevice()` — безопасная автосшивка без меж‑юзерного мерджа.
  - `mergeSuggestions()` — кандидаты для склейки (VK‑первичность/устройство/аккаунт).
  - `adminMergeUsersTx()` — транзакционная склейка.
- `src/linking.js` — сбор device_id, safe‑линковка аккаунтов к текущему user_id.
- `src/routes_link.js` — `POST /api/link/bind` сохраняет `device_id` и триггерит `autoMergeByDevice`.
- `src/routes_public.js` — `/api/me` с HUM‑балансом (канонический пользователь).
- `src/routes_auth.js`, `src/routes_tg.js` — VK/TG авторизация, события.
- `src/routes_profile_link.js` — токен‑линковка профилей.
- `migrations/` — SQL‑миграции (если присутствуют).

## Frontend (vercel2)
- `gg-linker.js` — фон: генерирует стабильный `device_id` → `/api/link/bind`.
- `index.html`, `lobby.html` — подключение `gg-linker.js`; виджеты VK/TG.
- `admin/index.html`
  - [GG:ANCHOR admin-proposals-actions] — тут кнопка «Ручная расклейка».
  - Чекбокс «учесть аналитику» для графиков.
  - «Уникальные (7д)» + строка «с учетом аналитики».
- `admin/chart-range.js` — дергает `/api/admin/range`, учитывает `analytics=1`, рисует серии.
- `admin/chart.js` — заполняет summary‑блоки, подхватывает «с учетом аналитики».
- `admin/admin-auth-headers.js` — подставляет `X-Admin-Password` в /api/admin‑запросы.