// src/routes_admin.js
// GGRoom — admin API router (rollback+fix)
// Совместим со старым фронтом: /daily, /summary, /users, /events, /users/:id/topup, /topup.
// Правила: пароль в X-Admin-Password ИЛИ ?admin_password=…
// История нормализует amount/comment из плоских полей ИЛИ из payload JSON.

import express from 'express';
import { db } from './db.js';

const router = express.Router();

// ------------------------ helpers ------------------------

function getAdminPwd(req) {
  return (req.get('X-Admin-Password') || req.query.admin_password || '').trim();
}
function assertAdmin(req, res) {
  const ok = getAdminPwd(req) && process.env.ADMIN_PASSWORD
    && getAdminPwd(req) === process.env.ADMIN_PASSWORD;
  if (!ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function pickAmount(obj, d = 0) {
  // Порядок приоритета: плоское поле -> payload.amount -> payload.sum/value/delta
  const p = obj?.payload || {};
  return num(
    obj?.amount ??
    p?.amount ??
    p?.sum ??
    p?.value ??
    p?.delta, d
  );
}
function pickComment(obj) {
  const p = obj?.payload || {};
  const c = obj?.comment ?? p?.comment ?? p?.note ?? p?.reason ?? p?.description ?? '';
  return (c ?? '').toString();
}
function pickHumIdRow(row) {
  return num(row?.hum_id ?? row?.HUMid ?? row?.humId ?? row?.hum ?? row?.id ?? 0);
}

// ------------------------ USERS --------------------------

// GET /api/admin/users?take=25&skip=0&search=...
router.get('/users', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const take = Math.max(1, Math.min(200, num(req.query.take, 25)));
    const skip = Math.max(0, num(req.query.skip, 0));
    const search = (req.query.search || '').trim();

    // Простая выдача, без тяжёлых JOIN'ов.
    const params = [];
    let where = '1=1';
    if (search) {
      params.push(`%${search}%`);
      where = `(CAST(u.id AS TEXT) ILIKE $${params.length} OR CAST(u.vk_id AS TEXT) ILIKE $${params.length} OR COALESCE(u.first_name,\'\') || \' \' || COALESCE(u.last_name,\'\') ILIKE $${params.length})`;
    }

    params.push(take, skip);
    const q = `
      SELECT
        u.id,
        COALESCE(u.hum_id, u.id) AS hum_id,
        u.vk_id,
        u.first_name,
        u.last_name,
        u.avatar,
        COALESCE(u.balance, 0)::bigint AS balance,
        COALESCE(u.country_code, '') AS country_code,
        u.created_at
      FROM users u
      WHERE ${where}
      ORDER BY u.id
      LIMIT $${params.length-1} OFFSET $${params.length}
    `;
    const r = await db.query(q, params);
    res.json({ ok: true, users: r.rows || [] });
  } catch (e) {
    console.error('admin/users error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------ DAILY (для графика) ------------

// GET /api/admin/daily?days=7&tz=Europe/Moscow
router.get('/daily', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const days = Math.max(1, Math.min(31, num(req.query.days, 7)));
    // считаем по событиям авторизации: auth_success / login / auth
    const q = `
      WITH src AS (
        SELECT
          (created_at AT TIME ZONE 'UTC')::date AS d_utc,
          COALESCE(hum_id, user_id, 0) AS hum
        FROM events
        WHERE event_type IN ('auth_success','login','auth')
          AND created_at >= NOW() AT TIME ZONE 'UTC' - INTERVAL '${days-1} day'
      ),
      agg AS (
        SELECT d_utc AS date_utc,
               COUNT(*)::int AS auth_total,
               COUNT(DISTINCT hum)::int AS auth_unique
        FROM src
        GROUP BY d_utc
      )
      SELECT
        to_char(date_utc, 'YYYY-MM-DD') AS date,
        auth_total,
        auth_unique
      FROM agg
      ORDER BY date_utc;
    `;
    const r = await db.query(q);
    const daysArr = (r.rows || []).map(x => ({
      date: x.date, auth_total: num(x.auth_total, 0), auth_unique: num(x.auth_unique, 0),
    }));
    res.json({ ok: true, days: daysArr, daily: daysArr });
  } catch (e) {
    console.error('admin/daily error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------ SUMMARY (карточки) --------------

// GET /api/admin/summary?tz=Europe/Moscow
router.get('/summary', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const r1 = await db.query(`SELECT COUNT(*)::int AS users FROM users`);
    const r2 = await db.query(`
      SELECT COUNT(*)::int AS auths7
      FROM events
      WHERE event_type IN ('auth_success','login','auth')
        AND created_at >= NOW() AT TIME ZONE 'UTC' - INTERVAL '7 day'
    `);
    res.json({
      ok: true,
      users_total: num(r1.rows?.[0]?.users, 0),
      auths_7d: num(r2.rows?.[0]?.auths7, 0),
    });
  } catch (e) {
    console.error('admin/summary error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------ EVENTS (история) ----------------

// GET /api/admin/events?type=admin_topup&take=100&skip=0
router.get('/events', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const take = Math.max(1, Math.min(200, num(req.query.take, 50)));
    const skip = Math.max(0, num(req.query.skip, 0));
    const type = (req.query.type || req.query.search || '').trim();

    const params = [take, skip];
    let where = '1=1';
    if (type) {
      params.push(type);
      where = `(event_type = $3 OR (payload->>'type') = $3)`;
    }

    const q = `
      SELECT
        e.id,
        e.user_id,
        COALESCE(e.hum_id, e.user_id) AS hum_id,
        e.event_type,
        e.ip, e.ua,
        e.created_at,
        e.amount,
        e.comment,
        e.payload
      FROM events e
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const r = await db.query(q, params);
    const list = (r.rows || []).map(row => ({
      id: row.id,
      user_id: num(row.user_id, 0),
      hum_id: pickHumIdRow(row),
      event_type: row.event_type,
      ip: row.ip || null,
      ua: row.ua || null,
      created_at: row.created_at,
      amount: pickAmount(row, 0),
      comment: pickComment(row),
    }));
    res.json({ ok: true, events: list, rows: list, list });
  } catch (e) {
    console.error('admin/events error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------ TOPUP ---------------------------

async function applyTopup({ userId, amount, comment, ip, ua }) {
  // Топап по HUM-группе
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r0 = await client.query(`SELECT id, COALESCE(hum_id, id) AS hum_id FROM users WHERE id = $1 LIMIT 1`, [userId]);
    if (!r0.rows?.length) {
      await client.query('ROLLBACK');
      return { ok: false, code: 404, error: 'user_not_found' };
    }
    const humId = num(r0.rows[0].hum_id, userId);

    await client.query(
      `UPDATE users
         SET balance = COALESCE(balance, 0) + $2
       WHERE COALESCE(hum_id, id) = $1`,
      [humId, amount]
    );

    const r2 = await client.query(
      `SELECT SUM(COALESCE(balance,0))::bigint AS hum_balance
       FROM users WHERE COALESCE(hum_id, id) = $1`,
      [humId]
    );
    const humBalance = num(r2.rows?.[0]?.hum_balance, 0);

    // лог в events: и в плоские, и в payload
    const payload = {
      amount, comment, hum_id: humId, user_id: userId, type: 'admin_topup',
    };
    await client.query(
      `INSERT INTO events (event_type, user_id, hum_id, amount, comment, payload, ip, ua)
       VALUES ('admin_topup', $1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [userId, humId, amount, comment || null, JSON.stringify(payload), ip || null, ua || null]
    );

    await client.query('COMMIT');
    return { ok: true, hum_id: humId, new_balance: humBalance };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('applyTopup error', e);
    return { ok: false, code: 500, error: 'server_error' };
  } finally {
    client.release();
  }
}

// POST /api/admin/users/:id/topup
router.post('/users/:id/topup', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const userId = num(req.params.id, 0);
    const body = req.body || {};
    // принимаем любые синонимы
    const amount = num(body.amount ?? body.delta ?? body.sum ?? body.value, NaN);
    const comment = (body.comment ?? body.note ?? body.reason ?? body.description ?? '').toString().trim();

    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, error: 'amount_required' });
    }
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_id_required' });
    }
    const { ok, code, error, hum_id, new_balance } = await applyTopup({
      userId, amount, comment,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });
    if (!ok) return res.status(code || 500).json({ ok, error });
    res.json({ ok: true, hum_id, new_balance });
  } catch (e) {
    console.error('admin users/:id/topup error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/admin/topup  (fallback для старых форм)
router.post('/topup', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const userId = num(body.user_id ?? body.userId, 0);
    const amount = num(body.amount ?? body.delta ?? body.sum ?? body.value, NaN);
    const comment = (body.comment ?? body.note ?? body.reason ?? body.description ?? '').toString().trim();
    if (!userId) return res.status(400).json({ ok: false, error: 'user_id_required' });
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ ok: false, error: 'amount_required' });

    const { ok, code, error, hum_id, new_balance } = await applyTopup({
      userId, amount, comment,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });
    if (!ok) return res.status(code || 500).json({ ok, error });
    res.json({ ok: true, hum_id, new_balance });
  } catch (e) {
    console.error('admin/topup error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------ HEALTH -------------------------
router.get('/health', (req, res) => res.json({ ok: true }));

export default router;
