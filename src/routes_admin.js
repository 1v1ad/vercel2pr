import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function readAdminKey(req) {
  // Accept both headers and optional ?key= for convenience
  return req.headers['x-admin-key'] || req.headers['x-admin-password'] || req.query.key || '';
}
function auth(req) {
  const key = String(readAdminKey(req));
  const expected = String(process.env.ADMIN_PASSWORD || '');
  return expected && key === expected;
}

// GET /api/admin/summary
router.get('/summary', async (req, res) => {
  if (!auth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const { rows: u1 } = await db.query('select count(*)::int as users from users');
    const { rows: e1 } = await db.query('select count(*)::int as events from events');
    const { rows: a7 } = await db.query(`
      select
        count(*)::int as auth_total_7d,
        count(distinct user_id)::int as uniq_7d
      from events
      where created_at >= now() - interval '7 day' and event_type = 'auth_ok'
    `);

    res.json({
      ok: true,
      users: u1[0]?.users || 0,
      events: e1[0]?.events || 0,
      auth_7d: a7[0]?.auth_total_7d || 0,
      uniq_7d: a7[0]?.uniq_7d || 0,
      chart: [],
    });
  } catch (e) {
    console.error('admin /summary error', e?.message);
    res.status(500).json({ ok: false });
  }
});

export default router;