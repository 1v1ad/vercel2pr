# GGRoom — Canonical Events

Единый словарь названий событий и обязательных полей.  
Нейминг: `snake_case`. В БД — `events(event_type, …)`. Дата/время — UTC.

## Общие поля события

- `id` — PK (serial/bigserial)
- `event_type` — строка (`login_success`, `admin_topup`, …)
- `type` — дублирование `event_type` для совместимости (может совпадать)
- `hum_id` — основной идентификатор HUM (int) — **обязательно, если известен**
- `user_id` — алиас `hum_id` (для старых путей) — можно копировать `hum_id`
- `provider` — `vk` | `tg` | `web` | `system` (если применимо)
- `pid` — id в провайдере (например, `provider_user_id`) — если применимо
- `ip` — строка IP (если применимо)
- `ua` — User-Agent (если применимо)
- `amount` — число (для финансовых событий; положительное/отрицательное)
- `comment` — текстовое пояснение/примечание
- `payload` — `jsonb` (произвольная структура)
- `created_at` — `timestamptz` (UTC, default now())

> **Правило:** если добавляем новое событие — сначала дополняем этот файл.

---

## Список событий

### Аутентификация
- `auth_start` — начало авторизации (provider, state если есть)
- `login_success` — успешный логин (hum_id, provider, pid)
- `login_error` — ошибка логина (comment: текст/код)

### Линковка аккаунтов (жёсткая, proof)
- `link_request` — пользователь нажал «Связать …»; сохраняем `provider`, `nonce` в cookie  
  - поля: `hum_id` (если уже есть сессия), `provider`, `ip`, `ua`, `payload.state?`
- `link_success` — провайдер успешно привязан к `hum_id`  
  - поля: `hum_id`, `provider`, `pid`, `ip`, `ua`
- `link_conflict` — попытка привязать `pid`, уже принадлежащий другому `hum_id`  
  - поля: `hum_id` (к кому хотели привязать), `provider`, `pid`, `ip`, `ua`
- `link_error` — сбой/исключение при линковке  
  - поля: `comment` (текст ошибки), `ip`, `ua`, опционально `payload`

### Линковка (мягкая, по устройству)
- `link_soft_candidate` — нашли кандидатов по `device_id`  
  - поля: `payload.device_id`, `payload.matches=[hum_id,…]`
- `link_soft_merged` — выполнено мягкое объединение  
  - поля: `hum_id`, `payload.details`

### Пополнение админом
- `admin_topup` — ручное изменение баланса админом
  - **нормализация полей:**
    - `amount` — итоговый дельта-значение (может быть `< 0`)
    - `comment` — комментарий оператора
    - `hum_id`/`user_id` — кому применили
    - `ip`, `ua` — откуда операция
  - **совместимость:** входящий `payload` может содержать дубли (`value`, `sum`, `delta`, `note`, `reason`, `description`). На чтении фронт выбирает:
    - amount: `amount ?? value ?? sum ?? delta ?? 0`
    - comment: `comment ?? note ?? reason ?? description ?? ''`

### Прочее
- `profile_update` — изменение публичного профиля
- `room_create` / `room_join` / `room_leave` — действия в лобби/комнатах (резерв)
- `payment_init` / `payment_success` / `payment_error` — интеграция платёжки

---

## Хранение IP/UA
Для `admin_topup`, `link_*`, `login_*` **обязательно** сохраняем `ip` и `ua`.

---

## Пагинация и выборка
- стандарт: `GET /api/admin/events?take=50&skip=0&event_type=...`
- по умолчанию `take=50`, максимум `take=200`
- сортировка по `created_at desc`

---

## Примеры

### Пример `link_success`
```json
{
  "event_type": "link_success",
  "type": "link_success",
  "hum_id": 97,
  "user_id": 97,
  "provider": "tg",
  "pid": "1650011165",
  "ip": "194.87.115.218",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-11T13:30:43Z"
}
```

### Пример `admin_topup`
```json
{
  "event_type": "admin_topup",
  "type": "admin_topup",
  "hum_id": 97,
  "user_id": 97,
  "amount": 100,
  "comment": "Проверка",
  "ip": "194.87.115.218",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-11T13:40:12Z"
}
```
### link_request
- producer: backend
- when: пользователь нажал «Связать …», создано состояние линковки
- payload: { target: "vk"|"tg", hum_id }
- notes: пишется в /api/profile/link/start

### link_success
- producer: backend
- when: провайдер подтвердил линковку и мы сохранили связь
- payload: { provider: "vk"|"tg", pid: "<provider_user_id>" }

### link_conflict
- producer: backend
- when: обнаружили, что provider_user_id уже привязан к другому HUM
- payload: { provider, pid, conflict_hum }

### link_error
- producer: backend
- when: сбой/невалидное состояние/ошибка колбэка
- payload: { provider, reason }
