// src/routes_admin.js — clean, full version
import express from 'express';
import adminAuth from './middleware_admin.js';
import { db } from './db.js';

const router = express.Router();
router.use(adminAuth);

// ensure meta
(async()=>{ try{ await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb"); }catch{} })();

// health
router.get('/health', async (_req, res) => {
  try { await db.query('select 1'); res.json({ ok:true, time:new Date().toISOString() }); }
  catch { res.status(500).json({ ok:false, error:'db_error' }); }
});

// summary
router.get('/summary', async (_req, res) => {
  const [u, e] = await Promise.all([
    db.query('select count(*)::int as c from users'),
    db.query('select event_type, count(*)::int as c from events group by event_type')
  ]);
  const byType = Object.fromEntries(e.rows.map(r => [r.event_type, r.c]));
  res.json({ users: u.rows?.[0]?.c ?? 0, eventsByType: byType });
});

// users list (hides merged)
router.get('/users', async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);

  const params = [];
  let where = "where coalesce(meta->>'merged_into','') = ''";
  if (search) {
    params.push('%' + search + '%');
    where += ` and (cast(vk_id as text) ilike $${params.length} or first_name ilike $${params.length} or last_name ilike $${params.length})`;
  }

  const rows = await db.query(`
    select id, vk_id, first_name, last_name, balance, country_code, created_at
      from users
      ${where}
      order by id asc
      limit ${take} offset ${skip}
  `, params);

  const tot = await db.query(`select count(*)::int as c from users ${where}`, params);

  res.json({ total: tot.rows?.[0]?.c ?? 0, take, skip, items: rows.rows });
});

// events
router.get('/events', async (req, res) => {
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);
  const type = String(req.query.type ?? '').trim();
  const user = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

  const params = [];
  const conds = [];
  if (type) { params.push(type); conds.push(\`event_type = $\${params.length}\`); }
  if (user) { params.push(user); conds.push(\`user_id = $\${params.length}\`); }
  const where = conds.length ? ('where ' + conds.join(' and ')) : '';

  const rows = await db.query(\`
    select id, user_id, event_type, payload, ip, ua, created_at
      from events ${where}
      order by id desc
      limit ${take} offset ${skip}
  \`, params);
  const tot = await db.query(\`select count(*)::int as c from events ${where}\`, params);

  res.json({ total: tot.rows?.[0]?.c ?? 0, take, skip, items: rows.rows });
});

// manual topup
router.post('/users/:id/topup', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const amount = parseInt(req.body?.amount ?? '0', 10);
    const reason = String(req.body?.reason ?? 'manual').slice(0,120);
    if (!Number.isFinite(id) || !Number.isFinite(amount)) return res.status(400).json({ ok:false, error:'bad_args' });
    await db.query('select 1 from users where id=$1', [id]);
    await db.query('update users set balance = coalesce(balance,0) + $2 where id=$1', [id, amount]);
    await db.query('insert into transactions (user_id, type, amount, meta) values ($1,$2,$3,$4)', [id, 'admin_topup', amount, { reason }]);
    const r = await db.query('select id, vk_id, balance from users where id=$1', [id]);
    res.json({ ok:true, user: r.rows[0] });
  } catch (e) {
    console.error('admin topup error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// merge endpoint
router.post('/users/merge', async (req, res) => {
  try {
    const primaryId = parseInt(req.body?.primary_id ?? req.query?.primary_id, 10);
    const secondaryId = parseInt(req.body?.secondary_id ?? req.query?.secondary_id, 10);
    if (!primaryId || !secondaryId || primaryId === secondaryId) return res.status(400).json({ ok:false, error:'bad_args' });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("update auth_accounts set user_id=$1 where user_id=$2", [primaryId, secondaryId]);
      try { await client.query("update transactions set user_id=$1 where user_id=$2", [primaryId, secondaryId]); } catch {}
      try { await client.query("update events set user_id=$1 where user_id=$2", [primaryId, secondaryId]); } catch {}
      await client.query("update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1", [primaryId, secondaryId]);
      await client.query("update users p set first_name = coalesce(nullif(p.first_name,''), s.first_name), last_name = coalesce(nullif(p.last_name,''), s.last_name), username = coalesce(nullif(p.username,''), s.username), avatar = coalesce(nullif(p.avatar,''), s.avatar), country_code = coalesce(nullif(p.country_code,''), s.country_code) from users s where p.id=$1 and s.id=$2", [primaryId, secondaryId]);
      await client.query("update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb), updated_at=now() where id=$2", [primaryId, secondaryId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }
    res.json({ ok:true });
  } catch (e) {
    console.error('admin merge error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// suggestions
router.get('/users/merge/suggestions', async (_req, res) => {
  try {
    const rows = await db.query(\`
      with tg as (
        select user_id, max(meta->>'device_id') as did
          from auth_accounts
         where provider='tg'
         group by user_id
      ),
      cand as (
        select u.id as secondary_id,
               (select user_id from auth_accounts a
                 where a.user_id is not null and (a.meta->>'device_id') = t.did
                 order by updated_at desc limit 1) as primary_id
          from users u
          join tg t on t.user_id = u.id
         where coalesce(u.meta->>'merged_into','') = ''
      )
      select * from cand where primary_id is not null limit 200
    \`);
    res.json({ ok:true, list: rows.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
