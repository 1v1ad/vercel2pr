GGRoom — Canonical Events

Единый словарь названий событий и обязательных полей.
Нейминг: snake_case. В БД — events(event_type, …). Дата/время — UTC.

Общие поля события

id — PK (serial/bigserial)

event_type — строка (auth_success, admin_topup, …)

type — дублирование event_type для совместимости (может совпадать)

hum_id — HUM (int) — обязательно, если известен

user_id — актёр (int) — кто совершил событие, см. «Правила канонизации»

provider — vk | tg | web | system (если применимо)

pid — ID в провайдере (например, provider_user_id) — если применимо

ip — строка IP (если применимо)

ua — User-Agent (если применимо)

created_at — timestamptz (по умолчанию now())

Рекомендуемые ключи payload

mode — "login" | "link" — режим вызова обработчика

device_id — если есть (для мягкой склейки)

actor_user_id — явное дублирование актёра (диагностика)

primary_uid — uid из входной сессии (когда происходила привязка)

любые доменные поля (amount, comment, …)

Правила канонизации (актёр и HUM)

Актёр (actor / user_id) на логине:

TG: всегда нативный TG-пользователь users.vk_id = 'tg:<pid>'.
Не использовать auth_accounts.user_id как источник истины.

VK: нативный VK-пользователь (users.vk_id без префикса tg:).

После успешного входа подписывается кука sid именно от лица актёра.

HUM: во всех отчётах уникальность считается по COALESCE(users.hum_id, users.id).
Жёсткая привязка (proof) меняет users.hum_id у второстепенных аккаунтов кластера.

Канонизация логинов в аналитике: login_success ∪ (auth_success, если рядом не было login_success).

Список событий
Аутентификация

auth_start — начало авторизации (provider, state если есть)
payload: { provider, state? }

login_success — успешный логин (исторический/веб-флоу)
payload: { provider, pid }

auth_success — успешный логин/колбэк провайдера (основной сигнал)
user_id = актёр входа (см. правила канонизации)
payload: { provider, pid, mode, actor_user_id?, primary_uid? }

login_error / auth_error — ошибка логина/колбэка
payload: { provider, reason|comment }

Линковка аккаунтов (жёсткая, proof)

link_request — пользователь нажал «Связать …», создано состояние линковки
payload: { target: "vk"|"tg", hum_id }

link_success — провайдер подтвердил линковку (handshake прошёл)
user_id = мастер (текущая сессия на момент клика/колбэка)
payload: { provider: "vk"|"tg", pid }

Важно: это про подтверждение провайдера. HUM может ещё не измениться.

merge_proof — факт изменения HUM (склейка по доказательству)
Пишется там, где реально выставили users.hum_id.
user_id = мастер (к чьему HUM присоединили)
payload: { from_user_id, to_hum_id, method: "proof" }

link_conflict — попытка привязать pid, уже принадлежащий другому HUM
payload: { provider, pid, conflict_hum }

link_error — сбой/невалидное состояние/ошибка колбэка
payload: { provider, reason }

Линковка (мягкая, эвристика: device_id/ip/…)

link_soft_candidate — нашли кандидатов по device_id
payload: { device_id, matches:[hum_id,…] }

link_soft_merged — объединение по эвристике выполнено
payload: { hum_id, details }

При внедрении «виртуального HUM» для аналитики этот сигнал будет влиять только на отчёты, не на БД.

Пополнение админом

admin_topup — ручное изменение баланса админом
нормализация полей:

amount — итоговый дельта-баланс (может быть < 0)

comment — комментарий оператора

hum_id / user_id — кому применили (при mode=hum меняются все участники HUM)

ip, ua — откуда операция
совместимость входа: в теле могли прийти payload.amount|value|sum|delta, payload.comment|note|reason|description.
На чтении фронт выбирает первый непустой.

Расклейка (техподдержка/тесты)

merge_revert — отменили склейку HUM
user_id: оператор/мастер/NULL — на ваше усмотрение
payload: { from_user_id, old_hum_id, new_hum_id, method:"proof"|"soft", reason }

Нормально, что ретроспективные графики пересчитаются (они смотрят на текущий users.hum_id).

Примеры
auth_success (вход через TG)
{
  "event_type": "auth_success",
  "user_id": 97,
  "hum_id": 1,
  "ip": "194.87.115.218",
  "ua": "Mozilla/5.0 ...",
  "payload": {
    "provider": "tg",
    "pid": "1650011165",
    "mode": "login",
    "actor_user_id": 97
  },
  "created_at": "2025-10-12T09:40:12Z"
}

merge_proof (склеили TG → HUM 1)
{
  "event_type": "merge_proof",
  "user_id": 1,
  "payload": {
    "from_user_id": 97,
    "to_hum_id": 1,
    "method": "proof"
  },
  "ip": "194.87.115.218",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-11T20:33:22Z"
}

merge_revert (расклеили назад)
{
  "event_type": "merge_revert",
  "user_id": 1,
  "payload": {
    "from_user_id": 97,
    "old_hum_id": 1,
    "new_hum_id": 97,
    "method": "proof",
    "reason": "test_unmerge"
  },
  "created_at": "2025-10-12T18:11:07Z"
}

admin_topup
{
  "event_type": "admin_topup",
  "user_id": 97,
  "hum_id": 1,
  "amount": 50,
  "payload": { "comment": "Проверка склейки и пополнения", "mode": "user" },
  "ip": "194.87.115.218",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-11T13:37:01Z"
}

Шпаргалка по аналитике (дни, TZ, канон логинов)
-- Пример: дневные total/unique по TZ
WITH ev AS (
  SELECT e.user_id,
         (CASE WHEN pg_typeof(e.created_at)='timestamptz'
               THEN (e.created_at AT TIME ZONE 'Europe/Moscow')
               ELSE ((e.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow')
          END) AS ts_msk,
         COALESCE(e.event_type::text, e."type"::text) AS et
  FROM events e
),
login AS (SELECT user_id, ts_msk FROM ev WHERE et ILIKE '%login%success%'),
auth  AS (SELECT user_id, ts_msk FROM ev WHERE et ILIKE '%auth%success%'),
auth_orphan AS (
  SELECT a.user_id, a.ts_msk
  FROM auth a
  LEFT JOIN login l
    ON l.user_id=a.user_id AND ABS(EXTRACT(EPOCH FROM (a.ts_msk-l.ts_msk)))<=600
  WHERE l.user_id IS NULL
),
canon AS (SELECT * FROM login UNION ALL SELECT * FROM auth_orphan)
SELECT d::date AS day,
       COUNT(*) AS auth_total,
       COUNT(DISTINCT COALESCE(u.hum_id,u.id)) AS auth_unique
FROM generate_series((now() AT TIME ZONE 'Europe/Moscow')::date - 30,
                     (now() AT TIME ZONE 'Europe/Moscow')::date, interval '1 day') d
LEFT JOIN canon c ON c.ts_msk::date = d
LEFT JOIN users u ON u.id = c.user_id
GROUP BY 1 ORDER BY 1;

Проверочный чек-лист

/api/me после входа должен отдавать id актёра текущего провайдера (VK — VK-user, TG — tg:<pid>-user).

В админке событие auth_success после TG-логина обязано иметь user_id TG-актёра (а не VK).

При link_success всегда есть пара merge_proof в момент фактической смены hum_id.

Пополнение на user_id в режиме mode=user меняет баланс только актёра; в mode=hum — весь HUM.

Все новые события кладём с UTC-временем; в отчётах всегда приводим к нужной TZ.
