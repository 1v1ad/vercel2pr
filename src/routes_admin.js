
// src/routes_admin.js — v2
// Mount this router in your server:  app.use(adminRouter);
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function allowCORS(req, res){
  const FRONT = process.env.FRONT_ORIGIN || process.env.FRONTEND_URL || process.env.FRONT_URL || '';
  const origin = req.headers.origin || '';
  res.set('Access-Control-Allow-Origin', FRONT || origin || '*');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function noStore(res){
  res.set('Cache-Control','no-store, no-cache, must-revalidate');
}

router.options(/\/api\/admin\/.*/, (req,res)=>{ allowCORS(req,res); res.sendStatus(204); });

// Users list
router.get('/api/admin/users', async (req,res)=>{
  try {
    allowCORS(req,res); noStore(res);
    const take = Math.min(parseInt(req.query.take||'50',10), 200);
    const skip = Math.max(parseInt(req.query.skip||'0',10), 0);
    const search = (req.query.search||'').trim();
    let rows=[], total=0;
    if (search) {
      const like = `%${search}%`;
      rows = await db.all(
        `SELECT * FROM users
         WHERE CAST(id AS TEXT) LIKE ? OR CAST(vk_id AS TEXT) LIKE ? OR CAST(tg_id AS TEXT) LIKE ?
           OR first_name LIKE ? OR last_name LIKE ?
         ORDER BY id DESC LIMIT ? OFFSET ?`,
        [like, like, like, like, like, take, skip]
      );
      const r = await db.get(
        `SELECT COUNT(*) as c FROM users
         WHERE CAST(id AS TEXT) LIKE ? OR CAST(vk_id AS TEXT) LIKE ? OR CAST(tg_id AS TEXT) LIKE ?
           OR first_name LIKE ? OR last_name LIKE ?`,
        [like, like, like, like, like]
      );
      total = r?.c || 0;
    } else {
      rows = await db.all('SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?', [take, skip]);
      const r = await db.get('SELECT COUNT(*) as c FROM users');
      total = r?.c || 0;
    }
    res.json({ ok:true, items: rows, total });
  } catch (e) {
    res.status(200).json({ ok:false, error:'users_list_failed' });
  }
});

// Summary daily (return multiple shapes so old UI won't choke)
router.get('/api/admin/summary/daily', async (req,res)=>{
  try {
    allowCORS(req,res); noStore(res);
    const days = Math.min(parseInt(req.query.days||'7',10), 30);
    const today = Date.now();
    const points = Array.from({length: days}, (_,i)=>{
      const d = new Date(today - (days-1-i)*24*3600*1000);
      return { date: d.toISOString().slice(0,10), users: 0, deposits: 0, revenue: 0 };
    });
    res.json({ ok:true, points, daily: points, data: points });
  } catch (e) {
    res.json({ ok:false, error:'summary_failed' });
  }
});

// Backward: /api/admin/summary
router.get('/api/admin/summary', async (req,res)=>{
  try {
    allowCORS(req,res); noStore(res);
    res.json({ ok:true, totals: { users: 0, deposits: 0, revenue: 0 } });
  } catch (e) {
    res.json({ ok:false });
  }
});

// Events feed (stub)
router.get('/api/admin/events', async (req,res)=>{
  try { allowCORS(req,res); noStore(res); res.json({ ok:true, events: [] }); }
  catch { res.json({ ok:false }); }
});

// Manual topups (accept but no-op)
router.post('/api/admin/topups', async (req,res)=>{
  try { allowCORS(req,res); noStore(res); res.json({ ok:true }); }
  catch { res.json({ ok:false }); }
});

// Another old path guarded by UI
router.get('/api/admin/daily', async (req,res)=>{
  try { allowCORS(req,res); noStore(res); res.json({ ok:true, points: [] }); }
  catch { res.json({ ok:false }); }
});

export default router;
