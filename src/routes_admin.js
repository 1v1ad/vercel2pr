// src/routes_admin.js (добавка к вашему Router)
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

// --- утилита авторизации админ-запросов
function assertAdmin(req, res) {
  const hdr = req.headers['x-admin-password'] || req.headers['X-Admin-Password'];
  const ok = hdr && hdr === (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  if (!ok) res.status(401).json({ ok:false, error:'unauthorized' });
  return ok;
}

/** СВОДКА: /api/admin/summary?tz=Europe/Moscow */
router.get('/summary', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const tz = (req.query.tz || 'Europe/Moscow').toString();

    const qUsers   = await db.query('select count(*)::int as c from users');
    const qEvents  = await db.query('select count(*)::int as c from events');
    const qAuth7d  = await db.query(
      `select count(*)::int as c
         from events
        where event_type='auth_success'
          and created_at >= (now() at time zone $1) - interval '7 days'`,
      [tz]
    );

    res.json({
      ok: true,
      users_total: qUsers.rows[0].c,
      events_total: qEvents.rows[0].c,
      auth_7d: qAuth7d.rows[0].c
    });
  } catch (e) {
    console.error('admin/summary', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/** ПОЛЬЗОВАТЕЛИ: /api/admin/users?search=&limit=100&offset=0 */
router.get('/users', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    // агрегируем провайдеров из auth_accounts
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `where cast(u.id as text) ilike $${params.length}
            or coalesce(u.first_name,'')||' '||coalesce(u.last_name,'') ilike $${params.length}
            or exists(select 1 from auth_accounts a where a.user_id=u.id and (a.provider_user_id ilike $${params.length}))`;
    }

    const sql = `
      select
        u.id as user_id,
        u.hum_id,
        u.first_name,
        u.last_name,
        u.country,
        coalesce(u.balance,0)::bigint as balance,
        u.created_at,
        array_remove(array_agg(distinct a.provider order by a.provider), null) as providers,
        array_remove(array_agg(distinct case when a.provider='vk' then a.provider_user_id end), null) as vk_ids,
        array_remove(array_agg(distinct case when a.provider='tg' then a.provider_user_id end), null) as tg_ids
      from users u
      left join auth_accounts a on a.user_id = u.id
      ${where}
      group by u.id
      order by u.id asc
      limit ${limit} offset ${offset}
    `;
    const rows = (await db.query(sql, params)).rows;
    res.json({ ok:true, users: rows });
  } catch (e) {
    console.error('admin/users', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/** СОБЫТИЯ: /api/admin/events?type=&user_id=&limit=100&offset=0 */
router.get('/events', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const type   = (req.query.type || '').toString().trim(); // login, auth_start, auth_success, ...

    const params = [];
    const whereParts = [];
    if (userId) { params.push(userId); whereParts.push(`user_id = $${params.length}`); }
    if (type)   { params.push(type);   whereParts.push(`event_type = $${params.length}`); }
    const where = whereParts.length ? `where ${whereParts.join(' and ')}` : '';

    const sql = `
      select id, hum_id, user_id, event_type, type, ip, ua, created_at
      from events
      ${where}
      order by id desc
      limit ${limit} offset ${offset}
    `;
    const rows = (await db.query(sql, params)).rows;
    res.json({ ok:true, events: rows });
  } catch (e) {
    console.error('admin/events', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/** ДИАПАЗОН: /api/admin/range — оставляем вашу рабочую версию */
router.get('/range', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const tz = (req.query.tz || 'Europe/Moscow').toString();
    const fromQ = (req.query.from || '').toString().trim();
    const toQ   = (req.query.to   || '').toString().trim();
    const analytics = String(req.query.analytics || '0') === '1';

    const today = new Date().toISOString().slice(0,10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(toQ) ? toQ : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromQ) ? fromQ :
                 new Date(Date.now()-30*864e5).toISOString().slice(0,10);

    const dayspan = Math.ceil((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (!(dayspan > 0) || dayspan > 400) {
      return res.status(400).json({ ok:false, error:'range_too_wide' });
    }

    const sql = `
      with days as (
        select d::date as d
        from generate_series($1::date, $2::date, interval '1 day') as d
      ),
      ev as (
        select
          (created_at at time zone 'UTC' at time zone $3)::date as d,
          hum_id
        from events
        where event_type = 'auth_success'
          and created_at >= $1::date
          and created_at <  ($2::date + interval '1 day')
      ),
      agg as (
        select d, count(*) as auth_total, count(distinct hum_id) as auth_unique
        from ev
        group by d
      )
      select to_char(days.d, 'YYYY-MM-DD') as day,
             coalesce(agg.auth_total, 0) as auth_total,
             coalesce(agg.auth_unique, 0) as auth_unique
      from days
      left join agg on agg.d = days.d
      order by days.d asc
    `;
    const q = await db.query(sql, [from, to, tz]);
    const days = q.rows || [];
    if (analytics) days.forEach(r => r.auth_unique_analytics = r.auth_unique);

    res.json({ ok:true, from, to, days });
  } catch (e) {
    console.error('admin/range', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
