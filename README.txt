Полный патч backend (auth + admin + health)

- server.js — монтирует: /api/auth, /api/admin, /api/health
- src/routes_auth.js — маршруты VK: GET /api/auth/vk/start и GET /api/auth/vk/callback (PKCE в HttpOnly куке)
- src/routes_admin.js — summary/users/events
- src/middleware_admin.js — проверка X-Admin-Password
- src/routes_health.js — проверка окружения

ENV (Render → Environment):
FRONTEND_URL=https://sweet-twilight-63a9b6.netlify.app
FEATURE_ADMIN=true
ADMIN_PASSWORD=<пароль для админки>
JWT_SECRET=<длинная строка>
COOKIE_SECRET=<длинная строка для подписывания временных кук>
VK_CLIENT_ID=<из VK>
VK_CLIENT_SECRET=<из VK>
VK_REDIRECT_URI=https://vercel2pr.onrender.com/api/auth/vk/callback
PORT=3001

Тесты:
1) /api/health — ok:true
2) /api/auth/vk/start — открывает страницу VK
3) /api/admin/summary — 200 JSON при заголовке X-Admin-Password
