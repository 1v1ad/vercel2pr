// src/routes_admin.js
// Админ-роуты: ручное пополнение + история событий.
// Стандартизировано под /docs/events.md: event_type="admin_topup", payload {user_id, hum_id, amount, comment}

import express from 'express';
import { db, logEvent } from './db.js';

const router = express.Router();

// ===== utils

function getAdminPassword(req) {
  return (
    (req.headers['x-admin-password'] || '').toString() ||
    (req.query.admin_password || '').toString()
  );
}

function requireAdmin(req, res, next) {
  const pwd = getAdminPassword(req);
  if (!pwd || pwd !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function toInt(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

// ===== core helpers

async function resolveHumId(userId) {
  const q = `select coalesce(hum_id, id) as hum_id from users where id = $1`;
  const r = await db.query(q, [userId]);
  if (!r.rows.length) return null;
  return Number(r.rows[0].hum_id);
}

async function applyTopup(humId, delta) {
  // Обновляем баланс всем пользователям HUM-группы
  await db.query(
    `update users
       set balance = coalesce(balance,0) + $1
     where coalesce(hum_id, id) = $2`,
    [delta, humId]
  );

  // Возвращаем суммарный баланс HUM
  const agg = await db.query(
    `select sum(coalesce(balance,0))::bigint as total
       from users
      where coalesce(hum_id, id) = $1`,
    [humId]
  );
  return Number(agg.rows?.[0]?.total || 0);
}

async function logTopupEvent({ user_id, hum_id, amount, comment }, req) {
  // Сохраняем строго стандартизированное payload
  await logEvent({
    user_id,
    event_type: 'admin_topup',
    payload: {
      user_id,
      hum_id,
      amount,          // число, может быть отрицательным
      comment: comment || null
    },
    ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
    ua: (req.headers['user-agent'] || '').slice(0, 256)
  });
}

// ===== routes

// POST /api/admin/users/:id/topup
router.post('/users/:id/topup', requireAdmin, async (req, res) => {
  try {
    const userId = toInt(req.params.id, 0);
    const amount = toInt(req.body?.amount ?? req.body?.delta ?? req.body?.sum ?? req.body?.value, NaN);
    const comment = (req.body?.comment ?? req.body?.note ?? req.body?.reason ?? req.body?.description ?? '').toString().trim();

    if (!userId || !Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, error: 'bad_input' });
    }
    if (!comment) {
      return res.status(400).json({ ok: false, error: 'comment_required' });
    }

    const humId = await resolveHumId(userId);
    if (!humId) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const newBalance = await applyTopup(humId, amount);
    await logTopupEvent({ user_id: userId, hum_id: humId, amount, comment }, req);

    return res.json({ ok: true, hum_id: humId, new_balance: newBalance });
  } catch (e) {
    console.error('admin users/:id/topup error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/admin/topup   (fallback форма: body.user_id + amount + comment)
router.post('/topup', requireAdmin, async (req, res) => {
  try {
    const userId = toInt(req.body?.user_id, 0);
    const amount = toInt(req.body?.amount ?? req.body?.delta ?? req.body?.sum ?? req.body?.value, NaN);
    const comment = (req.body?.comment ?? req.body?.note ?? req.body?.reason ?? req.body?.description ?? '').toString().trim();

    if (!userId || !Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, error: 'bad_input' });
    }
    if (!comment) {
      return res.status(400).json({ ok: false, error: 'comment_required' });
    }

    const humId = await resolveHumId(userId);
    if (!humId) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const newBalance = await applyTopup(humId, amount);
    await logTopupEvent({ user_id: userId, hum_id: humId, amount, comment }, req);

    return res.json({ ok: true, hum_id: humId, new_balance: newBalance });
  } catch (e) {
    console.error('admin topup error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// GET /api/admin/events  — история событий (по умолчанию admin_topup)
router.get('/events', requireAdmin, async (req, res) => {
  try {
    const type = (req.query.type || req.query.search || 'admin_topup').toString();
    const take = Math.min(Math.max(toInt(req.query.take, 50), 1), 200);
    const skip = Math.max(toInt(req.query.skip, 0), 0);

    // Вытаскиваем нормализованные поля из payload. Если старые события писались другими ключами —
    // используем COALESCE по всем распространённым вариантам.
    const q = `
      select
        id,
        event_type,
        created_at,
        (payload->>'user_id')::bigint                        as user_id,
        (payload->>'hum_id')::bigint                         as hum_id,
        coalesce(
          nullif(payload->>'comment',''),
          nullif(payload->>'note',''),
          nullif(payload->>'reason',''),
          nullif(payload->>'description','')
        )                                                    as comment,
        coalesce(
          nullif((payload->>'amount')::bigint, 0),
          nullif((payload->>'delta')::bigint, 0),
          nullif((payload->>'value')::bigint, 0),
          nullif((payload->>'sum')::bigint, 0),
          0
        )                                                    as amount
      from events
      where event_type = $1
      order by created_at desc
      limit $2 offset $3
    `;
    const r = await db.query(q, [type, take, skip]);
    // Совместимость с фронтом: дублируем под старые поля "type" и "HUMid"
    const rows = r.rows.map(x => ({
      ...x,
      type: x.event_type,
      HUMid: x.hum_id
    }));
    res.json({ ok: true, events: rows, rows });
  } catch (e) {
    console.error('admin events error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
