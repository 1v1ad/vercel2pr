GGRoom Admin Add-on (Frontend + Backend)
==========================================

Что внутри
----------
- frontend/admin.html — простая админка (одна страница)
- frontend/admin.js, admin.css — логика и стиль
- backend/src/routes/admin.js — новые роуты админки для Express + Prisma
- backend/src/middleware/adminAuth.js — JWT-проверка роли admin

Требования
----------
- Бэкенд: Node.js + Express, Prisma подключён к PostgreSQL (Neon)
- ENV на бекэнде:
  - FRONTEND_URL=https://sweet-twilight-63a9b6.netlify.app
  - JWT_SECRET=<длинная_случайная_строка>
  - DATABASE_URL=<ваш Neon connection string>
  - ADMIN_PASSWORD=<пароль_админа>

Интеграция (backend)
--------------------
1) Скопируйте файлы:
   - backend/src/routes/admin.js  -> в ваш проект в ту же структуру
   - backend/src/middleware/adminAuth.js -> в ваш проект

2) В вашем server.js (или app.js) ДОБАВЬТЕ строку подключения роутов:
   app.use('/api/admin', require('./src/routes/admin'));

   (Остальной код не трогаем.)

3) Убедитесь, что CORS разрешает ваш фронтенд домен из ENV FRONTEND_URL.
   Для админки домен тот же Netlify — отдельной настройки не требуется.

4) Задеплойте бекэнд на Render.

Интеграция (frontend)
---------------------
1) Положите файлы из папки frontend рядом с вашим текущим фронтом на Netlify.
   Например, в /admin/ (если у вас билдовщик, добавьте копирование этих файлов в public).

2) Откройте https://<ваш-netlify-домен>/admin.html
   При первом запуске админка спросит URL бекэнда (если не удалось определить),
   например: https://vercel2pr.onrender.com
   Этот URL сохранится в localStorage.

3) Введите ADMIN_PASSWORD и войдите. Токен хранится в localStorage (12ч).

Метрики
-------
- Пользователи: общее количество
- Новые за 7 дней
- Активные за 24 часа (был любой Transaction)
- Сумма балансов (sum(User.balance))
- Операции: агрегаты по типам (deposit / withdraw / win / lose / bonus)

Замечания
---------
- Сумма отображается в копейках -> приводим к ₽ с 2 знаками.
- Если структура ваших таблиц отличается от примера в README проекта, 
  поправьте запросы в admin.js/admin.js (backend).
- При необходимости можно добавить ADMIN_USERNAME и проверять пару логин+пароль.

Безопасность
------------
- Держите ADMIN_PASSWORD в секрете. Меняйте регулярно.
- Можно добавить списки IP (защита на уровне прокси/Render), 2FA, аудит логов.
