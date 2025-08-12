// src/routes_admin.js
import express from 'express';
import adminAuth from './middleware_admin.js';

let prisma = null;
try {
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient();
  console.log('Prisma loaded');
} catch (e) {
  console.log('Prisma not available, admin will return zeros');
}

const r = express.Router();

// /api/admin/summary
r.get('/summary', adminAuth, async (_req, res) => {
  try {
    let users = 0;
    if (prisma?.user) users = await prisma.user.count();
    const last7 = Array.from({length:7}, (_,i)=>{
      const d = new Date(); d.setDate(d.getDate() - (6-i));
      return { day: d.toISOString().slice(0,10), auths: 0, uniq: 0 };
    });
    res.json({ ok:true, cards: { users, events:0, auth7d:0, uniq7d:0 }, chart7d: last7 });
  } catch (e) {
    console.error('summary err', e);
    res.status(500).json({ ok:false, error:'summary_failed' });
  }
});

// /api/admin/users
r.get('/users', adminAuth, async (req, res) => {
  try {
    if (!prisma?.user) return res.json({ ok:true, items:[], total:0 });
    const q = (req.query.q||'').trim();
    const take = Math.min(parseInt(req.query.take||'50',10), 200);
    const skip = Math.max(parseInt(req.query.skip||'0',10), 0);
    const where = q ? { OR:[
      { vk_id: { contains:q } },
      { firstName: { contains:q } },
      { lastName: { contains:q } },
    ] } : {};
    const [items,total] = await Promise.all([
      prisma.user.findMany({ where, orderBy:{ id:'desc' }, take, skip,
        select:{ id:true, vk_id:true, firstName:true, lastName:true, avatar:true, balance:true, createdAt:true } }),
      prisma.user.count({ where })
    ]);
    res.json({ ok:true, items, total });
  } catch (e) {
    console.error('users err', e);
    res.status(500).json({ ok:false, error:'users_failed' });
  }
});

// /api/admin/events
r.get('/events', adminAuth, async (_req, res) => {
  try {
    // заглушка
    res.json({ ok:true, items:[], total:0 });
  } catch (e) {
    console.error('events err', e);
    res.status(500).json({ ok:false, error:'events_failed' });
  }
});

export default r;
