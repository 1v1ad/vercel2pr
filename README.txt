GG ROOM static bundle
======================

Куда класть
-----------
Файлы предполагают, что Netlify/хостинг отдает корень репозитория как `/`.
Пути в HTML — **абсолютные** (`/js/app.js`, `/js/vk-logo.svg`, `/js/prize-chest-700w.webp`).

Если у тебя Publish directory = `public`, перенеси ВСЁ содержимое архива внутрь `public/`.
Абсолютные пути продолжат работать.

Что внутри
----------
- index.html — экран входа. VK-кнопка и Telegram-виджет. Скрипт `/js/app.js`.
- lobby.html — простое лобби, читает пользователя из `localStorage`.
- js/app.js — логика авторизации:
  - дергает `${BACKEND_URL}/api/auth/vk/start`
  - обрабатывает `?vk=ok|error`
  - `onTelegramAuth(user)` шлет на `${BACKEND_URL}/api/auth/telegram`
- js/vk-logo.svg — иконка VK
- js/prize-chest-700w.webp — картинка сундука (заглушка)

Настройки
---------
По умолчанию BACKEND_URL выбирается автоматически.
- Для домена `*.netlify.app` — `https://vercel2pr.onrender.com`
- Иначе — текущий домен.

Чтобы задать вручную, добавь в `<head>` index.html:
  <script>window.BACKEND_URL="https://vercel2pr.onrender.com"</script>

