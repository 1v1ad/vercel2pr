// src/routes_admin.js
import { Router } from 'express';
import express from 'express';
import { db } from './db.js';
import { resolvePrimaryUserId } from './merge.js';

const router = Router();

// чтобы JSON/URL-encoded тело читалось внутри admin-роутов
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

function adminAuth(req, res, next) {
  const serverPass = (process.env.ADMIN_PASSWORD || '').toString();
  const given =
    (req.get('X-Admin-Password') ||
     (req.body && req.body.pwd) ||
     req.query.pwd ||
     '').toString();

  if (!serverPass) {
    return res.status(500).json({ ok: false, error: 'admin_password_not_set' });
  }
  if (given !== serverPass) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// POST /admin/topup { userId, amount }
router.post('/topup', adminAuth, async (req, res) => {
  try {
    const { userId, amount } = req.body || {};
    const uid = await resolvePrimaryUserId(Number(userId));
    if (!uid || !Number.isFinite(Number(amount))) {
      return res.status(400).json({ ok: false, error: 'bad_input' });
    }
    const updated = await db.user.update({
      where: { id: uid },
      data: { balance: { increment: Number(amount) } },
      select: { id: true, balance: true }
    });
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error('[admin/topup] error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
