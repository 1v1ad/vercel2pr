// src/routes_admin.js — SAFE ROLLBACK + HUM analytics
import express from 'express';
import { db, logEvent } from './db.js';

const router = express.Router();
router.use(express.json());

// --- Admin guard (per-route) ---
const adminGuard = (req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  const got  = String(req.get('X-Admin-Password') || req.body?.pwd || req.query?.pwd || '');
  if (!need) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
};

// --- Helpers ---
function wantHum(req){
  const v = (req.query.include_hum ?? req.query.cluster ?? req.query.hum ?? '').toString().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true; // default on
}
const tzOf = (req) => (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

const colsCache = new Map();
async function hasCol(table, col){
  const key = table+'|'+col;
  if (colsCache.has(key)) return colsCache.get(key);
  const r = await db.query(`
    select 1 from information_schema.columns 
     where table_schema='public' and table_name=$1 and column_name=$2
  `,[table, col]);
  const ok = !!r.rows?.length;
  colsCache.set(key, ok);
  return ok;
}

// --- Health ---
router.get('/ping', adminGuard, (_req,res)=> res.json({ ok:true, now:new Date().toISOString() }));

// --- SUMMARY: top counters ---
router.get('/summary', adminGuard, async (req,res)=>{
  try{
    const tz = tzOf(req);
    const incl = wantHum(req);

    // users total
    let users = 0;
    try{
      const r = await db.query('select count(*)::int as c from users');
      users = r.rows?.[0]?.c ?? 0;
    }catch{}

    // events presence
    const evt = await db.query("select to_regclass('public.events') as r");
    if (!evt.rows?.[0]?.r) {
      return res.json({ ok:true, users, events:0, auth7:0, auth7_total:0, unique7:0 });
    }

    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');

    const sql = `
      with b as (
        select (now() at time zone $1)::date as d2, ((now() at time zone $1)::date - 6) as d1
      ),
      canon as (
        select 
          e.user_id,
          case when $2::boolean then coalesce(u.hum_id,u.id) else u.id end as cluster_id,
          (e.created_at at time zone $1) as ts_msk,
          ` + (hasEventType ? "e.event_type::text" : (hasType ? 'e."type"::text' : "NULL::text")) + ` as et
        from events e 
        join users u on u.id = e.user_id
        where (e.created_at at time zone $1)::date between (select d1 from b) and (select d2 from b)
      ),
      auths as (
        select * from canon 
        where (et is null) 
           or et ilike '%login%success%' 
           or et ilike '%auth%success%' 
           or et ilike '%auth%'
      ),
      t_events as (select count(*)::int as c from events),
      t_total  as (select count(*)::int as c from auths),
      t_unique as (select count(distinct cluster_id)::int as c from auths)
      select 
        (select c from t_events) as events,
        (select c from t_total)  as auth7_total,
        (select c from t_unique) as unique7
    `;
    const q = await db.query(sql, [tz, incl]);
    const events   = q.rows?.[0]?.events   ?? 0;
    const auth7tot = q.rows?.[0]?.auth7_total ?? 0;
    const unique7  = q.rows?.[0]?.unique7  ?? 0;

    return res.json({ ok:true, users, events, auth7:unique7, auth7_total:auth7tot, unique7 });
  }catch(e){
    console.error('admin /summary error', e);
    return res.status(200).json({ ok:true, users:0, events:0, auth7:0, auth7_total:0, unique7:0 });
  }
});

// --- DAILY (kept minimal compat) ---
router.get('/daily', adminGuard, async (req,res)=>{
  try{
    const tz = tzOf(req);
    const days = Math.max(1, Math.min(31, parseInt(req.query.days||'7',10)));
    const incl = wantHum(req);

    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');

    const sql = `
      with b as (
        select generate_series( (now() at time zone $1)::date - ($2::int-1), (now() at time zone $1)::date, '1 day') as d
      ),
      canon as (
        select 
          (e.created_at at time zone $1)::date as d,
          case when $3::boolean then coalesce(u.hum_id,u.id) else u.id end as cluster_id,
          ` + (hasEventType ? "e.event_type::text" : (hasType ? 'e."type"::text' : "NULL::text")) + ` as et
        from events e join users u on u.id=e.user_id
        where (e.created_at at time zone $1)::date >= (select min(d) from b)
      ),
      auths as (
        select * from canon 
        where (et is null) 
           or et ilike '%login%success%' 
           or et ilike '%auth%success%' 
           or et ilike '%auth%'
      ),
      totals as (select d, count(*) c from auths group by 1),
      uniq   as (select d, count(distinct cluster_id) c from auths group by 1)
      select to_char(b.d,'YYYY-MM-DD') as day,
             coalesce(t.c,0) as auth_total,
             coalesce(u.c,0) as auth_unique
        from b
        left join totals t on t.d=b.d
        left join uniq   u on u.d=b.d
       order by b.d asc
    `;
    const r = await db.query(sql, [tz, days, incl]);
    const rows = (r.rows||[]).map(x=>({ date:x.day, auth_total:Number(x.auth_total||0), auth_unique:Number(x.auth_unique||0) }));
    res.json({ ok:true, days: rows });
  }catch(e){
    console.error('admin /daily error', e);
    res.json({ ok:true, days: [] });
  }
});

// --- RANGE (line chart) ---
router.get('/range', adminGuard, async (req,res)=>{
  try{
    const tz = tzOf(req);
    const incl = wantHum(req);
    const fromStr = (req.query.from || '').toString().trim(); // 'YYYY-MM-DD'
    const toStr   = (req.query.to   || '').toString().trim();

    const evt = await db.query("select to_regclass('public.events') as r");
    if (!evt.rows?.[0]?.r) {
      return res.json({ ok:true, from:null, to:null, days:[] });
    }

    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');

    const sql = `
      with bounds as (
        select 
          coalesce(nullif($2,''), to_char((now() at time zone $1)::date - 30, 'YYYY-MM-DD'))::date as d1,
          coalesce(nullif($3,''), to_char((now() at time zone $1)::date,       'YYYY-MM-DD'))::date as d2
      ),
      days as (
        select generate_series((select d1 from bounds), (select d2 from bounds), '1 day'::interval)::date as d
      ),
      canon as (
        select 
          (e.created_at at time zone $1)::date as d,
          case when $4::boolean then coalesce(u.hum_id,u.id) else u.id end as cluster_id,
          ` + (hasEventType ? "e.event_type::text" : (hasType ? 'e."type"::text' : "NULL::text")) + ` as et
        from events e join users u on u.id=e.user_id
        where (e.created_at at time zone $1)::date between (select d1 from bounds) and (select d2 from bounds)
      ),
      auths as (
        select * from canon 
        where (et is null) 
           or et ilike '%login%success%' 
           or et ilike '%auth%success%' 
           or et ilike '%auth%'
      ),
      totals as (select d, count(*) c from auths group by 1),
      uniq   as (select d, count(distinct cluster_id) c from auths group by 1)
      select to_char(days.d,'YYYY-MM-DD') as day,
             coalesce(t.c,0) as auth_total,
             coalesce(u.c,0) as auth_unique
        from days
        left join totals t on t.d=days.d
        left join uniq   u on u.d=days.d
       order by days.d asc
    `;
    const q = await db.query(sql, [tz, fromStr, toStr, incl]);
    const rows = (q.rows||[]).map(x=>({ date:x.day, auth_total:Number(x.auth_total||0), auth_unique:Number(x.auth_unique||0) }));
    const fromDate = rows.length ? rows[0].date : (fromStr || null);
    const toDate   = rows.length ? rows[rows.length-1].date : (toStr   || null);
    res.json({ ok:true, from: fromDate, to: toDate, days: rows });
  }catch(e){
    console.error('admin /range error', e);
    res.json({ ok:true, from:null, to:null, days: [] });
  }
});

export default router;
