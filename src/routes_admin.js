// src/routes_admin.js — V3.7 (MSK-safe dates, auth_success only, robust /events)
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

const getCols = async (table) => {
  const r = await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name=$1
  `,[table]);
  return new Set((r.rows||[]).map(x=>x.column_name));
};

// перенос времени в указанную TZ с безопасной проверкой типа столбца
const tzExpr = (alias='created_at', tbl='e') => `
CASE
  WHEN pg_typeof(${tbl}.${alias}) = 'timestamp with time zone'::regtype
    THEN (${tbl}.${alias} AT TIME ZONE $1)
  ELSE ((${tbl}.${alias} AT TIME ZONE 'UTC') AT TIME ZONE $1)
END
`;

/* ---------- USERS (как было) ---------- */
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

    // какие колонки реально есть
    const has = (c)=>cols.has(c);
    const idCol   = has('id') ? 'e.id' : 'row_number() over()';
    const uidCol  = has('user_id') ? 'e.user_id' : null;
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

    // WHERE
    const p=[]; const cond=[];
    const et = (req.query.type || req.query.event_type || '').toString().trim();
    if (et && (has('event_type') || has('type'))) {
      if (has('event_type')) cond.push(`e.event_type = $${p.push(et)}`);
      else                   cond.push(`e."type"     = $${p.push(et)}`);
    }
    const uid = (req.query.user_id||'').toString().trim();
    if (uid && uidCol) cond.push(`${uidCol} = $${p.push(parseInt(uid,10)||0)}`);
    const where = cond.length ? ('where ' + cond.join(' and ')) : '';

    const joinUsers = !!uidCol; // HUMid только если есть user_id
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

/* ---------- SUMMARY (MSK dates, только auth_success) ---------- */
router.get('/summary', async (req,res)=>{
  try{
    const tz = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    const u = await db.query('select count(*)::int as c from users');
    const users = u.rows?.[0]?.c ?? 0;

    const haveEvents = await db.query("select to_regclass('public.events') as r");
    if (!haveEvents.rows?.[0]?.r) {
      return res.json({ ok:true, users, events:0, auth7:0, unique7:0 });
    }

    const cols = await getCols('events');
    const hasType = cols.has('type');
    const hasEventType = cols.has('event_type');

    // только auth_success
    const authWhere = hasEventType ? 'e.event_type = \'auth_success\''
                    : hasType      ? 'e."type"     = \'auth_success\''
                    : 'false';

    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows?.[0]?.c ?? 0;

    // 7 дней с учётом TZ и типа created_at
    const r1 = await db.query(
      `select count(*)::int as c
         from events e
        where ${authWhere}
          and ${tzExpr('created_at','e')} > (now() at time zone $1) - interval '7 days'`,
      [tz]
    );
    const auth7_total = r1.rows?.[0]?.c ?? 0;

    // уникальные HUM по auth_success за 7 дней
    const r2 = await db.query(
      `select count(distinct coalesce(u.hum_id,u.id))::int as c
         from events e
         join users u on u.id = e.user_id
        where ${authWhere}
          and ${tzExpr('created_at','e')} > (now() at time zone $1) - interval '7 days'`,
      [tz]
    );
    const auth7 = r2.rows?.[0]?.c ?? 0;

    // уникальные HUM по всем событиям (для твоей карточки "Уникальные (7д)")
    const r3 = await db.query(
      `select count(distinct coalesce(u.hum_id,u.id))::int as c
         from events e
         join users u on u.id = e.user_id
        where ${tzExpr('created_at','e')} > (now() at time zone $1) - interval '7 days'`,
      [tz]
    );
    const unique7 = r3.rows?.[0]?.c ?? 0;

    res.json({ ok:true, users, events, auth7, auth7_total, unique7 });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* ---------- DAILY (MSK dates, только auth_success) ---------- */
async function daily(req,res){
  try{
    const days=Math.max(1,Math.min(31,parseInt(req.query.days||'7',10)));
    const tz  = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    const cols = await getCols('events');
    const hasType = cols.has('type');
    const hasEventType = cols.has('event_type');

    const authCond = hasEventType ? 'e.event_type = \'auth_success\''
                    : hasType      ? 'e."type"     = \'auth_success\''
                    : 'false';

    const r=await db.query(`
      with b as (
        select (now() at time zone $2)::date as today,
               ((now() at time zone $2)::date - ($1::int - 1)) as since
      ),
      d(day) as (select generate_series((select since from b),(select today from b), interval '1 day')),
      totals as (
        select (${tzExpr('created_at','e')})::date as d, count(*) c
          from events e
         where ${authCond}
           and (${tzExpr('created_at','e')})::date >= (select since from b)
         group by 1
      ),
      uniq as (
        select (${tzExpr('created_at','e')})::date as d,
               count(distinct coalesce(u.hum_id,u.id)) c
          from events e join users u on u.id=e.user_id
         where ${authCond}
           and (${tzExpr('created_at','e')})::date >= (select since from b)
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
      auth_total:Number(x.auth_total||0),
      auth_unique:Number(x.auth_unique||0)
    }));
    res.json({ ok:true, days: rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
router.get('/daily', daily);
router.get('/summary/daily', daily);

export default router;
