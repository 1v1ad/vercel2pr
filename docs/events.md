# GGRoom — события (канон)

## Таблица `events`
Колонки:
- `id serial primary key`
- `user_id integer` — внутренний id пользователя (может быть NULL, если нет связи)
- `hum_id bigint` — HUM-группа (coalesce(hum_id, id))
- `event_type varchar(64)` — **каноничное имя события**
- `payload jsonb` — доп. данные (старые записи)
- `amount bigint` — числовое значение (для пополнений/списаний)
- `meta jsonb` — метаданные (`{ comment, admin_id, source, ... }`)
- `ip text`, `ua text`, `created_at timestamp`

Индексы: `events(event_type)`, `events(user_id)`, `events(created_at)`.

## Каноничные события
- `login_success` — успешный логин (любой провайдер)
- `auth_success` — успешная авторизация/рефреш
- `profile_link_start` / `profile_link_done`
- `admin_topup` — **ручное пополнение админом**
- `balance_adjust` — любые сервисные корректировки баланса
- `user_created` — регистрация

## `admin_topup`
- Пишется в `events` строчка:
  ```sql
  insert into events (user_id, hum_id, event_type, ip, ua, created_at, amount, meta)
  values ($user_id, $hum_id, 'admin_topup', $ip, $ua, now(), $amount, jsonb_build_object('comment',$comment,'admin_id',$admin_id));
