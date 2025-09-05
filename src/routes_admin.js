// src/routes_admin.js
import { Router } from 'express';
import { db } from './db.js';
import { resolvePrimaryUserId } from './merge.js';

const router = Router();

function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || '').toString();
  const given = (req.get('X-Admin-Password') || (req.body && req.body.pwd) || req.query.pwd || '').toString();
  if (!serverPass) return res.status(401).json({ ok:false, error:'admin_password_not_set' });
  if (given !== serverPass) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}

router.get('/ping', adminAuth, (req, res) => res.json({ ok: true }));

router.post('/topup', adminAuth, async (req, res) => {
  try {
    const { userId, amount = 0, meta = null } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:'userId_required' });
    const primaryId = await resolvePrimaryUserId(Number(userId));
    await db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [Number(amount), primaryId]);
    await db.run('INSERT INTO transactions (userId, type, amount, meta) VALUES (?, ?, ?, ?)', [primaryId, 'deposit', Number(amount), meta]);
    res.json({ ok:true, userId: primaryId });
  } catch (e) {
    console.error('[ADMIN /topup] fail:', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

export default router;
