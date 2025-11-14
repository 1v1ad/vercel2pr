// src/routes_admin.js — FULL admin API (users, events, summary, daily, range) + HUM analytics
import express from 'express';
import { db } from './db.js';

const router = express.Router();
router.use(express.json());

// ---- Guard per route ----
const adminGuard = (req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  const got  = String(req.get('X-Admin-Password') || req.body?.pwd || req.query?.pwd || '');
  if (!need) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
};

// ---- Helpers ----
const tzOf = (req)=> (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();
function wantHum(req){
  const v = (req.query.include_hum ?? req.query.cluster ?? req.query.hum ?? '').toString().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}
const toInt = (v,def=0)=>{
  const n = parseInt(v,10);
  return Number.isFinite(n)?n:def;
};
async function tableExists(name){
  const r = await db.query("select to_regclass('public.'||$1) as r",[name]);
  return !!r.rows?.[0]?.r;
}
async function hasCol(table,col){
  const r = await db.query(`select 1 from information_schema.columns
    where table_schema='public' and table_name=$1 and column_name=$2`,[table,col]);
  return !!r.rows?.length;
}

// ---- Ping ----
router.get('/ping', adminGuard, (_req,res)=>res.json({ ok:true, now:new Date().toISOString() }));

// ---- USERS ----
// GET /api/admin/users?search=&take=50&skip=0
router.get('/users', adminGuard, async (req,res)=>{
  try{
    const haveUsers = await tableExists('users');
    if (!haveUsers) return res.json({ ok:true, users:[], rows:[] });
    const take = Math.min(Math.max(toInt(req.query.take,50),1),200);
    const skip = Math.max(toInt(req.query.skip,0),0);
    const q = (req.query.search || req.query.q || '').toString().trim();

    let users;
    if (q) {
      users = (await db.query(`
        select id, hum_id, vk_id, first_name, last_name, avatar, balance, country_code, created_at
        from users
        where cast(id as text) ilike $1
           or coalesce(first_name,'') ilike $1
           or coalesce(last_name,'') ilike $1
        order by id desc
        limit $2 offset $3
      `, ['%'+q+'%', take, skip])).rows;
    } else {
      users = (await db.query(`
        select id, hum_id, vk_id, first_name, last_name, avatar, balance, country_code, created_at
        from users
        order by id desc
        limit $1 offset $2
      `,[take, skip])).rows;
    }

    // providers
    const ids = users.map(u=>u.id);
    let map = new Map();
    if (ids.length && await tableExists('auth_accounts')){
      const prov = (await db.query(`
        select user_id, provider from auth_accounts where user_id = any($1)
      `,[ids])).rows;
      for (const p of prov){
        const arr = map.get(p.user_id) || [];
        if (!arr.includes(p.provider)) arr.push(p.provider);
        map.set(p.user_id, arr);
      }
    }
    const rows = users.map(u=>({ ...u, providers: map.get(u.id) || [] }));
    res.json({ ok:true, users: rows, rows });
  }catch(e){
    console.error('admin /users error', e);
    res.json({ ok:true, users:[], rows:[] });
  }
});

// ---- EVENTS ----
// GET /api/admin/events?term=&user_id=&take=50&skip=0
router.get('/events', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('events')) return res.json({ ok:true, events:[], rows:[] });
    const take = Math.min(Math.max(toInt(req.query.take,50),1),500);
    const skip = Math.max(toInt(req.query.skip,0),0);
    const userId = toInt(req.query.user_id, 0);
    const term = (req.query.term || req.query.search || '').toString().trim();

    let rows = [];
    if (userId){
      rows = (await db.query(`
        select id, user_id, hum_id, ip, ua,
               (case when exists (select 1 from information_schema.columns where table_name='events' and column_name='event_type')
                     then event_type::text else coalesce("type"::text,'') end) as event_type,
               payload, created_at
        from events
        where user_id = $1
        order by id desc
        limit $2 offset $3
      `,[userId, take, skip])).rows;
    } else if (term){
      rows = (await db.query(`
        select id, user_id, hum_id, ip, ua,
               (case when exists (select 1 from information_schema.columns where table_name='events' and column_name='event_type')
                     then event_type::text else coalesce("type"::text,'') end) as event_type,
               payload, created_at
        from events
        where cast(user_id as text) ilike $1
           or cast(hum_id as text) ilike $1
           or (case when exists (select 1 from information_schema.columns where table_name='events' and column_name='event_type')
                    then event_type::text else coalesce("type"::text,'') end) ilike $1
        order by id desc
        limit $2 offset $3
      `,['%'+term+'%', take, skip])).rows;
    } else {
      rows = (await db.query(`
        select id, user_id, hum_id, ip, ua,
               (case when exists (select 1 from information_schema.columns where table_name='events' and column_name='event_type')
                     then event_type::text else coalesce("type"::text,'') end) as event_type,
               payload, created_at
        from events
        order by id desc
        limit $1 offset $2
      `,[take, skip])).rows;
    }
    // ответ совместимый по типам
    res.json({ ok:true, events: rows, rows });
  }catch(e){
    console.error('admin /events error', e);
    res.json({ ok:true, events:[], rows:[] });
  }
});

