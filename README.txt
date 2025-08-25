GGRoom – hotfix bundle
-----------------------

Что внутри:
- server.js (в корне) — Express-приложение, монтирует /api/auth и /auth, добавлен алиас /api/auth/tg -> /api/tg.
- src/routes_auth.js — фикс VK ID: правильный POST на https://id.vk.com/oauth2/token + PKCE; убран старый oauth.vk.com/access_token.
- src/tg_alias.js — прокидывает все /api/auth/tg/* на ваш существующий /api/tg/* (чтобы не ломать ТГ).

Как обновить:
1) Заменить файлы в репозитории этими из архива (server.js в корне, остальные в src/).
2) Убедиться в package.json, что есть зависимости: express, cookie-parser, axios, jsonwebtoken.
3) В Render ничего дополнительно менять не нужно (PORT берется из env).

Проверки:
- GET   /api/auth/healthz — ok
- GET   /api/auth/vk/start — редирект на id.vk.com/authorize
- GET   /api/auth/vk/callback?code=...&state=... — обменивает код на токен, ставит cookie sid и редиректит на FRONTEND_URL?auth=ok

Известные причины 401 invalid_grant у VK:
- Неверный redirect_uri при обмене (должен совпадать с тем, что в авторизации и в настройках VK ID).
- Путаница с PKCE: не тот code_verifier (в этом фиксе берется из httpOnly cookie).
- Повторное использование одного и того же code (VK выдает его один раз и на короткое время).

Удачи!
