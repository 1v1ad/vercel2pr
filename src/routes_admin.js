// src/routes_admin.js — consolidated admin API + manual topup

import express from 'express';
import { db } from './db.js';
import { mergeSuggestions, ensureMetaColumns } from './merge.js';

const router = express.Router();
router.use(express.json());


// ---- Guard (per-route) ----
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
router.get('/users', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('users')) return res.json({ ok:true, users:[], rows:[] });

    const tz   = tzOf(req); // таймзона админки, по умолчанию Europe/Moscow
    const take = Math.min(Math.max(toInt(req.query.take,50),1),200);
    const skip = Math.max(toInt(req.query.skip,0),0);
    const q    = (req.query.search || req.query.q || '').toString().trim();

    let users;
    if (q) {
      users = (await db.query(`
        select
          id,
          hum_id,
          vk_id,
          first_name,
          last_name,
          avatar,
          balance,
          country_code,
          (created_at at time zone 'UTC' at time zone $2) as created_at
        from users
        where cast(id as text) ilike $1
           or coalesce(first_name,'') ilike $1
           or coalesce(last_name,'') ilike $1
        order by id desc
        limit $3 offset $4
      `, ['%'+q+'%', tz, take, skip])).rows;
    } else {
      users = (await db.query(`
        select
          id,
          hum_id,
          vk_id,
          first_name,
          last_name,
          avatar,
          balance,
          country_code,
          (created_at at time zone 'UTC' at time zone $1) as created_at
        from users
        order by id desc
        limit $2 offset $3
      `, [tz, take, skip])).rows;
    }

    // providers (optional)
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



// ---- HUM CLUSTER + UNMERGE ----

