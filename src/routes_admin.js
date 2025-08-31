
// src/routes_admin.js — clean ESM, без бэктиков
import { Router } from 'express';
import { db } from './db.js';
import adminAuth from './admin_auth.js';
import { mergeSuggestions } from './merge.js';

const router = Router();

router.use(adminAuth);

// health
router.get('/health', (_req, res) => res.json({ ok: true }));

// краткая сводка
router.get('/summary', async (_req, res) => {
  try {
    const u = await db.query('select count(*)::int as c from users');
    const e = await db.query('select count(*)::int as c from events');
    const a7 = await db.query("select count(*)::int as c from events where event_type in ('auth','login','auth_start','auth_callback') and created_at > now() - interval '7 days'");
    const uniq7 = await db.query("select count(distinct user_id)::int as c from events where created_at > now() - interval '7 days'");
    res.json({ ok:true, users:u.rows[0].c, events:e.rows[0].c, auth7:a7.rows[0].c, unique7:uniq7.rows[0].c });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// пользователи
router.get('/users', async (req, res) => {
  try {
    const search = (req.query.search || '').toString().trim();
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10) || 50);
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
    res.status(500).json({ ok:false, error:e.message });
  }
});

// события
router.get('/events', async (req, res) => {
  try {
    const params = [];
    function add(v){ params.push(v); return '$' + params.length; }
    const conds = [];

    const type = (req.query.type || '').toString().trim();
    const event_type = (req.query.event_type || '').toString().trim();
    const user_id = parseInt((req.query.user_id || '').toString(), 10) || null;
    const ip = (req.query.ip || '').toString().trim();
    const ua = (req.query.ua || '').toString().trim();

    if (type)       conds.push('type = ' + add(type));
    if (event_type) conds.push('event_type = ' + add(event_type));
    if (user_id)    conds.push('user_id = ' + add(user_id));
    if (ip)         conds.push('ip = ' + add(ip));
    if (ua)         conds.push('ua ilike ' + add('%' + ua + '%'));

    const where = conds.length ? ('where ' + conds.join(' and ')) : '';

    const limit = Math.min(200, parseInt(req.query.limit || '50', 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    const sql = 'select id, user_id, event_type, type, ip, ua, created_at ' +
                'from events ' + where + ' order by id desc limit ' + add(limit) + ' offset ' + add(offset);

    const r = await db.query(sql, params);
    res.json({ ok:true, events:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// пополнение баланса
router.post('/users/:id/topup', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const amount = parseInt((req.body && req.body.amount) || '0', 10) || 0;
    if (!id || !Number.isFinite(amount)) return res.status(400).json({ ok:false, error:'bad_args' });
    await db.query('update users set balance = coalesce(balance,0) + $1 where id=$2', [amount, id]);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ручная склейка
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
    res.status(500).json({ ok:false, error:e.message });
  }
});

// предложения для склейки
router.get('/users/merge/suggestions', async (_req, res) => {
  try {
    const list = await mergeSuggestions(200);
    res.json({ ok:true, list });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

export default router;
