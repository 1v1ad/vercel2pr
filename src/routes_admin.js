// src/routes_admin.js
// Админ-роуты GG ROOM: summary / daily / range / users / events
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

/* ------- admin auth ------- */
function isAdminOk(req) {
  const v = req.headers['x-admin-password'] || req.headers['X-Admin-Password'];
  const pwd = process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '';
  return !!v && v === pwd;
}
function assertAdmin(req, res) {
  if (!isAdminOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

/* ------- helpers ------- */
function iso(d) { return new Date(d).toISOString().slice(0,10); }

/* ------- /api/admin/summary ------- */
router.get('/summary', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const users  = await db.query('select count(*)::int as c from users');
    const events = await db.query('select count(*)::int as c from events');
    const auth7d = await db.query(
      `select count(*)::int as c
         from events
        where event_type='auth_success'
          and created_at >= now() - interval '7 days'`
    );

    res.json({
      ok: true,
      users_total: users.rows[0]?.c ?? 0,
      events_total: events.rows[0]?.c ?? 0,
      auth_7d: auth7d.rows[0]?.c ?? 0,
    });
  } catch (e) {
    console.error('admin/summary', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ------- /api/admin/daily  (для admin/chart.js) ------- */
router.get('/daily', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const days = Math.max(1, Math.min(400, parseInt(req.query.days || '7', 10)));

    const sql = `
      with days as (
        select d::date as d
        from generate_series((now()::date - ($1::int - 1) * interval '1 day'), now()::date, interval '1 day') as d
      ),
      ev as (
        select created_at::date as d, hum_id
          from events
         where event_type='auth_success'
           and created_at >= (now()::date - ($1::int - 1) * interval '1 day')
      ),
      agg as (
        select d, count(*) as auth_total, count(distinct hum_id) as auth_unique
          from ev
         group by d
      )
      select to_char(days.d,'YYYY-MM-DD') as date,
             coalesce(agg.auth_total,0)   as auth_total,
             coalesce(agg.auth_unique,0)  as auth_unique
        from days
   left join agg on agg.d = days.d
    order by days.d asc
    `;
    const q = await db.query(sql, [days]);
    res.json({ ok:true, days: q.rows || [] });
  } catch (e) {
    console.error('admin/daily', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ------- /api/admin/range (для admin/chart-range.js) ------- */
router.get('/range', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const fromRaw = (req.query.from||'').toString().trim();
    const toRaw   = (req.query.to||'').toString().trim();

    const to   = /^\d{4}-\d{2}-\d{2}$/.test(toRaw)   ? toRaw   : iso(new Date());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : iso(Date.now() - 30*864e5);

    const span = Math.ceil((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (!(span > 0) || span > 400) return res.status(400).json({ ok:false, error:'range_too_wide' });

    const sql = `
      with days as (
        select d::date as d
        from generate_series($1::date, $2::date, interval '1 day') as d
      ),
      ev as (
        select created_at::date as d, hum_id
          from events
         where event_type='auth_success'
           and created_at >= $1::date
           and created_at <  ($2::date + interval '1 day')
      ),
      agg as (
        select d, count(*) as auth_total, count(distinct hum_id) as auth_unique
          from ev
         group by d
      )
      select to_char(days.d,'YYYY-MM-DD') as day,
             coalesce(agg.auth_total,0)    as auth_total,
             coalesce(agg.auth_unique,0)   as auth_unique
        from days
   left join agg on agg.d = days.d
    order by days.d asc
    `;
    const q = await db.query(sql, [from, to]);
    res.json({ ok:true, from, to, days: q.rows || [] });
  } catch (e) {
    console.error('admin/range', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ------- /api/admin/users ------- */
router.get('/users', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const params = [];
    let where = '';

    if (search) {
      params.push(`%${search}%`);
      where = `
        where cast(u.id as text) ilike $${params.length}
           or (coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) ilike $${params.length}
           or exists (
                select 1 from auth_accounts a
                 where a.user_id = u.id
                   and (a.provider_user_id ilike $${params.length}
                        or a.username ilike $${params.length})
           )
      `;
    }

    const sql = `
      select
        u.id                                   as user_id,
        coalesce(u.hum_id, u.id)              as hum_id,
        coalesce(u.first_name,'')             as first_name,
        coalesce(u.last_name,'')              as last_name,
        coalesce(u.country_name,'')           as country,
        coalesce(u.balance,0)::bigint         as balance,
        to_char(u.created_at,'YYYY-MM-DD HH24:MI:SS') as created_at,
        array_agg(distinct a.provider)          filter (where a.provider is not null)         as providers,
        array_agg(distinct a.provider_user_id)  filter (where a.provider_user_id is not null) as provider_ids
      from users u
      left join auth_accounts a on a.user_id = u.id
      ${where}
      group by u.id
      order by u.id asc
      limit ${limit} offset ${offset}
    `;
    const rows = (await db.query(sql, params)).rows || [];
    res.json({ ok:true, users: rows });
  } catch (e) {
    console.error('admin/users', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* ------- /api/admin/events ------- */
router.get('/events', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;

    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const type   = (req.query.type || '').toString().trim();

    const params = [];
    const where = [];
    if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
    if (type)   { params.push(type);   where.push(`event_type = $${params.length}`); }

    const sql = `
      select
        id,
        coalesce(hum_id, user_id)                         as hum_id,
        user_id,
        event_type,
        coalesce(payload->>'type','')                     as type,
        coalesce(ip::text,'')                             as ip,
        coalesce(ua,'')                                   as ua,
        to_char(created_at,'YYYY-MM-DD HH24:MI:SS')       as created_at
      from events
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by id desc
      limit ${limit} offset ${offset}
    `;
    const rows = (await db.query(sql, params)).rows || [];
    res.json({ ok:true, events: rows });
  } catch (e) {
    console.error('admin/events', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
