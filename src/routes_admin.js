// src/routes_admin.js  (ESM)
import express from 'express';
import { db } from './db.js';

const router = express.Router();

// --- простая админ-авторизация через заголовок ---
router.use((req,res,next)=>{
  const need = (process.env.ADMIN_PASSWORD || '').toString();
  const got  = (req.get('X-Admin-Password') || '').toString();
  if (!need || got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

// ---------- USERS ----------
router.get('/users', async (req,res)=>{
  try{
    const take = Math.max(1,Math.min(500,parseInt(req.query.take||'50',10)));
    const skip = Math.max(0,parseInt(req.query.skip||'0',10));
    const search = (req.query.search||'').trim();

    const params=[]; let where='where 1=1';
    if (search){
      params.push(`%${search}%`,`%${search}%`,search,`%${search}%`);
      where += ` and (coalesce(u.first_name,'') ilike $${params.length-3}
                    or coalesce(u.last_name,'')  ilike $${params.length}
                    or u.id::text               =     $${params.length-1}
                    or coalesce(u.vk_id::text,'') ilike $${params.length-2})`;
    }
    params.push(take, skip);

    const sql=`
      select
        /* hum_id может отсутствовать — тогда просто вернём id */
        coalesce(u.hum_id, u.id)         as hum_id,
        u.id                              as user_id,
        u.vk_id                           as vk_id,
        coalesce(u.first_name,'')         as first_name,
        coalesce(u.last_name,'')          as last_name,
        coalesce(u.balance,0)             as balance,
        coalesce(u.country_code,'')       as country_code,
        coalesce(u.country_name,'')       as country_name,
        coalesce(u.created_at, now())     as created_at,
        array_remove(array[
          case when u.vk_id is not null and u.vk_id::text !~ '^tg:' then 'vk' end,
          case when u.vk_id::text ilike 'tg:%' then 'tg' end
        ], null)                          as providers
      from users u
      ${where}
      order by hum_id asc, user_id asc
      limit $${params.length-1} offset $${params.length}
    `;
    const r=await db.query(sql, params);

    // Отдаём и «старые» и «новые» имена полей, чтобы фронт любой версии прожил
    const users=(r.rows||[]).map(u=>({
      // алиасы под старый фронт:
      id: u.hum_id,                // ← в колонке HUMid у старой верстки стоит u.id
      vk_id: u.vk_id,
      // «новые» поля:
      HUMid: u.hum_id,
      hum_id: u.hum_id,
      user_id: u.user_id,
      first_name: u.first_name,
      last_name: u.last_name,
      balance: u.balance,
      country: u.country_code || u.country_name || '',
      country_code: u.country_code,
      country_name: u.country_name,
      created_at: u.created_at,
      providers: u.providers
    }));

    res.json({ ok:true, users, rows: users });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ---------- EVENTS ----------
router.get('/events', async (req,res)=>{
  try{
    const take = Math.max(1,Math.min(500,parseInt(req.query.take||'50',10)));
    const skip = Math.max(0,parseInt(req.query.skip||'0',10));
    const params=[]; const filters=[];

    const et = (req.query.type || req.query.event_type || '').toString().trim();
    if (et && /^[\w:-]+$/.test(et)){ params.push(et); filters.push(`e.event_type = $${params.length}`); }

    const uidRaw=(req.query.user_id||'').toString().trim();
    if (/^\d+$/.test(uidRaw)){ params.push(Number(uidRaw)); filters.push(`e.user_id = $${params.length}`); }

    const where = filters.length?`where ${filters.join(' and ')}`:'';
    params.push(take,skip);

    const sql=`
      select
        e.id as event_id,
        coalesce(u.hum_id, u.id) as hum_id,
        e.user_id,
        coalesce(e.event_type,'') as event_type,
        coalesce(e.ip,'') as ip,
        coalesce(e.ua,'') as ua,
        coalesce(e.created_at, now()) as created_at
      from events e
      left join users u on u.id = e.user_id
      ${where}
      order by e.id desc
      limit $${params.length-1} offset $${params.length}
    `;
    const r=await db.query(sql, params);
    const events=(r.rows||[]).map(e=>({
      id:e.event_id,
      HUMid:e.hum_id,
      user_id:e.user_id,
      event_type:e.event_type,
      type:e.event_type, // алиас
      ip:e.ip,
      ua:e.ua,
      created_at:e.created_at
    }));
    res.json({ ok:true, events, rows: events });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ---------- SUMMARY ----------
router.get('/summary', async (req,res)=>{
  try{
    const r=await db.query(`
      with recent as ( select now() - interval '7 days' as ts )
      select
        (select count(*) from users) as users_total,
        (select count(*) from events) as events_total,
        (select count(distinct coalesce(u.hum_id,u.id))
           from events e join users u on u.id=e.user_id
          where e.created_at >= (select ts from recent)
            and (coalesce(e.event_type,'') ilike 'auth%' or coalesce(e.event_type,'') ilike 'login%')
        ) as auth7_distinct_hum,
        (select count(distinct coalesce(u.hum_id,u.id))
           from events e join users u on u.id=e.user_id
          where e.created_at >= (select ts from recent)
        ) as unique7_total
    `);
    const row=r.rows?.[0]||{};
    res.json({
      ok:true,
      users:Number(row.users_total||0),
      events:Number(row.events_total||0),
      auth7:Number(row.auth7_distinct_hum||0),
      unique7:Number(row.unique7_total||0)
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ---------- DAILY (auth по HUM, а не по user_id) ----------
async function handleDaily(req,res){
  try{
    const days=Math.max(1,Math.min(31,parseInt(req.query.days||'7',10)));
    const tz  =(req.query.tz||'Europe/Moscow').toString();
    const sql=`
      with bounds as (select (date_trunc('day',(now() at time zone $2))::date) as today),
      days as (
        select (select today from bounds) - s as d
        from generate_series($1::int - 1, 0, -1) s
      ),
      auth as (
        select (e.created_at at time zone $2)::date d, count(distinct coalesce(u.hum_id,u.id)) c
        from events e join users u on u.id=e.user_id
        where e.created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
          and (coalesce(e.event_type,'') ilike 'auth%' or coalesce(e.event_type,'') ilike 'login%')
        group by 1
      ),
      uniq as (
        select (e.created_at at time zone $2)::date d, count(distinct coalesce(u.hum_id,u.id)) c
        from events e join users u on u.id=e.user_id
        where e.created_at >= ((select today from bounds)::timestamp - ($1::int - 1) * interval '1 day')
        group by 1
      )
      select to_char(d.d,'YYYY-MM-DD') as day, coalesce(a.c,0) as auth, coalesce(u.c,0) as unique
      from days d left join auth a on a.d=d.d left join uniq u on u.d=d.d
      order by d.d asc
    `;
    const r=await db.query(sql,[days,tz]);
    const rows=(r.rows||[]).map(x=>({ date:x.day, auth:Number(x.auth||0), unique:Number(x.unique||0) }));
    res.json({ ok:true, days: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
router.get('/daily', handleDaily);
router.get('/summary/daily', handleDaily);

export default router;
