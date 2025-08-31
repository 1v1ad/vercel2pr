// src/routes_admin.js — robust admin API (no backticks), inline adminAuth
import { Router } from 'express';
import { db } from './db.js';
import { mergeSuggestions } from './merge.js';

const router = Router();

// Inline admin auth: header X-Admin-Password must equal ADMIN_PASSWORD (or ADMIN_PWD)
function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '').toString();
  const given = (req.get('X-Admin-Password') || (req.body && req.body.pwd) || req.query.pwd || '').toString();
  if (!serverPass) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (given !== serverPass) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}
router.use(adminAuth);

// Health
router.get('/health', (_req, res) => res.json({ ok:true }));

// Summary — safe for schemas without "type" or "event_type"
router.get('/summary', async (_req, res) => {
  try {
    const u = await db.query('select count(*)::int as c from users');
    let users = u.rows[0]?.c ?? 0;

    // Events table exists?
    const hasT = await db.query("select to_regclass('public.events') as r");
    if (!hasT.rows[0].r) {
      return res.json({ ok:true, users, events:0, auth7:0, unique7:0 });
    }

    // Which columns are present?
    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType = set.has('type');
    const hasEventType = set.has('event_type');

    // Counts
    const e = await db.query('select count(*)::int as c from events');
    const events = e.rows[0]?.c ?? 0;

    // Auth7
    let auth7 = 0;
    if (hasType || hasEventType) {
      const parts = [];
      if (hasEventType) parts.push("event_type in ('auth','login','auth_start','auth_callback')");
      if (hasType)      parts.push('"type" in (\'auth\',\'login\',\'auth_start\',\'auth_callback\')');
      const sql = 'select count(*)::int as c from events where (' + parts.join(' or ') + ") and created_at > now() - interval '7 days'";
      const r = await db.query(sql);
      auth7 = r.rows[0]?.c ?? 0;
    }

    // Unique7
    const uq = await db.query("select count(distinct user_id)::int as c from events where created_at > now() - interval '7 days'");
    const unique7 = uq.rows[0]?.c ?? 0;

    res.json({ ok:true, users, events, auth7, unique7 });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Users list
router.get('/users', async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const params = [];
    function add(v){ params.push(v); return '$' + params.length; }

    let where = "where coalesce(meta->>'merged_into','') = ''";
    if (search) {
      const p = add('%' + search + '%');
      where += ' and (cast(vk_id as text) ilike ' + p + ' or first_name ilike ' + p + ' or last_name ilike ' + p + ')';
    }

    const sql = 'select id, vk_id, first_name, last_name, avatar, balance, country_code, country_name, created_at, updated_at ' +
                'from users ' + where + ' order by id desc limit ' + add(limit) + ' offset ' + add(offset);

    const r = await db.query(sql, params);
    res.json({ ok:true, users:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Events list — build columns dynamically if needed
router.get('/events', async (req, res) => {
  try {
    // Which columns exist?
    const cols = await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='events'");
    const set = new Set(cols.rows.map(r => r.column_name));
    const hasType = set.has('type');
    const hasEventType = set.has('event_type');
    const hasIp = set.has('ip');
    const hasUa = set.has('ua');
    const hasCreated = set.has('created_at');

    const params = [];
    function add(v){ params.push(v); return '$' + params.length; }

    const selectCols = ['id', 'user_id'];
    if (hasEventType) selectCols.push('event_type');
    else selectCols.push("NULL::text as event_type");
    if (hasType)      selectCols.push('"type"');
    else             selectCols.push("NULL::text as type");
    if (hasIp) selectCols.push('ip'); else selectCols.push("NULL::text as ip");
    if (hasUa) selectCols.push('ua'); else selectCols.push("NULL::text as ua");
    if (hasCreated) selectCols.push('created_at'); else selectCols.push('now() as created_at');

    const conds = [];
    const type = (req.query.type || '').toString().trim();
    const event_type = (req.query.event_type || '').toString().trim();
    const user_id = parseInt((req.query.user_id || '').toString(), 10) || null;
    const ip = (req.query.ip || '').toString().trim();
    const ua = (req.query.ua || '').toString().trim();

    if (type && hasType)            conds.push('"type" = ' + add(type));
    if (event_type && hasEventType) conds.push('event_type = ' + add(event_type));
    if (user_id)                    conds.push('user_id = ' + add(user_id));
    if (ip && hasIp)                conds.push('ip = ' + add(ip));
    if (ua && hasUa)                conds.push('ua ilike ' + add('%' + ua + '%'));

    const where = conds.length ? (' where ' + conds.join(' and ')) : '';

    const limit  = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const sql = 'select ' + selectCols.join(', ') + ' from events' + where + ' order by id desc limit ' + add(limit) + ' offset ' + add(offset);
    const r = await db.query(sql, params);
    res.json({ ok:true, events:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Manual topup
router.post('/users/:id/topup', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const amount = parseInt((req.body && req.body.amount) || '0', 10) || 0;
    if (!id || !Number.isFinite(amount)) return res.status(400).json({ ok:false, error:'bad_args' });
    await db.query('update users set balance = coalesce(balance,0) + $1 where id=$2', [amount, id]);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Manual merge
router.post('/users/merge', async (req, res) => {
  try {
    const primaryId = parseInt((req.body && req.body.primary_id) || (req.query && req.query.primary_id) || '0', 10);
    const secondaryId = parseInt((req.body && req.body.secondary_id) || (req.query && req.query.secondary_id) || '0', 10);
    if (!primaryId || !secondaryId || primaryId === secondaryId) return res.status(400).json({ ok:false, error:'bad_args' });

    await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb");

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, secondaryId]);
      try { await client.query('update transactions set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
      try { await client.query('update events set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
      await client.query('update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1', [primaryId, secondaryId]);
      await client.query(
        "update users p set first_name = coalesce(nullif(p.first_name,''), s.first_name), last_name = coalesce(nullif(p.last_name,''), s.last_name), username = coalesce(nullif(p.username,''), s.username), avatar = coalesce(nullif(p.avatar,''), s.avatar), country_code = coalesce(nullif(p.country_code,''), s.country_code) from users s where p.id=$1 and s.id=$2",
        [primaryId, secondaryId]
      );
      await client.query("update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb), updated_at=now() where id=$2", [primaryId, secondaryId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

// Merge suggestions
router.get('/users/merge/suggestions', async (_req, res) => {
  try {
    const list = await mergeSuggestions(200);
    res.json({ ok:true, list });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e && e.message || e) });
  }
});

export default router;
