// src/routes_admin.js — V3.8 (MSK, canonical logins, robust events)
import express from 'express';
import { db } from './db.js';

const router = express.Router();

/* ---------- auth ---------- */
router.use((req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  const got  = String(req.get('X-Admin-Password') || req.body?.pwd || req.query?.pwd || '');
  if (!need) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

/* ---------- helpers ---------- */
const getCols = async (table) => {
  const r = await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name=$1
  `,[table]);
  return new Set((r.rows||[]).map(x=>x.column_name));
};

// tzExprN(placeholderIndex, col, tbl)
// безопасно приводит created_at к нужной TZ, учитывая timestamp/timestamptz
const tzExprN = (n=1, col='created_at', tbl='e') => `
CASE
  WHEN pg_typeof(${tbl}.${col}) = 'timestamp with time zone'::regtype
    THEN (${tbl}.${col} AT TIME ZONE $${n})
  ELSE ((${tbl}.${col} AT TIME ZONE 'UTC') AT TIME ZONE $${n})
END
`;

/* ---------- USERS ---------- */
router.get('/users', async (req,res)=>{
  try{
    const take = Math.max(1,Math.min(500,parseInt(req.query.take||'50',10)));
    const skip = Math.max(0,parseInt(req.query.skip||'0',10));
    const search = (req.query.search||'').trim();

    const p=[]; let where='where 1=1';
    if (search){
      p.push(`%${search}%`,`%${search}%`,search,`%${search}%`);
      where += ` and (
        coalesce(u.first_name,'') ilike $${p.length-3} or
        coalesce(u.last_name ,'') ilike $${p.length-0} or
        u.id::text = $${p.length-1} or
        coalesce(u.vk_id::text,'') ilike $${p.length-2}
      )`;
    }
    p.push(take, skip);

    const sql=`
      with base as (
        select
          coalesce(u.hum_id, u.id) as hum_id,
          u.id                      as user_id,
          u.vk_id                   as vk_id,
          coalesce(u.first_name,'') as first_name,
          coalesce(u.last_name,'')  as last_name,
          coalesce(u.balance,0)     as balance_raw,
          coalesce(u.country_code,'') as country_code,
          coalesce(u.country_name,'') as country_name,
          coalesce(u.created_at, now()) as created_at,
          array_remove(array[
            case when u.vk_id is not null and u.vk_id::text !~ '^tg:' then 'vk' end,
            case when u.vk_id::text ilike 'tg:%' then 'tg' end
          ], null) as providers
        from users u
        ${where}
        order by 1 asc, 2 asc
        limit $${p.length-1} offset $${p.length}
      )
      select b.*, sum(b.balance_raw) over(partition by b.hum_id) as balance_hum
      from base b;
    `;
    const r=await db.query(sql,p);
    const rows=(r.rows||[]).map(u=>({
      HUMid:u.hum_id, hum_id:u.hum_id, id:u.hum_id,
      user_id:u.user_id, vk_id:u.vk_id,
      first_name:u.first_name, last_name:u.last_name,
      balance_raw:Number(u.balance_raw||0),
      balance:Number(u.balance_hum||0),
      country:u.country_code || u.country_name || '',
      country_code:u.country_code, country_name:u.country_name,
      created_at:u.created_at, providers:u.providers
    }));
    res.json({ ok:true, users:rows, rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* ---------- EVENTS (устойчиво к разной схеме) ---------- */
router.get('/events', async (req,res)=>{
  try{
    const cols = await getCols('events');
    if (!cols.size) return res.json({ ok:true, events:[], rows:[] });

    const take = Math.min(200, Math.max(1, parseInt(req.query.take||'50',10)));
    const skip = Math.max(0, parseInt(req.query.skip||'0',10));

    const has = (c)=>cols.has(c);
    const idCol   = has('id') ? 'e.id' : 'row_number() over()';
    const uidCol  = has('user_id') ? 'e.user_id'
                  : has('uid')      ? 'e.uid'
                  : has('user')     ? 'e."user"'
                  : null;
    const typeCol = has('event_type') ? 'e.event_type'
                  : has('type')       ? 'e."type"'
                  : `NULL::text`;
    const ipCol   = has('ip')        ? 'e.ip' : `NULL::text`;
    const uaCol   = has('ua')        ? 'e.ua'
                  : has('user_agent') ? 'e.user_agent'
                  : `NULL::text`;
    const tsCol   = has('created_at')? 'e.created_at'
                  : has('ts')         ? 'e.ts'
                  : has('time')       ? 'e.time'
                  : 'now()';

    const p=[]; const cond=[];
    const et = (req.query.type || req.query.event_type || '').toString().trim();
    if (et && (has('event_type') || has('type'))) {
      if (has('event_type')) cond.push(`e.event_type = $${p.push(et)}`);
      else                   cond.push(`e."type"     = $${p.push(et)}`);
    }
    const uid = (req.query.user_id||'').toString().trim();
    if (uid && uidCol) cond.push(`${uidCol} = $${p.push(parseInt(uid,10)||0)}`);
    const where = cond.length ? ('where ' + cond.join(' and ')) : '';

    const joinUsers = !!uidCol;
    p.push(take, skip);
    const sql = `
      select
        ${idCol}  as event_id,
        ${uidCol ? 'coalesce(u.hum_id, u.id)' : 'NULL'} as hum_id,
        ${uidCol ? uidCol : 'NULL'} as user_id,
        ${typeCol} as event_type,
        ${ipCol}   as ip,
        ${uaCol}   as ua,
        ${tsCol}   as created_at
      from events e
      ${joinUsers ? `left join users u on u.id = ${uidCol}` : ''}
      ${where}
      order by ${has('id') ? 'e.id' : '1'} desc
      limit $${p.length-1} offset $${p.length};
    `;
    const r=await db.query(sql,p);
    const rows=(r.rows||[]).map(e=>({
      id:e.event_id, HUMid:e.hum_id, user_id:e.user_id,
      event_type:e.event_type, type:e.event_type,
      ip:e.ip, ua:e.ua, created_at:e.created_at
    }));
    res.json({ ok:true, events:rows, rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* ---------- SUMMARY (MSK + канонические логины) ---------- */
router.get('/summary', async (req,res)=>{
  try{
    const tz = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    const u = await db.query('select count(*)::int as c from users');
    const users = u.rows?.[0]?.c ?? 0;

    const haveEvents = await db.query("select to_regclass('public.events') as r");
    if (!haveEvents.rows?.[0]?.r) {
      return res.json({ ok:true, users, events:0, auth7:0, auth7_total:0, unique7:0 });
    }

    // канонизация логинов: login_success + orphan auth_success (±10 мин от login_success того же user_id)
    const sql = `
      with b as (
        select (now() at time zone $1)::date as today,
               ((now() at time zone $1)::date - interval '7 days') as since
      ),
      ev as (
        select e.user_id,
               ${tzExprN(1,'created_at','e')} as ts_msk,
               coalesce(e.event_type::text, e."type"::text) as et
        from events e
      ),
      login as (select user_id, ts_msk from ev where et ilike '%login%success%'),
      auth  as (select user_id, ts_msk from ev where et ilike '%auth%success%'),
      auth_orphan as (
        select a.user_id, a.ts_msk
        from auth a
        left join login l
          on l.user_id = a.user_id
         and abs(extract(epoch from (a.ts_msk - l.ts_msk))) <= 600
        where l.user_id is null
      ),
      canon as (
        select * from login
        union all
        select * from auth_orphan
      )
      select
        (select count(*)::int
           from canon c
          where c.ts_msk::date >= (select since from b)
        ) as auth7_total,
        (select count(distinct coalesce(u.hum_id,u.id))::int
           from canon c join users u on u.id=c.user_id
          where c.ts_msk::date >= (select since from b)
        ) as auth7
    `;
    const r = await db.query(sql, [tz]);
    const x = r.rows?.[0] || {};

    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows?.[0]?.c ?? 0;

    // для твоей карточки «Уникальные (7д)» — по любым событиям
    const rU = await db.query(
      `select count(distinct coalesce(u.hum_id,u.id))::int as c
         from events e join users u on u.id=e.user_id
        where (${tzExprN(1,'created_at','e')}) > (now() at time zone $1) - interval '7 days'`,
      [tz]
    );

    res.json({
      ok:true,
      users,
      events,
      auth7_total: Number(x.auth7_total || 0),
      auth7:       Number(x.auth7 || 0),
      unique7:     Number(rU.rows?.[0]?.c || 0),
    });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* ---------- DAILY (MSK + канон. логины, фикс плейсхолдера) ---------- */
async function daily(req,res){
  try{
    const days = Math.max(1,Math.min(31,parseInt(req.query.days||'7',10)));
    const tz   = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    // Порядок плейсхолдеров: $1 = tz, $2 = days (чтобы tzExprN(1,…) попал в $1)
    const sql = `
      with b as (
        select (now() at time zone $1)::date as today,
               ((now() at time zone $1)::date - ($2::int - 1)) as since
      ),
      d(day) as (select generate_series((select since from b),(select today from b), interval '1 day')),
      ev as (
        select e.user_id,
               ${tzExprN(1,'created_at','e')} as ts_msk,
               coalesce(e.event_type::text, e."type"::text) as et
          from events e
         where (${tzExprN(1,'created_at','e')})::date >= (select since from b)
      ),
      login as (select user_id, ts_msk from ev where et ilike '%login%success%'),
      auth  as (select user_id, ts_msk from ev where et ilike '%auth%success%'),
      auth_orphan as (
        select a.user_id, a.ts_msk
          from auth a
          left join login l
            on l.user_id = a.user_id
           and abs(extract(epoch from (a.ts_msk - l.ts_msk))) <= 600
         where l.user_id is null
      ),
      canon as (
        select * from login
        union all
        select * from auth_orphan
      ),
      totals as ( select c.ts_msk::date d, count(*) c from canon c group by 1 ),
      uniq   as ( select c.ts_msk::date d, count(distinct coalesce(u.hum_id,u.id)) c
                  from canon c join users u on u.id=c.user_id group by 1 )
      select to_char(d.day,'YYYY-MM-DD') as day,
             coalesce(t.c,0) as auth_total,
             coalesce(u.c,0) as auth_unique
        from d
        left join totals t on t.d=d.day
        left join uniq   u on u.d=d.day
       order by d.day asc
    `;
    const r = await db.query(sql, [tz, days]);
    const rows = (r.rows||[]).map(x=>({
      date:x.day,
      auth_total:Number(x.auth_total||0),
      auth_unique:Number(x.auth_unique||0)
    }));
    res.json({ ok:true, days: rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
router.get('/daily', daily);
router.get('/summary/daily', daily);

export default router;
