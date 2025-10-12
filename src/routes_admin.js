// src/routes_admin.js — V3.15 (topup by user_id; optional mode=hum)
import express from 'express';
import { db, logEvent } from './db.js';

const router = express.Router();
router.use(express.json());

/* -------------------- admin auth -------------------- */
router.use((req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  const got  = String(req.get('X-Admin-Password') || req.body?.pwd || req.query?.pwd || '');
  if (!need) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

/* -------------------- helpers -------------------- */
const getCols = async (table) => {
  const r = await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name=$1
  `,[table]);
  return new Set((r.rows||[]).map(x=>x.column_name));
};
const tzExprN = (n=1, col='created_at', tbl='e') => `
CASE
  WHEN pg_typeof(${tbl}.${col}) = 'timestamp with time zone'::regtype
    THEN (${tbl}.${col} AT TIME ZONE $${n})
  ELSE ((${tbl}.${col} AT TIME ZONE 'UTC') AT TIME ZONE $${n})
END`;

/* -------------------- users list -------------------- */
router.get('/users', async (req,res)=>{ /* (без изменений) */ 
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
          coalesce(u.hum_id, u.id)       as hum_id,
          u.id                            as user_id,
          u.vk_id                         as vk_id,
          coalesce(u.first_name,'')       as first_name,
          coalesce(u.last_name,'')        as last_name,
          coalesce(u.balance,0)           as balance_raw,
          coalesce(u.country_code,'')     as country_code,
          coalesce(u.country_name,'')     as country_name,
          coalesce(u.created_at, now())   as created_at,
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

/* -------------------- admin_topup -------------------- */
// POST /api/admin/users/:id/topup?mode=user|hum  body: { amount(≠0), comment }
router.post('/users/:id/topup', async (req, res) => {
  try {
    const userId = Number(req.params.id || 0);
    const amount = Math.trunc(Number(
      req.body.amount ?? req.body.value ?? req.body.sum ?? req.body.delta
    ) || 0);
    const comment = String(
      req.body.comment ?? req.body.note ?? req.body.reason ?? req.body.description ?? ''
    ).trim();
    const mode = String(req.query.mode || 'user'); // 'user' (default) or 'hum'

    if (!userId) return res.status(400).json({ ok:false, error:'user_required' });
    if (!amount)  return res.status(400).json({ ok:false, error:'amount_required' }); // ноль запрещён
    if (!comment) return res.status(400).json({ ok:false, error:'comment_required' });

    const ru = await db.query(
      'select id, coalesce(hum_id, id) hum_id from users where id = $1 limit 1',[userId]
    );
    if (!ru.rows?.length) return res.status(404).json({ ok:false, error:'user_not_found' });
    const humId = Number(ru.rows[0].hum_id);

    if (mode === 'hum') {
      // пополнение всего HUM-кластера (опционально)
      await db.query(
        'update users set balance = coalesce(balance,0) + $2 where coalesce(hum_id,id) = $1',
        [humId, amount]
      );
    } else {
      // по умолчанию — пополняем ТОЛЬКО конкретного user_id
      await db.query(
        'update users set balance = coalesce(balance,0) + $2 where id = $1',
        [userId, amount]
      );
    }

    const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHeader.split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0,256);

    await logEvent({
      user_id: userId,
      event_type: 'admin_topup',
      payload: { user_id: userId, hum_id: humId, amount, comment, mode },
      ip, ua, country_code: null
    });

    const total = await db.query(
      'select sum(coalesce(balance,0))::bigint as hum_balance from users where coalesce(hum_id,id) = $1',
      [humId]
    );
    res.json({ ok:true, hum_id: humId, new_balance: Number(total.rows?.[0]?.hum_balance || 0) });
  } catch (e) {
    console.error('admin topup error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

/* -------------------- events / summary / daily -------------------- */
// остальной код без изменений (как в твоей версии)
router.get('/events', async (req,res)=>{ /* ... всё как было у тебя ... */ 
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
    const typeExpr= has('event_type') ? 'e.event_type::text'
                  : has('type')       ? 'e."type"::text'
                  : `NULL::text`;
    const ipCol   = has('ip')        ? 'e.ip' : `NULL::text`;
    const uaCol   = has('ua')        ? 'e.ua'
                  : has('user_agent') ? 'e.user_agent'
                  : `NULL::text`;
    const tsCol   = has('created_at')? 'e.created_at'
                  : has('ts')         ? 'e.ts'
                  : has('time')       ? 'e.time'
                  : 'now()';

    const amountExpr = `
      COALESCE(
        ${has('amount') ? 'e.amount::bigint' : 'NULL'},
        ${has('payload') ? "NULLIF((e.payload->>'amount'),'')::bigint" : 'NULL'},
        ${has('payload') ? "NULLIF((e.payload->>'value'),'')::bigint"  : 'NULL'},
        ${has('payload') ? "NULLIF((e.payload->>'sum'),'')::bigint"    : 'NULL'},
        ${has('payload') ? "NULLIF((e.payload->>'delta'),'')::bigint"  : 'NULL'},
        0::bigint
      )`;

    const commentExpr = `
      COALESCE(
        ${has('comment') ? 'NULLIF(e.comment, \'\')' : 'NULL'},
        ${has('meta') ? "NULLIF(e.meta->>'comment','')" : 'NULL'},
        ${has('meta') ? "NULLIF(e.meta->>'note','')"     : 'NULL'},
        ${has('meta') ? "NULLIF(e.meta->>'reason','')"   : 'NULL'},
        ${has('meta') ? "NULLIF(e.meta->>'description','')" : 'NULL'},
        ${has('payload') ? "NULLIF(e.payload->>'comment','')" : 'NULL'},
        ${has('payload') ? "NULLIF(e.payload->>'note','')"     : 'NULL'},
        ${has('payload') ? "NULLIF(e.payload->>'reason','')"   : 'NULL'},
        ${has('payload') ? "NULLIF(e.payload->>'description','')" : 'NULL'}
      )`;

    const humExpr = `
      COALESCE(
        ${has('hum_id') ? 'e.hum_id' : 'NULL'},
        ${has('payload') ? "NULLIF((e.payload->>'hum_id'),'')::bigint" : 'NULL'},
        ${uidCol ? 'u.hum_id' : 'NULL'},
        ${uidCol ? 'u.id'     : 'NULL'}
      )`;

    const p=[]; const cond=[];
    const et = (req.query.type || req.query.event_type || '').toString().trim();
    if (et && (has('event_type') || has('type'))) {
      if (cols.has('event_type')) cond.push(`e.event_type = $${p.push(et)}`);
      else                        cond.push(`e."type"     = $${p.push(et)}`);
    }
    const uid = (req.query.user_id||'').toString().trim();
    if (uid && uidCol) cond.push(`${uidCol} = $${p.push(parseInt(uid,10)||0)}`);
    const where = cond.length ? ('where ' + cond.join(' and ')) : '';

    const joinUsers = !!uidCol;
    p.push(Math.min(200, Math.max(1, parseInt(req.query.take||'50',10))), Math.max(0, parseInt(req.query.skip||'0',10)));
    const sql = `
      select
        ${idCol}  as event_id,
        ${uidCol ? uidCol : (has('payload') ? "NULLIF((e.payload->>'user_id'),'')::bigint" : 'NULL')} as user_id,
        ${typeExpr} as event_type,
        ${ipCol}   as ip,
        ${uaCol}   as ua,
        ${tsCol}   as created_at,
        ${amountExpr} as amount,
        ${commentExpr} as comment,
        ${humExpr} as hum_id
      from events e
      ${joinUsers ? `left join users u on u.id = ${uidCol}` : ''}
      ${where}
      order by ${cols.has('id') ? 'e.id' : 'created_at'} desc
      limit $${p.length-1} offset $${p.length};
    `;
    const r=await db.query(sql,p);
    const rows=(r.rows||[]).map(e=>({
      id:e.event_id,
      user_id:e.user_id!=null ? Number(e.user_id) : null,
      HUMid:e.hum_id!=null ? Number(e.hum_id) : null,
      event_type:e.event_type, type:e.event_type,
      ip:e.ip, ua:e.ua, created_at:e.created_at,
      amount: e.amount!=null ? Number(e.amount) : 0,
      comment: e.comment || null
    }));
    res.json({ ok:true, events:rows, rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

/* -------------------- summary / daily -------------------- */
router.get('/summary', async (req,res)=>{ /* как было */ 
  try{
    const tz = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    const u = await db.query('select count(*)::int as c from users');
    const users = u.rows?.[0]?.c ?? 0;

    const haveEvents = await db.query("select to_regclass('public.events') as r");
    if (!haveEvents.rows?.[0]?.r) {
      return res.json({ ok:true, users, events:0, auth7:0, auth7_total:0, unique7:0 });
    }

    const cols = await getCols('events');
    const typeExpr = cols.has('event_type') ? 'e.event_type::text'
                    : cols.has('type')       ? 'e."type"::text'
                    : `NULL::text`;

    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows?.[0]?.c ?? 0;

    const sql = `
      with b as (
        select (now() at time zone $1)::date as today,
               ((now() at time zone $1)::date - interval '7 days') as since
      ),
      ev as (select e.user_id, ${tzExprN(1,'created_at','e')} as ts_msk, ${typeExpr} as et from events e),
      login as (select user_id, ts_msk from ev where et ilike '%login%success%'),
      auth  as (select user_id, ts_msk from ev where et ilike '%auth%success%'),
      auth_orphan as (
        select a.user_id, a.ts_msk
          from auth a left join login l
            on l.user_id = a.user_id and abs(extract(epoch from (a.ts_msk - l.ts_msk))) <= 600
         where l.user_id is null
      ),
      canon as (select * from login union all select * from auth_orphan)
      select
        (select count(*)::int from canon c where c.ts_msk::date >= (select since from b)) as auth7_total,
        (select count(distinct coalesce(u.hum_id,u.id))::int from canon c join users u on u.id=c.user_id
          where c.ts_msk::date >= (select since from b)) as auth7
    `;
    const r = await db.query(sql, [tz]);
    const x = r.rows?.[0] || {};

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

async function daily(req,res){
  try{
    const days = Math.max(1,Math.min(31,parseInt(req.query.days||'7',10)));
    const tz   = (req.query.tz || process.env.ADMIN_TZ || 'Europe/Moscow').toString();

    const cols = await getCols('events');
    const typeExpr = cols.has('event_type') ? 'e.event_type::text'
                    : cols.has('type')       ? 'e."type"::text'
                    : `NULL::text`;

    const sql = `
      with b as (
        select (now() at time zone $1)::date as today,
               ((now() at time zone $1)::date - ($2::int - 1)) as since
      ),
      d(day) as (select generate_series((select since from b),(select today from b), interval '1 day')),
      ev as (
        select e.user_id, ${tzExprN(1,'created_at','e')} as ts_msk, ${typeExpr} as et
          from events e
         where (${tzExprN(1,'created_at','e')})::date >= (select since from b)
      ),
      login as (select user_id, ts_msk from ev where et ilike '%login%success%'),
      auth  as (select user_id, ts_msk from ev where et ilike '%auth%success%'),
      auth_orphan as (
        select a.user_id, a.ts_msk
          from auth a left join login l
            on l.user_id = a.user_id and abs(extract(epoch from (a.ts_msk - l.ts_msk))) <= 600
         where l.user_id is null
      ),
      canon as (select * from login union all select * from auth_orphan),
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
    const rows = (r.rows||[]).map(x=>({ date:x.day, auth_total:Number(x.auth_total||0), auth_unique:Number(x.auth_unique||0) }));
    res.json({ ok:true, days: rows });
  }catch(e){ res.status(500).json({ ok:false, error:String(e?.message||e) }); }
}
router.get('/daily', daily);
router.get('/summary/daily', daily);

export default router;