// GET /api/admin/cluster?hum_id=123
router.get('/cluster', adminGuard, async (req,res)=>{
  try{
    const humId = toInt(req.query.hum_id, 0);
    if (!humId) return res.status(400).json({ ok:false, error:'bad_hum_id' });
    if (!await tableExists('users')) return res.json({ ok:true, hum_id:humId, users:[] });

    const uRes = await db.query(`
      select id, first_name, last_name, country_code, balance, hum_id
        from users
       where coalesce(hum_id, id) = $1
       order by id
    `,[humId]);
    const users = uRes.rows || [];

    let accountsByUser = {};
    if (users.length && await tableExists('auth_accounts')) {
      const ids = users.map(u=>u.id);
      const aRes = await db.query(`
        select user_id, provider, provider_user_id
          from auth_accounts
         where user_id = any($1)
         order by user_id, provider
      `,[ids]);
      accountsByUser = (aRes.rows || []).reduce((acc,row)=>{
        (acc[row.user_id] = acc[row.user_id] || []).push({
          provider: row.provider,
          provider_user_id: row.provider_user_id
        });
        return acc;
      },{});
    }

    const list = users.map(u=>({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      country_code: u.country_code,
      balance: u.balance,
      hum_id: u.hum_id,
      accounts: accountsByUser[u.id] || []
    }));

    res.json({ ok:true, hum_id: humId, users: list });
  }catch(e){
    console.error('admin /cluster error:', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// POST /api/admin/unmerge  { hum_id, user_ids:[...], reason }
router.post('/unmerge', adminGuard, async (req,res)=>{
  const humId = toInt(req.body?.hum_id, 0);
  const rawIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ids = rawIds.map(v=>toInt(v,0)).filter(Boolean);
  const reason = (req.body?.reason ?? '').toString().slice(0, 512);

  if (!humId || !ids.length){
    return res.status(400).json({ ok:false, error:'bad_params' });
  }

  try{
    await db.query('begin');

    const upd = await db.query(
      `update users
          set hum_id = null,
              updated_at = now()
        where id = any($1)
          and coalesce(hum_id, id) = $2
        returning id`,
      [ids, humId]
    );
    const affected = (upd.rows || []).map(r=>r.id);

    const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHeader.split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0,256);

    if (await tableExists('events')){
      const payload = {
        hum_id: humId,
        user_ids: affected,
        requested_ids: ids,
        reason
      };
      await db.query(
        `insert into events (event_type, user_id, hum_id, amount, payload, ip, ua, created_at)
         values ('admin_unmerge_manual', $1, $2, 0, $3, $4, $5, now())`,
        [affected[0] || null, humId, payload, ip, ua]
      );
    }

    await db.query('commit');

    res.json({ ok:true, hum_id: humId, user_ids: affected, requested_ids: ids });
  }catch(e){
    await db.query('rollback').catch(()=>{});
    console.error('admin /unmerge error:', e);
    res.status(500).json({ ok:false, error:'server_error', detail:String(e?.message || e) });
  }
});
// ---- MERGE SUGGESTIONS (теневая склейка по девайсу) ----
// GET /api/admin/merge-suggestions?limit=200
router.get('/merge-suggestions', adminGuard, async (req,res)=>{
  try{
    // Без auth_accounts анализировать нечего
    if (!await tableExists('auth_accounts')) {
      return res.json({ ok:true, items:[] });
    }

    const limitRaw = req.query.limit ?? req.query.take ?? 200;
    const limit = Math.min(Math.max(toInt(limitRaw, 200), 1), 500);

    const rows = await mergeSuggestions(limit);
    if (!rows || !rows.length) {
      return res.json({ ok:true, items:[] });
    }

    // Собираем id пользователей из пар
    const ids = [];
    for (const r of rows) {
      if (r.primary_id && !ids.includes(r.primary_id)) ids.push(r.primary_id);
      if (r.secondary_id && !ids.includes(r.secondary_id)) ids.push(r.secondary_id);
    }

    let usersById = {};
    if (ids.length && await tableExists('users')) {
      const uRes = await db.query(`
        select id, vk_id, first_name, last_name, avatar, country_code, balance, hum_id
          from users
         where id = any($1)
      `,[ids]);
      for (const u of (uRes.rows || [])) {
        usersById[u.id] = u;
      }
    }

    const items = rows.map(r => ({
      primary_id: r.primary_id,
      secondary_id: r.secondary_id,
      primary: r.primary_id ? (usersById[r.primary_id] || null) : null,
      secondary: r.secondary_id ? (usersById[r.secondary_id] || null) : null,
    }));

    res.json({ ok:true, items });
  }catch(e){
    console.error('admin /merge-suggestions error', e);
    res.status(500).json({ ok:false, error:'server_error', detail:String(e?.message || e) });
  }
});

// ---- EVENTS ----
// ---- EVENTS LIST ----
router.get('/events', adminGuard, async (req, res) => {
  try {
    if (!await tableExists('events')) {
      return res.json({ ok: true, events: [], rows: [] });
    }

    const tz     = tzOf(req); // Europe/Moscow по умолчанию
    const take   = Math.min(Math.max(toInt(req.query.take, 50), 1), 500);
    const skip   = Math.max(toInt(req.query.skip, 0), 0);
    const userId = toInt(req.query.user_id, 0);
    const type   = (req.query.type  || req.query.event_type || '').toString().trim();
    const term   = (req.query.term  || req.query.search     || '').toString().trim();

    const hasEventType = await hasCol('events', 'event_type');
    const hasType      = await hasCol('events', 'type');
    const etExpr = hasEventType
      ? 'e.event_type::text'
      : (hasType ? 'e."type"::text' : 'NULL::text');

    // ВАЖНО:
    // created_at хранится как UTC (timestamp without time zone, now() на сервере в UTC).
    // Схема: UTC -> timestamptz -> локальное время tz (Europe/Moscow).
    const base = `with canon as (
      select
        e.id,
        e.user_id,
        coalesce(e.hum_id, u.hum_id) as hum_id,
        e.ip,
        e.ua,
        ${etExpr} as event_type,
        e.amount,
        e.payload,
        (e.created_at at time zone 'UTC' at time zone $1) as created_at
      from events e
      left join users u on u.id = e.user_id
    )`;

    let sql, params;

    if (userId) {
      sql = base + `
        select * from canon
         where user_id = $2
         order by id desc
         limit $3 offset $4
      `;
      params = [tz, userId, take, skip];
    } else if (type) {
      sql = base + `
        select * from canon
         where coalesce(event_type,'') = $2
         order by id desc
         limit $3 offset $4
      `;
      params = [tz, type, take, skip];
    } else if (term) {
      sql = base + `
        select * from canon
         where cast(user_id as text) ilike $2
            or cast(hum_id  as text) ilike $2
            or coalesce(event_type,'') ilike $2
         order by id desc
         limit $3 offset $4
      `;
      params = [tz, `%${term}%`, take, skip];
    } else {
      sql = base + `
        select * from canon
         order by id desc
         limit $2 offset $3
      `;
      params = [tz, take, skip];
    }

    const rows = (await db.query(sql, params)).rows;
    res.json({ ok: true, events: rows, rows });
  } catch (e) {
    console.error('admin /events error:', e);
    res.json({ ok: true, events: [], rows: [] });
  }
});

// ---- MANUAL TOPUP ----
// POST /api/admin/users/:id/topup  { amount, comment }
// Adds amount (bigint) to users.balance, logs event "admin_topup"
router.post('/users/:id/topup', adminGuard, async (req,res)=>{
  const userId = toInt(req.params.id, 0);
  const rawAmount = req.body?.amount;
  let amount = Number.isFinite(rawAmount) ? rawAmount : toInt(rawAmount, NaN);
  const comment = (req.body?.comment ?? '').toString().slice(0, 512);

  if (!userId || !Number.isFinite(amount) || !amount){
    return res.status(400).json({ ok:false, error:'bad_params' });
  }

  try{
    // fetch hum_id for logging
    const uRes = await db.query(
      'select id, coalesce(hum_id,id) as hum_id from users where id=$1',
      [userId]
    );
    if (!uRes.rows.length){
      return res.status(404).json({ ok:false, error:'user_not_found' });
    }
    const humId = uRes.rows[0].hum_id;

    await db.query('begin');

    // update balance
    const upd = await db.query(
      'update users set balance = coalesce(balance,0)::bigint + $2::bigint, updated_at=now() where id=$1 returning balance',
      [userId, amount]
    );
    const newBalance = upd.rows?.[0]?.balance ?? null;

    // log event if table exists
    if (await tableExists('events')){
      const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
      const ip = ipHeader.split(',')[0].trim();
      const ua = (req.headers['user-agent'] || '').slice(0,256);
      await db.query(`
        insert into events (event_type, user_id, hum_id, amount, payload, ip, ua, created_at)
        values (
          'admin_topup',
          $1,
          $2,
          $3,
          jsonb_build_object('amount',$3::bigint,'comment',$4::text),
          $5,
          $6,
          now()
        )
      `,[userId, humId, amount, comment, ip, ua]);
    }

    await db.query('commit');
    res.json({ ok:true, user_id:userId, hum_id:humId, amount, balance:newBalance });
  }catch(e){
    await db.query('rollback').catch(()=>{});
    console.error('admin topup error', e);
    res.status(500).json({ ok:false, error:'server_error', detail:String(e?.message || e) });
  }
});

// ---- SUMMARY ----
router.get('/summary', adminGuard, async (req, res) => {
  try {
    const tz = tzOf(req);
    const incl = wantHum(req);

    // общее количество пользователей
    let users = 0;
    try {
      const r = await db.query('select count(*)::int as c from users');
      users = r.rows?.[0]?.c ?? 0;
    } catch {}

    if (!await tableExists('events')) {
      return res.json({ ok: true, users, events: 0, auth7: 0, auth7_total: 0, unique7: 0 });
    }

    const hasEventType = await hasCol('events', 'event_type');
    const hasType = await hasCol('events', 'type');
    const etExpr = hasEventType
      ? 'e.event_type::text'
      : (hasType ? 'e."type"::text' : 'NULL::text');

    const hasAuthAccounts = await tableExists('auth_accounts');
    if (hasAuthAccounts) {
      await ensureMetaColumns();
    }

    const sql = hasAuthAccounts
      ? `
        with b as (
          select
            (now() at time zone $1)::date as d2,
            ((now() at time zone $1)::date - 6) as d1
        ),
          shadow_pairs as (
          select *
          from (
            select
              u.id as secondary_id,
              (
                select a.user_id
                from auth_accounts a
                where a.user_id is not null
                  and (a.meta->>'device_id') = tg.did
                  and a.provider = 'vk'
                order by a.updated_at desc
                limit 1
              ) as primary_id
            from users u
            join (
              select
                aa.user_id,
                max(aa.meta->>'device_id') as did
              from auth_accounts aa
              where aa.provider = 'tg'
                and aa.meta->>'device_id' is not null
              group by aa.user_id
            ) as tg on tg.user_id = u.id
            -- В аналитике не фильтруем по meta->>'merged_into'
          ) s
          where primary_id is not null
        ),

        shadow_map as (
          select primary_id as user_id, primary_id as cluster_id from shadow_pairs
          union
          select secondary_id as user_id, primary_id as cluster_id from shadow_pairs
        ),
        canon as (
          select
            e.user_id,
            case
              when $2::boolean then coalesce(u.hum_id, shadow_map.cluster_id, u.id)
              else u.id
            end as cluster_id,
            (e.created_at at time zone $1) as ts_msk,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          left join shadow_map on shadow_map.user_id = u.id
          where (e.created_at at time zone $1)::date between (select d1 from b) and (select d2 from b)
        ),
        auths as (
          select *
          from canon
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
      `
      : `
        with b as (
          select
            (now() at time zone $1)::date as d2,
            ((now() at time zone $1)::date - 6) as d1
        ),
        canon as (
          select
            e.user_id,
            case
              when $2::boolean then coalesce(u.hum_id, u.id)
              else u.id
            end as cluster_id,
            (e.created_at at time zone $1) as ts_msk,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          where (e.created_at at time zone $1)::date between (select d1 from b) and (select d2 from b)
        ),
        auths as (
          select *
          from canon
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
    const events   = q.rows?.[0]?.events      ?? 0;
    const auth7tot = q.rows?.[0]?.auth7_total ?? 0;
    const unique7  = q.rows?.[0]?.unique7     ?? 0;

    return res.json({
      ok: true,
      users,
      events,
      auth7: unique7,
      auth7_total: auth7tot,
      unique7,
    });
  } catch (e) {
    console.error('admin /summary error', e);
    return res.json({ ok: true, users: 0, events: 0, auth7: 0, auth7_total: 0, unique7: 0 });
  }
});


// ---- DAILY ----
router.get('/daily', adminGuard, async (req, res) => {
  try {
    if (!await tableExists('events')) {
      return res.json({ ok: true, days: [] });
    }

    const tz   = tzOf(req);
    const days = Math.max(1, Math.min(31, toInt(req.query.days || '7', 10)));
    const incl = wantHum(req);

    const hasEventType = await hasCol('events', 'event_type');
    const hasType = await hasCol('events', 'type');
    const etExpr = hasEventType
      ? 'e.event_type::text'
      : (hasType ? 'e."type"::text' : 'NULL::text');

    const hasAuthAccounts = await tableExists('auth_accounts');
    if (hasAuthAccounts) {
      await ensureMetaColumns();
    }

    const sql = hasAuthAccounts
      ? `
        with b as (
          select generate_series(
            (now() at time zone $1)::date - ($2::int - 1),
            (now() at time zone $1)::date,
            '1 day'
          ) as d
        ),
                shadow_pairs as (
          select *
          from (
            select
              u.id as secondary_id,
              (
                select a.user_id
                from auth_accounts a
                where a.user_id is not null
                  and (a.meta->>'device_id') = tg.did
                  and a.provider = 'vk'
                order by a.updated_at desc
                limit 1
              ) as primary_id
            from users u
            join (
              select
                aa.user_id,
                max(aa.meta->>'device_id') as did
              from auth_accounts aa
              where aa.provider = 'tg'
                and aa.meta->>'device_id' is not null
              group by aa.user_id
            ) as tg on tg.user_id = u.id
            -- В аналитике не фильтруем по meta->>'merged_into'
          ) s
          where primary_id is not null
        ),

        shadow_map as (
          select primary_id as user_id, primary_id as cluster_id from shadow_pairs
          union
          select secondary_id as user_id, primary_id as cluster_id from shadow_pairs
        ),
        canon as (
          select
            (e.created_at at time zone $1)::date as d,
            case
              when $3::boolean then coalesce(u.hum_id, shadow_map.cluster_id, u.id)
              else u.id
            end as cluster_id,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          left join shadow_map on shadow_map.user_id = u.id
          where (e.created_at at time zone $1)::date >= (select min(d) from b)
        ),
        auths as (
          select *
          from canon
          where (et is null)
             or et ilike '%login%success%'
             or et ilike '%auth%success%'
             or et ilike '%auth%'
        ),
        totals as (
          select d, count(*) as c from auths group by 1
        ),
        uniq as (
          select d, count(distinct cluster_id) as c from auths group by 1
        )
        select
          to_char(b.d, 'YYYY-MM-DD') as day,
          coalesce(t.c, 0) as auth_total,
          coalesce(u.c, 0) as auth_unique
        from b
        left join totals t on t.d = b.d
        left join uniq   u on u.d = b.d
        order by b.d asc
      `
      : `
        with b as (
          select generate_series(
            (now() at time zone $1)::date - ($2::int - 1),
            (now() at time zone $1)::date,
            '1 day'
          ) as d
        ),
        canon as (
          select
            (e.created_at at time zone $1)::date as d,
            case
              when $3::boolean then coalesce(u.hum_id, u.id)
              else u.id
            end as cluster_id,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          where (e.created_at at time zone $1)::date >= (select min(d) from b)
        ),
        auths as (
          select *
          from canon
          where (et is null)
             or et ilike '%login%success%'
             or et ilike '%auth%success%'
             or et ilike '%auth%'
        ),
        totals as (
          select d, count(*) as c from auths group by 1
        ),
        uniq as (
          select d, count(distinct cluster_id) as c from auths group by 1
        )
        select
          to_char(b.d, 'YYYY-MM-DD') as day,
          coalesce(t.c, 0) as auth_total,
          coalesce(u.c, 0) as auth_unique
        from b
        left join totals t on t.d = b.d
        left join uniq   u on u.d = b.d
        order by b.d asc
      `;

    const r = await db.query(sql, [tz, days, incl]);
    const rows = (r.rows || []).map(x => ({
      date: x.day,
      auth_total: Number(x.auth_total || 0),
      auth_unique: Number(x.auth_unique || 0),
    }));

    return res.json({ ok: true, days: rows });
  } catch (e) {
    console.error('admin /daily error', e);
    res.json({ ok: true, days: [] });
  }
});


// ---- RANGE ----
router.get('/range', adminGuard, async (req, res) => {
  try {
    if (!await tableExists('events')) {
      return res.json({ ok: true, from: null, to: null, days: [] });
    }

    const tz   = tzOf(req);
    const incl = wantHum(req);

    const fromStr = (req.query.from || '').toString().trim();
    const toStr   = (req.query.to   || '').toString().trim();

    const hasEventType = await hasCol('events', 'event_type');
    const hasType = await hasCol('events', 'type');
    const etExpr = hasEventType
      ? 'e.event_type::text'
      : (hasType ? 'e."type"::text' : 'NULL::text');

    const hasAuthAccounts = await tableExists('auth_accounts');
    if (hasAuthAccounts) {
      await ensureMetaColumns();
    }

    const sql = hasAuthAccounts
      ? `
        with raw_bounds as (
          select
            min((created_at at time zone $1)::date) as min_d,
            max((created_at at time zone $1)::date) as max_d
          from events
        ),
        bounds as (
          select
            case
              when $2 = '' and $3 = '' then coalesce(min_d, (now() at time zone $1)::date - 30)
              else coalesce(
                nullif($2, ''),
                to_char((now() at time zone $1)::date - 30, 'YYYY-MM-DD')
              )::date
            end as d1,
            case
              when $2 = '' and $3 = '' then coalesce(max_d, (now() at time zone $1)::date)
              else coalesce(
                nullif($3, ''),
                to_char((now() at time zone $1)::date, 'YYYY-MM-DD')
              )::date
            end as d2
          from raw_bounds
        ),
        days as (
          select generate_series(
            (select d1 from bounds),
            (select d2 from bounds),
            '1 day'
          )::date as d
        ),
                shadow_pairs as (
          select *
          from (
            select
              u.id as secondary_id,
              (
                select a.user_id
                from auth_accounts a
                where a.user_id is not null
                  and (a.meta->>'device_id') = tg.did
                  and a.provider = 'vk'
                order by a.updated_at desc
                limit 1
              ) as primary_id
            from users u
            join (
              select
                aa.user_id,
                max(aa.meta->>'device_id') as did
              from auth_accounts aa
              where aa.provider = 'tg'
                and aa.meta->>'device_id' is not null
              group by aa.user_id
            ) as tg on tg.user_id = u.id
            -- В аналитике не фильтруем по meta->>'merged_into'
          ) s
          where primary_id is not null
        ),

        shadow_map as (
          select primary_id as user_id, primary_id as cluster_id from shadow_pairs
          union
          select secondary_id as user_id, primary_id as cluster_id from shadow_pairs
        ),
        canon as (
          select
            (e.created_at at time zone $1)::date as d,
            case
              when $4::boolean then coalesce(u.hum_id, shadow_map.cluster_id, u.id)
              else u.id
            end as cluster_id,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          left join shadow_map on shadow_map.user_id = u.id
          where (e.created_at at time zone $1)::date
                between (select d1 from bounds) and (select d2 from bounds)
        ),
        auths as (
          select *
          from canon
          where (et is null)
             or et ilike 'auth%'
             or et ilike '%login%success%'
             or et ilike '%auth%success%'
             or et ilike '%auth%'
        ),
        totals as (
          select d, count(*) as c from auths group by 1
        ),
        uniq as (
          select d, count(distinct cluster_id) as c from auths group by 1
        )
        select
          to_char(days.d, 'YYYY-MM-DD') as day,
          coalesce(t.c, 0) as auth_total,
          coalesce(u.c, 0) as auth_unique
        from days
        left join totals t on t.d = days.d
        left join uniq   u on u.d = days.d
        order by days.d asc
      `
      : `
        with raw_bounds as (
          select
            min((created_at at time zone $1)::date) as min_d,
            max((created_at at time zone $1)::date) as max_d
          from events
        ),
        bounds as (
          select
            case
              when $2 = '' and $3 = '' then coalesce(min_d, (now() at time zone $1)::date - 30)
              else coalesce(
                nullif($2, ''),
                to_char((now() at time zone $1)::date - 30, 'YYYY-MM-DD')
              )::date
            end as d1,
            case
              when $2 = '' and $3 = '' then coalesce(max_d, (now() at time zone $1)::date)
              else coalesce(
                nullif($3, ''),
                to_char((now() at time zone $1)::date, 'YYYY-MM-DD')
              )::date
            end as d2
          from raw_bounds
        ),
        days as (
          select generate_series(
            (select d1 from bounds),
            (select d2 from bounds),
            '1 day'
          )::date as d
        ),
        canon as (
          select
            (e.created_at at time zone $1)::date as d,
            case
              when $4::boolean then coalesce(u.hum_id, u.id)
              else u.id
            end as cluster_id,
            ${etExpr} as et
          from events e
          join users u on u.id = e.user_id
          where (e.created_at at time zone $1)::date
                between (select d1 from bounds) and (select d2 from bounds)
        ),
        auths as (
          select *
          from canon
          where (et is null)
             or et ilike 'auth%'
             or et ilike '%login%success%'
             or et ilike '%auth%success%'
             or et ilike '%auth%'
        ),
        totals as (
          select d, count(*) as c from auths group by 1
        ),
        uniq as (
          select d, count(distinct cluster_id) as c from auths group by 1
        )
        select
          to_char(days.d, 'YYYY-MM-DD') as day,
          coalesce(t.c, 0) as auth_total,
          coalesce(u.c, 0) as auth_unique
        from days
        left join totals t on t.d = days.d
        left join uniq   u on u.d = days.d
        order by days.d asc
      `;

    const q = await db.query(sql, [tz, fromStr, toStr, incl]);
    const rows = (q.rows || []).map(x => ({
      date: x.day,
      auth_total: Number(x.auth_total || 0),
      auth_unique: Number(x.auth_unique || 0),
    }));

    const fromDate = rows.length ? rows[0].date : (fromStr || null);
    const toDate   = rows.length ? rows[rows.length - 1].date : (toStr || null);

    return res.json({ ok: true, from: fromDate, to: toDate, days: rows });
  } catch (e) {
    console.error('admin /range error', e);
    return res.json({ ok: true, from: null, to: null, days: [] });
  }
});

     
// ---- SCHEMA dump ----
router.get('/schema', adminGuard, async (_req,res)=>{
  try{
    const tables = (await db.query(`
      select table_name
        from information_schema.tables
       where table_schema='public' and table_type='BASE TABLE'
       order by table_name
    `)).rows.map(r=>r.table_name);

    const columns = (await db.query(`
      select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema='public'
       order by table_name, ordinal_position
    `)).rows;

    const indexes = (await db.query(`
      select t.relname as table_name,
             i.relname as index_name,
             ix.indisunique as is_unique,
             array_agg(a.attname order by a.attnum) as columns
        from pg_class t
        join pg_index ix on t.oid = ix.indrelid
        join pg_class i on i.oid = ix.indexrelid
        join unnest(ix.indkey) as k(attnum) on true
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
       where t.relkind = 'r'
       group by 1,2,3
       order by 1,2
    `)).rows;

    res.json({ ok:true, tables, columns, indexes });
  }catch(e){
    console.error('admin /schema error', e);
    res.status(500).json({ ok:false, error: 'schema_dump_failed' });
  }
});

export default router;
