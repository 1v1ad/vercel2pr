# CONTRIBUTING — GGRoom

Этот документ общий для фронта и бэка. Для БД/событий **истиной** является `vercel2pr/docs/events.md`.

## 0) TL;DR (минимум)
1. Ветки: `main` (прод), `dev` (интеграция). Фича-ветки: `feat/<slug>`.
2. Коммиты: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `perf:`, `test:`).
3. Любая фича сопровождается **ремаркой в коде** (см. «3. Комментарии/ремарки»).
4. Любое **новое событие** заносим в `docs/events.md`.
5. БД: изменения — только миграциями в `migrations/`. Один PR = одна миграция + код.
6. API-изменение → обнови `README`/`docs/events.md` и добавь curl-примеры.
7. Перед PR: `npm run lint && npm run format && npm test`.

---

## 1) Git-поток
- `main` — прод. Автодеплой/ручной релиз-тэг.
- `dev` — интеграции, e2e проверки.
- Фичи: `feat/<slug>`, баги: `fix/<slug>`, инфраструктура: `chore/<slug>`.

**PR правила**
- 1 задача = 1 PR. До 400 строк диффа желательно.
- Описание PR с чеклистом:
  - [ ] код + тесты (если применимо)
  - [ ] миграция (если БД)
  - [ ] обновлён `docs/events.md` (если событийная логика)
  - [ ] добавлены/обновлены curl-примеры (если API)
  - [ ] без «мёртвого» кода и отладочных `console.log`/`TODO` без задачи
- Review: минимум 1 апрув.

## 2) Коммиты (Conventional Commits)
Примеры:
- `feat(auth): tg+vk linking via /api/profile/link`
- `fix(admin): topup history shows amount/comment`
- `docs(events): add admin_topup schema`
- `refactor(db): extract ensureTables()`
- `chore(ci): add node 20 to matrix`

## 3) Комментарии/ремарки в коде (обязательно для фич)
Используем единый формат «ремарки» в начале блока/файла:

```js
/**
 * FEAT: admin_topup_history
 * WHY:  История ручных пополнений в админке должна показывать amount/HUMid/comment.
 * DATE: 2025-10-11
 * OWNER: @alex
 * LINKS: docs/events.md#admin_topup
 */
