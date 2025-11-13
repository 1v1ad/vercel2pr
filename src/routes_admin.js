// src/routes_admin.js
// Админ-эндпоинты для /admin/*
// МОНТИРУЕМ ЭТОТ РОУТЕР ТАК: app.use('/api', routesAdmin)

import { Router } from 'express';
import { db, logEvent } from './db.js';

const router = Router();

// ====== утилиты ======
const ADMIN_HEADER = 'x-admin-key';
const ADMIN_ENV = process.env.ADMIN_KEY || process.env.ADMIN_TOKEN || '';

function requireAdmin(req, res, next) {
  try {
    const key = (req.headers[ADMIN_HEADER] || '').toString();
    if (!ADMIN_ENV) {
      // Если ключ не задан в окружении — разрешим (на твой страх и риск в DEV)
      return next();
    }
    if (key && ADMIN_ENV && key === ADMIN_ENV) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
}

function parseIntSafe(v, def = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseFloatSafe(v, def = 0) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function isoDay(d) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt.toISOString().slice(0, 10);
}

// ====== ping ======
router.get('/admin/ping', requireAdmin, (req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

// ====== SUMMARY: быстрые цифры ======
// GET /api/admin/summary?days=7
router.get('/admin/summary', requireAdmin, async (req, res) => {
  try {
    const days = parseIntSafe(req.query.days, 7);

    // users total
    let totalUsers = 0;
    try {
      const r = await db`SELECT COUNT(*)::int AS c FROM users`;
      totalUsers = r?.[0]?.c ?? 0;
    } catch {}

    // auth_accounts total
    let totalAuth = 0;
    try {
      const r = await db`SELECT COUNT(*)::int AS c FROM auth_accounts`;
      totalAuth = r?.[0]?.c ?? 0;
    } catch {}

    // events last N days
    let eventsLast = 0;
    try {
      const r = await db`
        SELECT COUNT(*)::int AS c
        FROM events
        WHERE created_at >= now() - ${days} * interval '1 day'
      `;
      eventsLast = r?.[0]?.c ?? 0;
    } catch {}

    res.json({
      ok: true,
      data: {
        total_users: totalUsers,
        total_auth_accounts: totalAuth,
        events_last_days: eventsLast,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== RANGE: аналитика по диапазону ======
// GET /api/admin/range?d1=2025-10-01&d2=2025-10-31&tz=Europe/Moscow
router.get('/admin/range', requireAdmin, async (req, res) => {
  try {
    const d1 = req.query.d1 ? String(req.query.d1) : isoDay(Date.now() - 6 * 86400000);
    const d2 = req.query.d2 ? String(req.query.d2) : isoDay(Date.now());
    // tz можно использовать на фронте, тут оно не критично
    // unique = новые пользователи за день
    // visits = кол-во событий авторизации/логина за день

    let series = [];
    try {
      const r = await db`
        WITH days AS (
          SELECT generate_series(${d1}::date, ${d2}::date, '1 day') AS d
        ),
        new_users AS (
          SELECT created_at::date AS d, COUNT(*)::int AS c
          FROM users
          WHERE created_at::date BETWEEN ${d1}::date AND ${d2}::date
          GROUP BY 1
        ),
        visits AS (
          SELECT created_at::date AS d, COUNT(*)::int AS c
          FROM events
          WHERE created_at::date BETWEEN ${d1}::date AND ${d2}::date
            AND (event_type IN ('auth','login','tg_auth','vk_auth') OR event_type ILIKE '%auth%')
          GROUP BY 1
        )
        SELECT
          days.d::text AS day,
          COALESCE(new_users.c, 0) AS uniques,
          COALESCE(visits.c, 0) AS visits
        FROM days
        LEFT JOIN new_users ON new_users.d = days.d
        LEFT JOIN visits ON visits.d = days.d
        ORDER BY days.d ASC
      `;
      series = r ?? [];
    } catch {
      // если таблиц нет — отдадим пустую серийность
      const start = new Date(d1);
      const end = new Date(d2);
      const arr = [];
      for (let t = +start; t <= +end; t += 86400000) {
        arr.push({ day: isoDay(t), uniques: 0, visits: 0 });
      }
      series = arr;
    }

    res.json({ ok: true, data: series });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== USERS: таблица пользователей с провайдерами ======
// GET /api/admin/users?limit=50&offset=0&search=term
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseIntSafe(req.query.limit, 50), 1), 200);
    const offset = Math.max(parseIntSafe(req.query.offset, 0), 0);
    const search = (req.query.search || '').toString().trim();

    let users = [];
    try {
      if (search) {
        users = await db`
          SELECT u.id, u.hum_id, u.first_name, u.last_name, u.country, u.balance,
                 u.created_at, u.updated_at
          FROM users u
          WHERE CAST(u.id AS text) ILIKE ${'%' + search + '%'}
             OR COALESCE(u.first_name,'') ILIKE ${'%' + search + '%'}
             OR COALESCE(u.last_name,'') ILIKE ${'%' + search + '%'}
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        users = await db`
          SELECT u.id, u.hum_id, u.first_name, u.last_name, u.country, u.balance,
                 u.created_at, u.updated_at
          FROM users u
          ORDER BY u.id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }
    } catch {}

    // подтащим провайдеров
    let mapProviders = new Map();
    try {
      const ids = users.map(u => u.id);
      if (ids.length) {
        const prov = await db`
          SELECT aa.user_id, aa.provider, aa.provider_user_id
          FROM auth_accounts aa
          WHERE aa.user_id = ANY(${ids})
        `;
        for (const p of prov) {
          const arr = mapProviders.get(p.user_id) || [];
          arr.push({ provider: p.provider, provider_user_id: p.provider_user_id });
          mapProviders.set(p.user_id, arr);
        }
      }
    } catch {}

    const rows = users.map(u => ({
      ...u,
      providers: mapProviders.get(u.id) || [],
    }));

    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== EVENTS: лента событий ======
// GET /api/admin/events?limit=100&offset=0&user_id=&term=
router.get('/admin/events', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseIntSafe(req.query.limit, 100), 1), 500);
    const offset = Math.max(parseIntSafe(req.query.offset, 0), 0);
    const userId = parseIntSafe(req.query.user_id, 0);
    const term = (req.query.term || '').toString().trim();

    let events = [];
    try {
      if (userId) {
        events = await db`
          SELECT id, event_type, user_id, hum_id, ip, ua, payload, created_at
          FROM events
          WHERE user_id = ${userId}
          ORDER BY id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (term) {
        events = await db`
          SELECT id, event_type, user_id, hum_id, ip, ua, payload, created_at
          FROM events
          WHERE CAST(user_id AS text) ILIKE ${'%' + term + '%'}
             OR CAST(hum_id AS text) ILIKE ${'%' + term + '%'}
             OR event_type ILIKE ${'%' + term + '%'}
          ORDER BY id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        events = await db`
          SELECT id, event_type, user_id, hum_id, ip, ua, payload, created_at
          FROM events
          ORDER BY id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }
    } catch {}

    res.json({ ok: true, data: events });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== TOPUP: ручное пополнение ======
// POST /api/admin/topup  { user_id, amount }
router.post('/admin/topup', requireAdmin, async (req, res) => {
  try {
    const userId = parseIntSafe(req.body?.user_id, 0);
    const amount = parseFloatSafe(req.body?.amount, 0);
    if (!userId || !Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, error: 'bad_params' });
    }

    // обновим баланс
    let updated = null;
    try {
      const r = await db`
        UPDATE users
        SET balance = COALESCE(balance,0) + ${amount}, updated_at = now()
        WHERE id = ${userId}
        RETURNING id, balance
      `;
      updated = r?.[0] || null;
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'db_update_failed' });
    }

    // зафиксируем транзакцию если есть таблица
    try {
      await db`
        INSERT INTO transactions (user_id, amount, type, meta, created_at)
        VALUES (${userId}, ${amount}, 'admin_topup', '{"source":"admin"}', now())
      `;
    } catch {}

    // ивент
    try {
      await logEvent('admin_topup', { user_id: userId }, { amount });
    } catch {}

    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