// ---- SUMMARY ----
router.get('/summary', adminGuard, async (req,res)=>{
  try{
    const tz = tzOf(req);
    const incl = wantHum(req);
    let users = 0;
    try{ const r = await db.query('select count(*)::int as c from users'); users = r.rows?.[0]?.c ?? 0; }catch{}

    if (!await tableExists('events')) return res.json({ ok:true, users, events:0, auth7:0, auth7_total:0, unique7:0 });

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
    return res.json({ ok:true, users:0, events:0, auth7:0, auth7_total:0, unique7:0 });
  }
});

// ---- DAILY ----
router.get('/daily', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('events')) return res.json({ ok:true, days:[] });
    const tz = tzOf(req);
    const days = Math.max(1, Math.min(31, toInt(req.query.days||'7',10)));
    const incl = wantHum(req);
    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');

    const sql = `
      with b as ( select generate_series( (now() at time zone $1)::date - ($2::int-1), (now() at time zone $1)::date, '1 day') as d ),
      canon as (
        select (e.created_at at time zone $1)::date as d,
               case when $3::boolean then coalesce(u.hum_id,u.id) else u.id end as cluster_id,
               ` + (hasEventType ? "e.event_type::text" : (hasType ? 'e."type"::text' : "NULL::text")) + ` as et
        from events e join users u on u.id=e.user_id
        where (e.created_at at time zone $1)::date >= (select min(d) from b)
      ),
      auths  as ( select * from canon where (et is null) or et ilike '%login%success%' or et ilike '%auth%success%' or et ilike '%auth%' ),
      totals as ( select d, count(*) c from auths group by 1 ),
      uniq   as ( select d, count(distinct cluster_id) c from auths group by 1 )
      select to_char(b.d,'YYYY-MM-DD') as day, coalesce(t.c,0) as auth_total, coalesce(u.c,0) as auth_unique
        from b left join totals t on t.d=b.d left join uniq u on u.d=b.d order by b.d asc
    `;
    const r = await db.query(sql, [tz, days, incl]);
    const rows = (r.rows||[]).map(x=>({ date:x.day, auth_total:Number(x.auth_total||0), auth_unique:Number(x.auth_unique||0) }));
    res.json({ ok:true, days: rows });
  }catch(e){
    console.error('admin /daily error', e);
    res.json({ ok:true, days:[] });
  }
});

// ---- RANGE ----
router.get('/range', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('events')) return res.json({ ok:true, from:null, to:null, days:[] });
    const tz = tzOf(req);
    const incl = wantHum(req);
    const fromStr = (req.query.from || '').toString().trim();
    const toStr   = (req.query.to   || '').toString().trim();
    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');

    const sql = `
      with bounds as (
        select coalesce(nullif($2,''), to_char((now() at time zone $1)::date - 30, 'YYYY-MM-DD'))::date as d1,
               coalesce(nullif($3,''), to_char((now() at time zone $1)::date,       'YYYY-MM-DD'))::date as d2
      ),
      days as ( select generate_series((select d1 from bounds), (select d2 from bounds), '1 day')::date as d ),
      canon as (
        select (e.created_at at time zone $1)::date as d,
               case when $4::boolean then coalesce(u.hum_id,u.id) else u.id end as cluster_id,
               ` + (hasEventType ? "e.event_type::text" : (hasType ? 'e."type"::text' : "NULL::text")) + ` as et
        from events e join users u on u.id=e.user_id
        where (e.created_at at time zone $1)::date between (select d1 from bounds) and (select d2 from bounds)
      ),
      auths  as ( select * from canon where (et is null) or et ilike '%login%success%' or et ilike '%auth%success%' or et ilike '%auth%' ),
      totals as ( select d, count(*) c from auths group by 1 ),
      uniq   as ( select d, count(distinct cluster_id) c from auths group by 1 )
      select to_char(days.d,'YYYY-MM-DD') as day, coalesce(t.c,0) as auth_total, coalesce(u.c,0) as auth_unique
       from days left join totals t on t.d=days.d left join uniq u on u.d=days.d order by days.d asc
    `;
    const r = await db.query(sql, [tz, fromStr, toStr, incl]);
    const rows = (r.rows||[]).map(x=>({ date:x.day, auth_total:Number(x.auth_total||0), auth_unique:Number(x.auth_unique||0) }));
    const fromDate = rows.length ? rows[0].date : (fromStr || null);
    const toDate   = rows.length ? rows[rows.length-1].date : (toStr   || null);
    res.json({ ok:true, from: fromDate, to: toDate, days: rows });
  }catch(e){
    console.error('admin /range error', e);
    res.json({ ok:true, from:null, to:null, days:[] });
  }
});

export default router;
