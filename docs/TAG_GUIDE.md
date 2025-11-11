# GGRoom — TAG GUIDE (шпаргалка для разрастания проекта)

Стратегия: **все якоря начинаются с `GG:`** — так их легко грепать и не путать с обычными комментариями.

## 1) Шапка файла (обязательная)
В каждом ключевом файле вверху:

```js
// == GG:FILE =======================================================
// name: src/routes_admin.js
// purpose: admin API (метрики, таблицы, merge/unmerge, range)
// owners: core
// version: 2025-11-11
// tags: api, admin
// ================================================================ //
```

## 2) Маркеры секций
Секции **всегда** обрамляем:

```js
// [GG:SECTION admin-auth]  краткое назначение
// ...
// [GG:END   admin-auth]
```

Имена секций — машиночитаемые (kebab_case/underscores), уникальные в файле.

## 3) Маркеры эндпоинтов
Перед каждым роутом:

```js
// [GG:API GET /api/admin/range]  возвращает метрики за период; поддерживает ?analytics=1
router.get('/range', async (req,res) => { ... });
// [GG:END API]
```

## 4) Врезки/якоря для фронтовых скриптов
Точки, куда часто «вклеиваем» новый код:

```html
<!-- [GG:ANCHOR admin-proposals-actions] кнопки/ссылки рядом с "Склейка: предложения" -->
<!-- [GG:END ANCHOR] -->
```

## 5) Фичефлаги/временная логика
Обрамляем:

```js
/* [GG:FEATURE analytics_uniques] — включить уникальных с учетом аналитики */
// ...
/* [GG:END FEATURE analytics_uniques] */
```

## 6) Ревизии/патчи
Снизу файла держим changelog:

```js
/* [GG:CHANGELOG]
2025‑11‑11  add: /merge_suggestions, /merge_apply, /unmerge; range?analytics=1
2025‑11‑10  fix: admin auth middleware robustness
[GG:END CHANGELOG] */
```

## 7) Поиск
Искать по `GG:` либо по конкретным якорям: `GG:API`, `GG:SECTION`, `GG:ANCHOR`, `GG:FEATURE`, `GG:CHANGELOG`.