// Public (non-admin) routes for GGRoom
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

// GET /api/user/:id — return safe profile for exact user id (used to show provider-specific balance on lobby)
router.get('/user/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, error:'bad_id' });
  try {
    const u = await db.user.findUnique({
      where: { id },
      select: { id:true, provider:true, first_name:true, last_name:true, balance:true, created_at:true }
    });
    if (!u) return res.status(404).json({ ok:false, error:'not_found' });
    // normalize output
    res.json({
      ok: true,
      user_id: u.id,
      provider: u.provider,
      first_name: u.first_name || null,
      last_name: u.last_name || null,
      balance: Number(u.balance || 0),
      created_at: u.created_at
    });
  } catch (e) {
    console.error('GET /api/user/:id failed', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

export default router;
