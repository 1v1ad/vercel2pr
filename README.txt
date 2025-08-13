GGRoom backend (Auth + Admin + Health) — готов к Render

Файлы:
- server.js
- src/routes/auth.js  — VK PKCE S256 (устойчиво к «сну» Render)
- src/routes/admin.js — summary/users/events
- src/middleware/admin.js
- src/routes/health.js
- package.json

ENV (Render → Environment):
FRONTEND_URL=https://sweet-twilight-63a9b6.netlify.app
FEATURE_ADMIN=true
ADMIN_PASSWORD=<пароль>
# один из двух точно должен быть (можно оба):
JWT_SECRET=<длинная строка>
# COOKIE_SECRET=<необязателен, если есть JWT_SECRET>
VK_CLIENT_ID=54008517
VK_CLIENT_SECRET=<из VK>
VK_REDIRECT_URI=https://vercel2pr.onrender.com/api/auth/vk/callback
PORT=30014

Build/Start command (Render):
- Build:  npm ci
- Start:  node server.js

Проверка:
1) GET /api/health → ok:true
2) GET /api/auth/vk/start → открывается VK без ошибки code_challenge
3) GET /api/admin/summary c X-Admin-Password → 200 JSON
