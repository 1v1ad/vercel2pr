// src/modules/admin/router.js
import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { requireAdmin, signAdmin } from '../../middleware/adminAuth.js';

const r = Router();

// POST /api/admin/login  { password }
r.post('/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'bad creds' });
    }
    const token = signAdmin({ role: 'admin' });
    return res.json({ token });
  } catch (e) {
    console.error('admin/login error:', e);
    return res.status(500).json({ error: 'internal' });
  }
});

// GET /api/admin/stats/overview
r.get('/stats/overview', requireAdmin, async (_req, res) => {
  try {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);
    const [totalUsers, totalEvents, last24hAuth] = await Promise.all([
      prisma.user.count(),
      prisma.event.count(),
      prisma.event.count({
        where: {
          event_type: 'auth_success',
          created_at: { gte: since24h },
        },
      }),
    ]);
    res.json({ totalUsers, totalEvents, last24hAuth });
  } catch (e) {
    console.error('stats/overview error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/admin/events?type=auth_success&page=1&limit=50
r.get('/events', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const skip = (page - 1) * limit;
    const type = (req.query.type || '').trim();
    const where = type ? { event_type: type } : {};

    const [items, count] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    res.json({ items, count, page, limit });
  } catch (e) {
    console.error('events list error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

export default r;
