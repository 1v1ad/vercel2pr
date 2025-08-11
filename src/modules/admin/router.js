import { Router } from 'express';
import adminAuth from '../../middleware/adminAuth.js';
import prisma from '../../lib/prisma.js';

const router = Router();

// Все админ-маршруты защищаем
router.use(adminAuth);

// Статус
router.get('/health', async (_req, res) => {
  // Простая проверка подключения к БД
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, time: new Date().toISOString() });
});

// Список пользователей (пагинация через ?skip=&take=)
router.get('/users', async (req, res) => {
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);
  const users = await prisma.user.findMany({
    take,
    skip,
    orderBy: { id: 'desc' }
  });
  const total = await prisma.user.count();
  res.json({ total, take, skip, items: users });
});

// Список транзакций
router.get('/transactions', async (req, res) => {
  const take = Math.min(parseInt(req.query.take ?? '50', 10), 200);
  const skip = parseInt(req.query.skip ?? '0', 10);
  const tx = await prisma.transaction.findMany({
    take,
    skip,
    orderBy: { id: 'desc' },
    include: { user: { select: { id: true, vk_id: true, firstName: true, lastName: true } } }
  });
  const total = await prisma.transaction.count();
  res.json({ total, take, skip, items: tx });
});

// Простая агрегированная сводка
router.get('/summary', async (_req, res) => {
  const [users, txs] = await Promise.all([
    prisma.user.count(),
    prisma.transaction.findMany({ select: { type: true, amount: true } })
  ]);
  const byType = txs.reduce((acc, t) => {
    acc[t.type] = (acc[t.type] ?? 0) + t.amount;
    return acc;
  }, {});
  res.json({ users, volumeByType: byType });
});

export default router;
