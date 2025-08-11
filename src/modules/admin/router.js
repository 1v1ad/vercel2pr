import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAdmin, signAdmin } from '../../middleware/adminAuth.js';

const r = Router();

// Логин по паролю из ENV
r.post('/login', async (req,res)=>{
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error:'bad creds' });
  return res.json({ token: signAdmin({ role:'admin' }) });
});

// Простые метрики
r.get('/stats/overview', requireAdmin, async (req,res)=>{
  const [totalUsers, totalEvents, last24hAuth] = await Promise.all([
    prisma.user.count(),
    prisma.event.count(),
    prisma.event.count({ where:{ event_type:'auth_success', created_at:{ gte: new Date(Date.now()-24*3600*1000) }}})
  ]);
  res.json({ totalUsers, totalEvents, last24hAuth });
});

// Лист событий (фильтры и пагинация)
r.get('/events', requireAdmin, async (req,res)=>{
  const { type, page='1', limit='50' } = req.query;
  const take = Math.min(parseInt(limit,10)||50, 200);
  const skip = (Math.max(parseInt(page,10)||1,1)-1)*take;
  const where = type ? { event_type:String(type) } : {};
  const [items, count] = await Promise.all([
    prisma.event.findMany({ where, orderBy:{ id:'desc' }, skip, take }),
    prisma.event.count({ where })
  ]);
  res.json({ items, count, page: Number(page), limit: take });
});

export default r;
