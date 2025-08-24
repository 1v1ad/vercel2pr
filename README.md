# VK + TG Auth (reference)

Файлы в этой папке — «эталонная» сборка бэкенда с двумя провайдерами:
- VK ID (через `id.vk.com` + fallback на `oauth.vk.com`)
- Telegram Login Widget

## Важные ENV
- `JWT_SECRET` — любой длинный секрет (рекомендуется 64-символов)
- `VK_CLIENT_ID`
- `VK_CLIENT_SECRET`
- `VK_REDIRECT_URI` — должен побайтно совпадать с настройкой Redirect URI в VK
- `FRONTEND_URL` — базовый URL фронта (для финального редиректа)
- `TELEGRAM_BOT_TOKEN` — токен бота

## Маршруты
- `GET /api/auth/vk/start` → редирект на VK
- `GET /api/auth/vk/callback?code=...&state=...` → обмен кода на токен, установка cookie `sid`
- `ALL /api/auth/tg/callback` → проверка хэша Telegram, редирект на фронт
- `GET /api/me` → простая проверка cookie-сессии

## Примечания
- В cookies для state/PKCE используются `SameSite=Lax`, `Secure`, `HttpOnly`.
- Сессионная cookie `sid` — `SameSite=None`, `Secure` и `HttpOnly`.
- На странице VK возможны 429 на их Sentry — не влияет на поток авторизации.
