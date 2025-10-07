// src/routes_admin.js — V3.6
import express from 'express';
import { db } from './db.js';
const router = express.Router();

router.use((req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || '');
  const got  = String(req.get('X-Admin-Password') || '');
  if (!need || got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

async function getCols(table){
  const r = await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name=$1
  `,[table]);
  return new Set((r.rows||[]).map(x=>x.column_name));
}
const tzArg = req => (req.query.tz || 'Europe/Moscow').toString();

/* -------- USERS (без изменений балансовой логики) -------- */
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
    const users=(r.rows||[]).map(u=>({
      id:u.hum_id, HUMid:u.hum_id, hum_id:u.hum_id,
      user_id:u.user_id, vk_id:u.vk_id,
      first_name:u.first_name, last_name:u.last_name,
      balance_raw:Number(u.balance_raw||0),
      balance:Number(u.balance_hum||0),                // суммарный по HUM (на будущее)
      country:u.country_code || u.country_name || '',
      country_code:u.country_code, country_name:u.country_name,
      created_at:u.created_at, providers:u.providers
    }));
    res.json({ ok:true, users, rows:users });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* -------- EVENTS (устойчиво к схеме) -------- */
router.get('/events', async (req,res)=>{
  try{
    const take = Math.max(1,Math.min(500,parseInt(req.query.take||'50',10)));
    const skip = Math.max(0,parseInt(req.query.skip||'0',10));
    const et   = (req.query.type || req.query.event_type || '').toString().trim();
    const uidQ = (req.query.user_id || '').toString().trim();

    const cols = await getCols('events');
    const hasId  = cols.has('id');
    const idCol  = hasId ? 'e.id' : 'row_number() over()';
    const uidCol = cols.has('user_id') ? 'e.user_id'
                : cols.has('uid')      ? 'e.uid'
                : cols.has('user')     ? 'e."user"'
                : null;
    const typeCol= cols.has('event_type') ? 'coalesce(e.event_type, \'\')'
                : cols.has('type')       ? 'coalesce(e.type, \'\')'
                : `''::text`;
    const ipCol  = cols.has('ip')         ? 'coalesce(e.ip, \'\')' : `''::text`;
    const uaCol  = cols.has('ua')         ? 'coalesce(e.ua, \'\')'
                : cols.has('user_agent')  ? 'coalesce(e.user_agent, \'\')'
                : `''::text`;
    const tsCol  = cols.has('created_at') ? 'coalesce(e.created_at, now())'
                : cols.has('ts')          ? 'e.ts'
                : cols.has('time')        ? 'e.time'
                : 'now()';

    const p=[]; const filters=[];
    if (et){ p.push(et); filters.push(`${typeCol} = $${p.length}`); }
    if (uidQ && /^\d+$/.test(uidQ) && uidCol){ p.push(Number(uidQ)); filters.push(`${uidCol} = $${p.length}`); }
    const where = filters.length? `where ${filters.join(' and ')}` : '';

    const joinUsers = !!uidCol; // JOIN только если есть колонка пользователя
    p.push(take, skip);
    const sql = `
      select
        ${idCol} as event_id,
        ${uidCol ? 'coalesce(u.hum_id, u.id)' : 'NULL'} as hum_id,
        ${uidCol ? uidCol : 'NULL'} as user_id,
        ${typeCol} as event_type,
        ${ipCol}   as ip,
        ${uaCol}   as ua,
        ${tsCol}   as created_at
      from events e
      ${joinUsers ? `left join users u on u.id = ${uidCol}` : ''}
      ${where}
      order by ${tsCol} desc, ${hasId ? 'e.id' : '1'} desc
      limit $${p.length-1} offset $${p.length};
    `;
    const r=await db.query(sql,p);
    const events=(r.rows||[]).map(e=>({
      id:e.event_id, HUMid:e.hum_id, user_id:e.user_id,
      event_type:e.event_type, type:e.event_type,
      ip:e.ip, ua:e.ua, created_at:e.created_at
    }));
    res.json({ ok:true, events, rows:events });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* -------- SUMMARY (MSK, success-only) -------- */
router.get('/summary', async (req,res)=>{
  try{
    const tz = tzArg(req);
    const r=await db.query(`
      with bounds as (
        select (now() at time zone $1)::date as today,
               ((now() at time zone $1)::date - interval '7 days') as since
      )
      select
        (select count(*) from users)  as users_total,
        (select count(*) from events) as events_total,
        (select count(*)
           from events e
          where (e.created_at at time zone $1)::date >= (select since from bounds)
            and (coalesce(e.event_type,'') ilike '%auth%success%'
              or coalesce(e.event_type,'') ilike '%login%success%')
        ) as auth7_total,
        (select count(distinct coalesce(u.hum_id,u.id))
           from events e join users u on u.id=e.user_id
          where (e.created_at at time zone $1)::date >= (select since from bounds)
            and (coalesce(e.event_type,'') ilike '%auth%success%'
              or coalesce(e.event_type,'') ilike '%login%success%')
        ) as auth7_distinct_hum,
        (select count(distinct coalesce(u.hum_id,u.id))
           from events e join users u on u.id=e.user_id
          where (e.created_at at time zone $1)::date >= (select since from bounds)
        ) as unique7_total
    `,[tz]);
    const x=r.rows?.[0]||{};
    res.json({ ok:true,
      users:Number(x.users_total||0),
      events:Number(x.events_total||0),
      auth7_total:Number(x.auth7_total||0),
      auth7:Number(x.auth7_distinct_hum||0),
      unique7:Number(x.unique7_total||0)
    });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* -------- DAILY (MSK, success-only, без “UTC-просачивания”) -------- */
async function daily(req,res){
  try{
    const days=Math.max(1,Math.min(31,parseInt(req.query.days||'7',10)));
    const tz  = tzArg(req);
    const r=await db.query(`
      with b as (
        select (now() at time zone $2)::date as today,
               ((now() at time zone $2)::date - ($1::int - 1)) as since
      ),
      d(day) as (select generate_series((select since from b),(select today from b), interval '1 day')),
      totals as (
        select (e.created_at at time zone $2)::date as d, count(*) c
        from events e
        where (e.created_at at time zone $2)::date >= (select since from b)
          and (coalesce(e.event_type,'') ilike '%auth%success%'
            or  coalesce(e.event_type,'') ilike '%login%success%')
        group by 1
      ),
      uniq as (
        select (e.created_at at time zone $2)::date as d, count(distinct coalesce(u.hum_id,u.id)) c
        from events e join users u on u.id=e.user_id
        where (e.created_at at time zone $2)::date >= (select since from b)
          and (coalesce(e.event_type,'') ilike '%auth%success%'
            or  coalesce(e.event_type,'') ilike '%login%success%')
        group by 1
      )
      select to_char(d.day,'YYYY-MM-DD') as day,
             coalesce(t.c,0) as auth_total,
             coalesce(u.c,0) as auth_unique
      from d
      left join totals t on t.d=d.day
      left join uniq   u on u.d=d.day
      order by d.day asc
    `,[days,tz]);

    const rows=(r.rows||[]).map(x=>({
      date:x.day,
      count:Number(x.auth_total||0),
      auth_total:Number(x.auth_total||0),
      auth_unique:Number(x.auth_unique||0)
    }));
    res.json({ ok:true, days: rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
router.get('/daily', daily);
router.get('/summary/daily', daily);

export default router;
