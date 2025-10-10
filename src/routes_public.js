// Public routes
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

router.get('/user/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, error:'bad_id' });
  try {
    const row = await db.query(
      `select id, vk_id, first_name, last_name, avatar, provider, balance, created_at
       from users where id = $1 limit 1`, [id]
    );
    if (!row.rows?.length) return res.status(404).json({ ok:false, error:'not_found' });
    const u = row.rows[0];
    res.json({
      ok: true,
      user: {
        user_id: u.id,
        provider: u.provider || (String(u.vk_id||'').startsWith('tg:')?'tg':'vk'),
        first_name: u.first_name || null,
        last_name: u.last_name || null,
        avatar: u.avatar || null,
        balance: Number(u.balance || 0),
        created_at: u.created_at
      }
    });
  } catch (e) {
    console.error('GET /api/user/:id failed', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
