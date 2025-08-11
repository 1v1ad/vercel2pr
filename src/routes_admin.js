// src/routes_admin.js
import express from 'express';
import adminAuth from './middleware_admin.js';
import { db } from './db.js';

const router = express.Router();

router.use(adminAuth);

// health
router.get('/health', async (_req, res) => {
  try {
    await db.query('select 1');
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db_error' });
  }
});

// users list
router.get('/users', async (req, res) => {
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);
  const search = String(req.query.search ?? '').trim();

  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `where vk_id ilike $1 or first_name ilike $1 or last_name ilike $1`;
  }

  const users = await db.query(
    `select id, vk_id, first_name, last_name, avatar, balance, created_at, updated_at
     from users ${where}
     order by id desc
     limit ${take} offset ${skip}`, params
  );
  const total = await db.query(
    `select count(*)::int as c from users ${where}`, params
  );
  res.json({ total: total.rows?.[0]?.c ?? 0, take, skip, items: users.rows });
});

// events list
router.get('/events', async (req, res) => {
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);
  const type = String(req.query.type ?? '').trim();
  const user = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

  const params = [];
  const conds = [];
  if (type) { params.push(type); conds.push(`event_type = $${params.length}`); }
  if (user) { params.push(user); conds.push(`user_id = $${params.length}`); }
  const where = conds.length ? ('where ' + conds.join(' and ')) : '';

  const q = `select id, user_id, event_type, payload, ip, ua, created_at
             from events ${where}
             order by id desc
             limit ${take} offset ${skip}`;
  const rows = await db.query(q, params);
  const tot = await db.query(`select count(*)::int as c from events ${where}`, params);
  res.json({ total: tot.rows?.[0]?.c ?? 0, take, skip, items: rows.rows });
});

// summary
router.get('/summary', async (_req, res) => {
  const [u, e] = await Promise.all([
    db.query('select count(*)::int as c from users'),
    db.query('select event_type, count(*)::int as c from events group by event_type'),
  ]);
  const byType = Object.fromEntries(e.rows.map(r => [r.event_type, r.c]));
  res.json({ users: u.rows?.[0]?.c ?? 0, eventsByType: byType });
});

export default router;
