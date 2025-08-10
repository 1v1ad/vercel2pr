import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import adminAuth from '../middleware/adminAuth.js';

const prisma = new PrismaClient();
const router = express.Router();

// POST /api/admin/login  { password }
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
    if (!password || password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// всё ниже — только для админа
router.use(adminAuth);

// GET /api/admin/metrics
router.get('/metrics', async (_req, res) => {
  try {
    const [usersCount, newUsers7d, active24h, balanceAgg, txAgg, txCount] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7*24*3600*1000) } } }),
      prisma.transaction.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: new Date(Date.now() - 24*3600*1000) } },
        _count: { userId: true }
      }).then(arr => arr.length),
      prisma.user.aggregate({ _sum: { balance: true } }),
      prisma.transaction.groupBy({ by: ['type'], _sum: { amount: true } }),
      prisma.transaction.count(),
    ]);

    const sumByType = Object.fromEntries(txAgg.map(x => [x.type, x._sum.amount || 0]));
    res.json({
      usersCount,
      newUsers7d,
      active24h,
      totalBalance: balanceAgg._sum.balance || 0,
      txCount,
      depositsSum: sumByType['deposit'] || 0,
      withdrawsSum: sumByType['withdraw'] || 0,
      winSum:      sumByType['win'] || 0,
      loseSum:     sumByType['lose'] || 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/admin/users?limit=100&q=...
router.get('/users', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const q = (req.query.q || '').trim();

    const where = q ? {
      OR: [
        { vk_id: { contains: q } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
      ]
    } : {};

    const items = await prisma.user.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit,
    });

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/admin/transactions?limit=200&type=...
router.get('/transactions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const type = (req.query.type || '').trim();
    const where = type ? { type } : {};

    const items = await prisma.transaction.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit,
    });

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
