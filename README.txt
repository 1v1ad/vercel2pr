Админ-патч v3 (стабильный)
Файлы:
- server.js
- src/middleware_admin.js
- src/routes_admin.js
- src/routes_health.js

ENV на Render (Dashboard → Environment):
FEATURE_ADMIN=true
ADMIN_PASSWORD=<пароль для админки>
FRONTEND_URL=https://sweet-twilight-63a9b6.netlify.app
JWT_SECRET=<если используется>
DATABASE_URL=<если используется>
VK_CLIENT_ID=...
VK_CLIENT_SECRET=...
VK_REDIRECT_URI=https://vercel2pr.onrender.com/api/auth/vk/callback
PORT=3001  # можно любой

Проверка после деплоя:
1) https://vercel2pr.onrender.com/api/health  → ok:true и флаги.
2) curl https://vercel2pr.onrender.com/api/admin/summary -H "X-Admin-Password: <пароль>" → 200 JSON.
3) В админке (на фронте): Backend=https://vercel2pr.onrender.com, Пароль=<тот же> → «Проверка».
