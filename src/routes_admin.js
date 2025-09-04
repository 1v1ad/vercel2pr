// src/routes_admin.js — add providers[] for users + keep robust behavior
import { Router } from 'express';
import { db } from './db.js';
import { mergeSuggestions } from './merge.js';

const router = Router();

function firstIp(req){
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}


function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '').toString();
  const given = (req.get('X-Admin-Password') || (req.body && req.body.pwd) || req.query.pwd || '').toString();
  if (!serverPass) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (given !== serverPass) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}
router.use(adminAuth);

router.get('/health', (_req, res) => res.json({ ok:true }));

router.get('/summary', async (_req, res) => {
  try {
    const u = await db.query('select count(*)::int as c from users');
    let users = u.rows[0]?.c ?? 0;

    const hasT = await db.query("select to_regclass('public.events') as r");
    if (!hasT.rows[0].r) return res.json({ ok:true, users, events:0, auth7:0, unique7:0 });

    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType = set.has('type');
    const hasEventType = set.has('event_type');

    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows[0]?.c ?? 0;
    let auth7 = 0;
    try {
      const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
      const set = new Set(cols.rows.map(r => r.column_name));
      const hasType = set.has('type');
      const hasEventType = set.has('event_type');
      const whereParts = [];
      const AUTH_SET = "('auth_success')";
      if (hasEventType) whereParts.push(`event_type in ${AUTH_SET}`);
      if (hasType)      whereParts.push(`"type" in ${AUTH_SET}`);
      const w = whereParts.length ? '(' + whereParts.join(' or ') + ')' : 'false';
      const r2 = await db.query(`select count(*)::int as c from events where ${w} and created_at > now() - interval '7 days'`);
      auth7 = r2.rows[0]?.c ?? 0;
    } catch {}
    let unique7 = 0;
    try {
      const r3 = await db.query(`
        select count(distinct coalesce(nullif(u.meta->>'merged_into','')::int, u.id))::int as c
          from events e
          join users u on u.id = e.user_id
         where (e.event_type = 'auth_success' or "type" = 'auth_success')
           and e.created_at > now() - interval '7 days'
      `);
      unique7 = r3.rows[0]?.c ?? 0;
    } catch {}
    

    let auth7 = 0;
    if (hasType || hasEventType) {
      const parts = [];
    parts.push("event_type = 'auth_success'");
    parts.push("\"type\" = 'auth_success'");
    const authCond = '(' + parts.join(' or ') + ')';

    // Собираем последнюю неделю с нулями через generate_series
    const sql = `
      with days as (
        select generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                               date_trunc('day', now()),
                               interval '1 day') as d
      ),
      auth as (
        select date_trunc('day', created_at) as d, count(*)::int as c
          from events
         where ${authCond}
         group by 1
      ),
      uniq as (
        select date_trunc('day', created_at) as d,
               count(distinct coalesce(nullif(u.meta->>'merged_into','')::int, u.id))::int as c
          from events e
          join users u on u.id = e.user_id
         where event_type = 'auth_success' or "type" = 'auth_success'
         group by 1
      )
      select to_char(days.d, 'YYYY-MM-DD') as day,
             coalesce(auth.c, 0)   as auth,
             coalesce(uniq.c, 0)   as uniq
        from days
        left join auth on auth.d = days.d
        left join uniq on uniq.d = days.d
       order by days.d;
    `;

    const r = await db.query(sql, [days]);
    const labels = r.rows.map(x => x.day);
    const auth   = r.rows.map(x => x.auth);
    const unique = r.rows.map(x => x.uniq);

    res.json({ ok:true, labels, auth, unique });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

export default router;
