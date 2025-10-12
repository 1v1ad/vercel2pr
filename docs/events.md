GGRoom — Canonical Events (v2, 2025-10-12)

Единый словарь событий, полей и правил логирования. Цель — чтобы фронт/бек и админка говорили на одном языке, а аналитика была однозначной.

Этот документ заменяет и расширяет прошлую версию словаря событий. В старом файле встречались login_success/login_error; сейчас используем auth_success/auth_start, оставив совместимость в аналитике. 

events

0) Базовые принципы

Время: всё в UTC (timestamptz), преобразования в отчётах — через таймзону.

Актёр vs HUM:
— user_id в событии — актёр, то есть конкретный users.id, от имени которого произошёл шаг (напр. VK-пользователь при входе через VK, TG-пользователь при входе через TG).
— Для агрегатов «одна персона» используем HUM-ид: COALESCE(u.hum_id, u.id).
— Баланс — всегда HUM-баланс (сумма по HUM-кластеру).

Провайдер и идентификатор:
— provider ∈ {vk,tg,web,system}.
— pid — строковый ID аккаунта у провайдера (VK user_id / TG id). Дополнительно можно писать vk_id/tg_id в payload, но канонично — pid.

IP/UA: для auth_*, link_*, merge_*, admin_topup — обязательно логируем ip и ua.

Payload: jsonb с расширяемыми ключами. Для одинаковых смыслов — одинаковые ключи (см. нормализацию ниже).

1) Схема таблицы events

Рекомендуемые поля (минимум):

Колонка	Тип	Назначение
id	bigserial	PK
event_type	text	Каноническое имя события (snake_case)
user_id	bigint	Актёр (users.id) — может быть NULL
payload	jsonb	Данные события (свободная схема)
ip	text	IP-адрес
ua	text	User-Agent
country_code	text	Если известна
created_at	timestamptz	Время события (UTC, default now())

Доп. поле hum_id необязательно. В отчётах HUM восстанавливаем по join users on users.id = events.user_id с COALESCE(u.hum_id,u.id) и/или из payload.hum_id (если событие само его несёт — напр., admin_topup). Наши админ-запросы уже учитывают оба источника.

2) Общая нормализация полей payload

Чтобы фронт всегда знал, где искать, придерживаемся таких ключей:

Идентификаторы:

provider: "vk"|"tg"|"web"|"system".

pid: строковый ID в провайдере ("1234567" или "1650011165").

hum_id: конечный HUM, если у события есть «адресат» (например, результат склейки или топапа).

actor_user_id: когда важно явно указать актёра (мы всё равно дублируем актёра в топ-уровневом events.user_id).

Merge/Link:

method: "proof" (ручная подтверждённая склейка) или "soft" (эвристика по устройству).

from_user_id, to_hum_id: источник склейки и HUM-кластер назначения.

Деньги:

amount: итоговая дельта (int), можно <0.

comment: строка-комментарий.

Совместимость при чтении: amount ?? value ?? sum ?? delta, comment ?? note ?? reason ?? description.

Техн. поля:

можно класть device_id, mode ("login"|"link"), return, error.

3) Список событий (канон)
3.1 Аутентификация

auth_start
Когда: начинается поток авторизации у провайдера.
user_id: NULL.
payload: { provider, maybe: device_id }.

auth_success
Когда: успешный вход (VK/TG).
user_id: актёр (конкретный users.id провайдера — VK или TG).
payload: { provider, pid, actor_user_id? }.
Заметка: в старых логах встречался login_success. Аналитика должна учитывать оба (мы это уже делаем в админке). 

events

auth_error (редко используем)
Когда: фатальный сбой авторизации.
user_id: NULL или актёр, если он уже определён.
payload: { provider, error }.

3.2 Привязка аккаунтов (Proof-merge, ручная, «скрепляем HUM»)

link_success
Когда: провайдер успешно привязан к HUM-кластеру.
user_id: мастер-пользователь (тот, кто инициировал привязку — обычно текущая сессия / primary).
payload: { provider, pid }.

link_error
Когда: ошибка в процессе привязки.
user_id: NULL или мастер, если он известен.
payload: { provider, reason|error }.
Важно: логируем только когда реально шёл линк-поток; при обычном логине — не пишем.

merge_proof
Когда: фактическая склейка аккаунтов по подтверждённому действию.
user_id: мастер (инициатор).
payload: { provider, pid|vk_id|tg_id, from_user_id, to_hum_id, method:"proof" }.
Семантика: не перевешиваем auth_accounts.user_id, а задаём users.hum_id у «второго» на HUM мастера.

3.3 Мягкая склейка (эвристика, по устройству)

