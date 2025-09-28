// src/routes_admin.js
import express from 'express';
import { getDb, logEvent } from './db.js';
import { resolvePrimaryUserId } from './merge.js';

const router = express.Router();

// --- Очень лёгкая «авторизация» админки (опционально) ---
// Поставь ADMIN_PASSWORD в ENV, чтобы требовать Authorization: Bearer <пароль>
// Если не задан — эндпойнты открыты (для дев/теста).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY || '';

function ensureAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const raw = (req.headers['authorization'] || '').toString();
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (token && token === ADMIN_PASSWORD) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

// health
router.get(['/admin/health', '/api/admin/health'], ensureAdmin, (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// сводка для графика (нужная форма данных)
router.get(['/admin/summary/daily', '/api/admin/summary/daily'], ensureAdmin, (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days || 7)));
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const iso = (d) => d.toISOString().slice(0, 10);

  const points = [];
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const date = iso(d);
    const row = { date, users: 0, deposits: 0, revenue: 0 };
    points.push(row);
    daily.push(row);
  }
  res.json({ ok: true, points, daily });
});

// заглушки списков
router.get(['/admin/users', '/api/admin/users'], ensureAdmin, (req, res) => {
  res.json({ ok: true, items: [], total: 0 });
});
router.get(['/admin/topups', '/api/admin/topups'], ensureAdmin, (req, res) => {
  res.json({ ok: true, items: [] });
});

router.post(['/admin/topup', '/api/admin/topup'], ensureAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const requestedId = Number(body.user_id ?? body.userId ?? 0);
    const rawAmount = body.amount;
    const amount = Number(rawAmount);
    if (!requestedId) {
      return res.status(400).json({ ok: false, error: 'bad_user_id' });
    }
    if (!Number.isFinite(amount) || !amount || Math.trunc(amount) !== amount) {
      return res.status(400).json({ ok: false, error: 'bad_amount' });
    }

    const primaryUserId = await resolvePrimaryUserId(requestedId);
    if (!primaryUserId) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    const db = getDb();
    const upd = await db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, primaryUserId]);
    if (!upd.changes) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    const row = await db.get(`SELECT balance FROM users WHERE id = ?`, [primaryUserId]);
    const reason = (body.reason || '').toString().trim() || null;
    await logEvent(primaryUserId, 'balance_update', {
      amount,
      reason,
      requested_user_id: requestedId,
      resolved_user_id: primaryUserId,
    });

    res.json({ ok: true, user_id: primaryUserId, balance: row?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'internal_error' });
  }
});

// no-op чтобы убрать 404 в лобби
router.post(['/link/background', '/api/link/background'], (req, res) => {
  res.json({ ok: true });
});

export default router;
