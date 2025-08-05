# vercel2pr-backend

## 1. Установка

npm install

shell
Копировать
Редактировать

## 2. Миграция БД

npx prisma migrate deploy

shell
Копировать
Редактировать

## 3. Запуск

npm start

markdown
Копировать
Редактировать

## 4. Переменные окружения

Создайте файл `.env` на основе `.env.example` и укажите ваши значения.

## 5. Деплой на render.com

- Укажите Build command: `npm install && npx prisma migrate deploy`
- Start command: `npm start`
- Установите env переменные:
    - JWT_SECRET (любое длинное значение)
    - VK_CLIENT_ID и VK_CLIENT_SECRET (из VK приложения)

## 6. Основные endpoint-ы

- POST `/api/auth/vk-callback` — авторизация VK
- GET `/api/user/profile` — получить профиль пользователя
- ... (дополняется)
