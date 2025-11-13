// src/routes_admin.js - drop-in fix for /range endpoint
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

// SAFE /range (supports ?from, ?to, ?tz, ?analytics=1)
router.get('/range', async (req, res) => {
  try {
    const adminPwd = req.headers['x-admin-password'] || req.headers['X-Admin-Password'];
    if (!adminPwd || adminPwd !== (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '')) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const tz = (req.query.tz || 'Europe/Moscow').toString();
    const fromQ = (req.query.from || '').toString().trim();
    const toQ   = (req.query.to   || '').toString().trim();
    const analytics = String(req.query.analytics || '0') === '1';

    const today = new Date().toISOString().slice(0,10);
    const to = toQ.match(/^\d{4}-\d{2}-\d{2}$/) ? toQ : today;
    const from = fromQ.match(/^\d{4}-\d{2}-\d{2}$/) ? fromQ :
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

    if (analytics) {
      days.forEach(r => r.auth_unique_analytics = r.auth_unique);
    }

    return res.json({ ok:true, from, to, days });
  } catch (e) {
    console.error('admin/range error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
