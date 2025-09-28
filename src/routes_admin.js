// src/routes_admin.js
import express from 'express';
import { resolvePrimaryUserId, tx } from './db.js';

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

function toRublesInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) throw new Error('invalid_amount');
  return n > 0 ? Math.floor(n) : Math.ceil(n);
}

router.post(['/admin/topup', '/api/admin/topup'], ensureAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const rawId = body.user_id ?? body.id;
    const requestedId = Number(rawId);
    if (!Number.isInteger(requestedId) || requestedId <= 0) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }

    const amountRaw = body.amount ?? body.delta ?? body.value ?? body.sum;
    const delta = toRublesInt(amountRaw);

    const result = await tx(async ({ query, isPg }) => {
      const primaryId = await resolvePrimaryUserId(requestedId, query);
      const selectSql = isPg
        ? 'SELECT id, balance FROM users WHERE id = $1 FOR UPDATE'
        : 'SELECT id, balance FROM users WHERE id = $1';
      const { rows } = await query(selectSql, [primaryId]);
      if (!rows.length) throw new Error('user_not_found');

      const currentBalance = Number(rows[0].balance || 0);
      const newBalance = currentBalance + delta;

      await query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, primaryId]);
      await query('INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)', [
        primaryId,
        'balance_update',
        JSON.stringify({
          requested_user_id: requestedId,
          resolved_user_id: primaryId,
          delta,
        }),
      ]);

      return { balance: newBalance, primaryId };
    });

    res.json({ ok: true, balance: result.balance, user_id: result.primaryId });
  } catch (err) {
    const code = err?.message;
    if (code === 'invalid_amount') {
      return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (code === 'user_not_found') {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }
    console.error('/admin/topup error', err);
    res.status(500).json({ ok: false, error: 'topup_failed' });
  }
});

// no-op чтобы убрать 404 в лобби
router.post(['/link/background', '/api/link/background'], (req, res) => {
  res.json({ ok: true });
});

export default router;