link_soft_candidate
Когда: по device_id нашли кандидатов на объединение.
user_id: мастер (если есть) или NULL.
payload: { device_id, matches:[hum_id,…] }.

link_soft_merged
Когда: кластер объединён «мягко» (без показа общего баланса, если так решено продуктом).
user_id: мастер (если есть).
payload: { device_id, details }.
Семантика: такие склейки не обязаны немедленно менять интерфейс, но HUM в БД уже общий.

3.4 Админ-операции

admin_topup
Когда: оператор изменяет баланс.
user_id: тот конкретный пользователь, на счёт которого начисляем/списываем.
payload: { user_id, hum_id, amount, comment, mode:"user"|"hum" }.
Правило денег:
— по умолчанию (mode=user) изменяем баланс только у указанного user_id; HUM-итог рассчитываем для ответа;
— mode=hum — изменяем баланс всему кластеру (редкий админ-случай «приз человеку»).

3.5 Прочее (на будущее)

profile_update — изменены публичные поля профиля.

payment_init / payment_success / payment_error — события платёжного провайдера.

room_create / room_join / room_leave — игровые комнаты (резерв).

4) Примеры JSON-событий
4.1 TG-вход (после правок актёр — TG user)
{
  "event_type": "auth_success",
  "user_id": 97,
  "payload": {
    "provider": "tg",
    "pid": "1650011165",
    "actor_user_id": 97
  },
  "ip": "203.0.113.42",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-12T11:05:23Z"
}

4.2 VK-вход
{
  "event_type": "auth_success",
  "user_id": 1,
  "payload": {
    "provider": "vk",
    "pid": "612345678"
  },
  "ip": "203.0.113.42",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-12T11:06:44Z"
}

4.3 Proof-склейка TG→HUM(1)
{
  "event_type": "merge_proof",
  "user_id": 1,
  "payload": {
    "provider": "tg",
    "tg_id": "1650011165",
    "from_user_id": 97,
    "to_hum_id": 1,
    "method": "proof"
  },
  "ip": "203.0.113.42",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-12T11:07:01Z"
}

4.4 Привязка VK (первичная или к уже общему HUM)
{
  "event_type": "link_success",
  "user_id": 1,
  "payload": {
    "provider": "vk",
    "pid": "612345678"
  },
  "ip": "203.0.113.42",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-12T11:07:03Z"
}

4.5 Ручное пополнение user_id=97 (+50)
{
  "event_type": "admin_topup",
  "user_id": 97,
  "payload": {
    "user_id": 97,
    "hum_id": 1,
    "amount": 50,
    "comment": "Проверка пополнения",
    "mode": "user"
  },
  "ip": "203.0.113.42",
  "ua": "Mozilla/5.0 ...",
  "created_at": "2025-10-12T11:10:43Z"
}

5) Кулинарная книга SQL (админка)
5.1 Восстановление HUM в выборках событий
-- hum того же пользователя (если в events.hum_id нет)
SELECT
  e.*,
  COALESCE(
    e.hum_id,                                -- если колонка есть
    NULLIF(e.payload->>'hum_id','')::bigint, -- или из payload
    u.hum_id,                                -- или join с users
    u.id
  ) AS hum_id_canon
FROM events e
LEFT JOIN users u ON u.id = e.user_id;

5.2 Уникальные авторизации за 7 дней по HUM
WITH canon AS (
  SELECT e.user_id, e.created_at, 
         (CASE WHEN e.event_type ILIKE '%auth%success%' OR e.event_type ILIKE '%login%success%'
               THEN 1 END) AS ok
  FROM events e
)
SELECT COUNT(DISTINCT COALESCE(u.hum_id,u.id)) AS auth_unique_7d
FROM canon c 
JOIN users u ON u.id=c.user_id
WHERE c.ok = 1
  AND c.created_at >= now() - interval '7 days';

5.3 Дневные срезы (тотал/уники)

См. текущую реализацию /api/admin/daily — там уже учтены login_success и auth_success, а уникальность считается по COALESCE(u.hum_id,u.id).

5.4 Баланс HUM
SELECT SUM(COALESCE(balance,0)) AS hum_balance
FROM users
WHERE COALESCE(hum_id,id) = $1;

6) Проверочный чек-лист при добавлении нового события

Имя события в snake_case.

Определи актёра (user_id) и, если уместно, положи hum_id в payload.

Всегда укажи provider/pid, если событие относится к VK/TG.

Приложи ip и ua для чувствительных действий.

Согласуй ключи payload с этим документом (не плодить синонимов).

Добавь пример в раздел «Примеры», если событие пользовательское.

Обнови отчёты, если событие должно учитываться в метриках.
