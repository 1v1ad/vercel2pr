// src/routes_admin.js (ESM)
// минимальный и детерминированный роутер админки

import express from 'express';
import { db } from './db.js';   // именованный экспорт

const router = express.Router();

// --- guard ---
router.use((req, res, next) => {
  const need = process.env.ADMIN_PASSWORD || '';
  const got  = req.get('X-Admin-Password') || '';
  if (!need || got !== need) return res.status(401).json({ ok: false });
  next();
});

// --- USERS ---
router.get('/users', async (req, res) => {
  try {
    const take   = Math.max(1, Math.min(500, parseInt(req.query.take || '50', 10)));
    const page   = Math.max(0, parseInt(req.query.page || '0', 10));
    const offset = page * take;

    const search = (req.query.search || '').trim();
    const params = [];
    let where = 'where 1=1';
    if (search) {
      params.push(`%${search}%`, `%${search}%`, search, search);
      where += ` and (
        coalesce(u.vk_id::text,'') ilike $${params.length-3} or
        coalesce(u.first_name,'') ilike $${params.length-2} or
        u.id::text = $${params.length-1} or
        coalesce(u.last_name,'') ilike $${params.length}
      )`;
    }
    params.push(take, offset);

    const sql = `
      select
        coalesce(u.hum_id, u.id)      as hum_id,
        u.id                          as user_id,
        u.vk_id,
        coalesce(u.first_name,'')     as first_name,
        coalesce(u.last_name,'')      as last_name,
        coalesce(u.balance,0)         as balance,
        coalesce(u.country_code,'')   as country_code,
        coalesce(u.country_name,'')   as country_name,
        coalesce(u.created_at, now()) as created_at,
        array_remove(array[
          case when u.vk_id is not null and u.vk_id !~ '^tg:' then 'vk' end,
          case when u.vk_id ilike 'tg:%' then 'tg' end
        ], null)                      as providers
      from users u
      ${where}
      order by hum_id asc, user_id asc
      limit $${params.length-1} offset $${params.length}
    `;
    const r = await db.query(sql, params);
    res.json({ ok: true, users: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- EVENTS ---
router.get('/events', async (req, res) => {
  try {
    const take   = Math.max(1, Math.min(500, parseInt(req.query.take || '50', 10)));
    const page   = Math.max(0, parseInt(req.query.page || '0', 10));
    const offset = page * take;

    const filters = [];
    const params  = [];

    if (req.query.event_type) {
      params.push(req.query.event_type);
      filters.push(`e.event_type = $${params.length}`);
    }
    if (req.query.user_id) {
      params.push(parseInt(req.query.user_id, 10));
      filters.push(`e.user_id = $${params.length}`);
    }

    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    params.push(take, offset);

    const sql = `
      select
        e.id                          as event_id,
        coalesce(u.hum_id, u.id)      as hum_id,
        e.user_id,
        coalesce(e.event_type,'')     as event_type,
        coalesce(e."type",'')         as "type",
        coalesce(e.ip,'')             as ip,
        coalesce(e.ua,'')             as ua,
        coalesce(e.created_at, now()) as created_at
      from events e
      left join users u on u.id = e.user_id
      ${where}
      order by e.id desc
      limit $${params.length-1} offset $${params.length}
    `;
    const r = await db.query(sql, params);
    res.json({ ok: true, events: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- SUMMARY (daily) ---
async function summaryDaily(req, res) {
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || '7', 10)));
    const tz   = (req.query.tz || 'Europe/Moscow').toString();

    const sql = `
      with bounds as (select (date_trunc('day', (now() at time zone $2))::date) as today),
      days as (
        select (select today from bounds) - s as day
        from generate_series($1::int - 1, 0, -1) s
        order by day asc
      ),
      auth as (
        select (e.created_at at time zone $2)::date d, count(*) c
        from events e
        where e.created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      ),
      uniq as (
        select (e.created_at at time zone $2)::date d, count(distinct coalesce(u.hum_id, u.id)) c
        from events e
        join users u on u.id = e.user_id
        where e.created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      )
      select to_char(d.day, 'YYYY-MM-DD') as day,
             coalesce(a.c,0) as auth,
             coalesce(u.c,0) as uniq
      from days d
      left join auth a on a.d = d.day
      left join uniq u on u.d = d.day
      order by d.day asc
    `;
    const r = await db.query(sql, [days, tz]);
    res.json({ ok: true, users: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
router.get('/summary/daily', summaryDaily);
router.get('/daily', summaryDaily);

export default router;
