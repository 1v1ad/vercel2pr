// src/routes_admin.js — EVENTS fix (no hard ref to "type") + /schema dump
import express from 'express';
import { db } from './db.js';

const router = express.Router();
router.use(express.json());

const adminGuard = (req,res,next)=>{
  const need = String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '');
  const got  = String(req.get('X-Admin-Password') || req.body?.pwd || req.query?.pwd || '');
  if (!need) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (got !== need) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
};

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

// --- USERS (kept minimal, unchanged) ---
router.get('/users', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('users')) return res.json({ ok:true, users:[], rows:[] });
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
      const prov = (await db.query(`select user_id, provider from auth_accounts where user_id = any($1)`,[ids])).rows;
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

// --- EVENTS (fixed: dynamic column expr; no reference to non-existing "type") ---
router.get('/events', adminGuard, async (req,res)=>{
  try{
    if (!await tableExists('events')) return res.json({ ok:true, events:[], rows:[] });
    const take = Math.min(Math.max(toInt(req.query.take,50),1),500);
    const skip = Math.max(toInt(req.query(skip),0),0);
    const userId = toInt(req.query.user_id, 0);
    const term = (req.query.term || req.query.search || '').toString().trim();

    const hasEventType = await hasCol('events','event_type');
    const hasType      = await hasCol('events','type');
    const etExpr = hasEventType ? 'e.event_type::text' : (hasType ? 'e."type"::text' : 'NULL::text');

    // base WITH using chosen expr once
    const base = `with canon as (
      select e.id, e.user_id, u.hum_id, e.ip, e.ua, ${etExpr} as event_type, e.created_at
        from events e
        left join users u on u.id = e.user_id
    )`;

    let sql, params;
    if (userId){
      sql = base + `
        select * from canon
         where user_id = $1
         order by id desc
         limit $2 offset $3
      `;
      params = [userId, take, skip];
    } else if (term){
      sql = base + `
        select * from canon
         where cast(user_id as text) ilike $1
            or cast(hum_id as text) ilike $1
            or coalesce(event_type,'') ilike $1
         order by id desc
         limit $2 offset $3
      `;
      params = ['%'+term+'%', take, skip];
    } else {
      sql = base + `
        select * from canon
         order by id desc
         limit $1 offset $2
      `;
      params = [take, skip];
    }

    const rows = (await db.query(sql, params)).rows;
    res.json({ ok:true, events: rows, rows });
  }catch(e){
    console.error('admin /events error:', e);
    res.json({ ok:true, events:[], rows:[] });
  }
});

// --- SUMMARY/Daily/Range (unchanged here; assumed present in your file) ---
// If needed, you can keep your working implementations for /summary, /daily, /range.

// --- SCHEMA dump ---
router.get('/schema', adminGuard, async (_req,res)=>{
  try{
    const tables = (await db.query(`
      select table_name
        from information_schema.tables
       where table_schema='public' and table_type='BASE TABLE'
       order by table_name
    `)).rows.map(r=>r.table_name);

    const cols = (await db.query(`
      select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema='public'
       order by table_name, ordinal_position
    `)).rows;

    const idx = (await db.query(`
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

    res.json({ ok:true, tables, columns: cols, indexes: idx });
  }catch(e){
    console.error('admin /schema error', e);
    res.status(500).json({ ok:false, error: 'schema_dump_failed' });
  }
});

export default router;
