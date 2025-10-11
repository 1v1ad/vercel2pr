// src/routes_admin.js
import express from 'express';
import { db, logEvent } from './db.js';

const router = express.Router();

// ---- helpers ---------------------------------------------------------------

function getAdminPassword(req) {
  return (req.get('X-Admin-Password') || req.query.admin_password || '').trim();
}

function requireAdmin(req, res, next) {
  const incoming = getAdminPassword(req);
  const expected = String(process.env.ADMIN_PASSWORD || '').trim();
  if (!expected) {
    // Если пароль в ENV не задан, считаем любой непустой валидным — для девопса
    if (!incoming) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return next();
  }
  if (incoming !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

async function getHumId(userId) {
  const r = await db.query(
    `select coalesce(hum_id, id) as hum_id from users where id = $1`,
    [userId]
  );
  return r.rows?.[0]?.hum_id ?? null;
}

async function calcHumBalance(humId) {
  const r = await db.query(
    `select coalesce(sum(coalesce(balance,0)),0)::bigint as hum_balance
     from users
     where coalesce(hum_id,id) = $1`,
    [humId]
  );
  return Number(r.rows?.[0]?.hum_balance ?? 0);
}

// ---- routes ----------------------------------------------------------------

// Список событий админки
// GET /api/admin/events?type=admin_topup&take=100&skip=0
router.get('/events', requireAdmin, async (req, res) => {
  try {
    const type = String(req.query.type || req.query.event_type || '').trim();
    const search = String(req.query.search || '').trim();
    const take = Math.min(Math.max(parseInt(String(req.query.take || 50), 10) || 50, 1), 200);
    const skip = Math.max(parseInt(String(req.query.skip || 0), 10) || 0, 0);

    const where = [];
    const vals = [];

    if (type) {
      vals.push(type);
      where.push(`event_type = $${vals.length}`);
    }
    if (search) {
      vals.push(`%${search}%`);
      where.push(`(event_type ilike $${vals.length} or coalesce(comment,'') ilike $${vals.length})`);
    }

    const sql = `
      select
        id,
        user_id,
        hum_id,
        event_type,
        created_at,
        ip,
        ua,
        -- важное место: amount/comment могут быть как в колонках, так и в payload
        coalesce(amount, nullif(payload->>'amount','')::bigint, 0)           as amount,
        coalesce(comment, nullif(payload->>'comment',''))                    as comment
      from events
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by created_at desc, id desc
      limit ${take} offset ${skip}
    `;

    const r = await db.query(sql, vals);
    return res.json({ ok: true, events: r.rows, rows: r.rows });
  } catch (e) {
    console.error('admin/events error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Ручное пополнение
// POST /api/admin/users/:id/topup  body: { amount:number, comment?:string }
router.post('/users/:id/topup', requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const amount = Number(req.body?.amount ?? req.body?.value ?? req.body?.sum ?? req.body?.delta);
  const comment = String(
    req.body?.comment ?? req.body?.note ?? req.body?.reason ?? req.body?.description ?? ''
  ).slice(0, 500);

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: 'bad_user_id' });
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ ok: false, error: 'bad_amount' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) Проверим, что пользователь существует и возьмём HUM
    const humId = await (async () => {
      const r = await client.query(
        `select id, coalesce(hum_id,id) as hum_id from users where id = $1 for update`,
        [userId]
      );
      if (!r.rows?.length) throw new Error('user_not_found');
      return Number(r.rows[0].hum_id);
    })();

    // 2) Пополним баланс конкретного user_id (чтобы сохранялась история по аккаунту)
    await client.query(
      `update users
         set balance = coalesce(balance,0) + $2
       where id = $1`,
      [userId, amount]
    );

    // 3) Лог события (дублируем и в колонки, и в payload для обратной совместимости)
    const payload = { amount, comment, user_id: userId, hum_id: humId };
    await client.query(
      `insert into events (user_id, hum_id, event_type, amount, comment, payload, ip, ua)
       values ($1, $2, 'admin_topup', $3, $4, $5, $6, $7)`,
      [
        userId,
        humId,
        amount,
        comment || null,
        payload,
        (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null,
        (req.headers['user-agent'] || '').slice(0, 256) || null
      ]
    );

    // 4) Посчитаем новый HUM-баланс
    const newHumBalance = await (async () => {
      const r = await client.query(
        `select coalesce(sum(coalesce(balance,0)),0)::bigint as hum_balance
           from users
          where coalesce(hum_id,id) = $1`,
        [humId]
      );
      return Number(r.rows?.[0]?.hum_balance ?? 0);
    })();

    await client.query('COMMIT');
    return res.json({ ok: true, hum_id: humId, new_balance: newHumBalance });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('admin topup error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  } finally {
    client.release();
  }
});

export default router;
