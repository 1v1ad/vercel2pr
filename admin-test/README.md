# Admin API Tester (static page)

Простая HTML-страница для проверки /api/admin/* на бэкенде.

## Как использовать
1. Положи папку `admin-test/` в корень фронта (или открой локально).
2. Открой `admin-test/index.html` в браузере.
3. Введи Backend URL и Admin Password (или зашей URL по умолчанию в константу `DEFAULT_BACKEND` внизу HTML).

Кнопки выполняют запросы:
- Health → `GET /api/admin/health`
- Summary → `GET /api/admin/summary`
- Users → `GET /api/admin/users?take=&skip=&search=`
- Events → `GET /api/admin/events?take=&skip=&type=&user_id=`

Пароль передаётся через заголовок `X-Admin-Password`. URL/пароль сохраняются в localStorage.
