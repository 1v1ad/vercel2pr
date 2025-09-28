// src/routes_admin.js
import express from 'express';
import { resolvePrimaryUserId } from './merge.js';
import { isPostgres, tx } from './db.js';

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
  const header = (req.headers['x-admin-password'] || '').toString().trim();
  if (header && header === ADMIN_PASSWORD) return next();
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

// no-op чтобы убрать 404 в лобби
router.post(['/link/background', '/api/link/background'], (req, res) => {
  res.json({ ok: true });
});

function toRublesInt(amount) {
  const x = Number(amount);
  if (!Number.isFinite(x) || x === 0) throw new Error('invalid_amount');
  return x > 0 ? Math.floor(x) : Math.ceil(x);
}

router.post(['/admin/topup', '/api/admin/topup'], ensureAdmin, async (req, res) => {
  try {
    const rawUserId = req.body?.userId ?? req.body?.user_id;
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_user' });
    }

    let delta;
    try {
      delta = toRublesInt(req.body?.amount);
    } catch (e) {
      if (e?.message === 'invalid_amount') {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
      }
      throw e;
    }

    const primaryId = await resolvePrimaryUserId(userId);
    let balance = null;

    await tx(async (exec) => {
      const selectSql = isPostgres()
        ? 'SELECT id, balance FROM users WHERE id = ? FOR UPDATE'
        : 'SELECT id, balance FROM users WHERE id = ?';
      const { rows } = await exec(selectSql, [primaryId]);
      if (!rows.length) throw new Error('user_not_found');

      await exec('UPDATE users SET balance = balance + ? WHERE id = ?', [delta, primaryId]);
      const { rows: balanceRows } = await exec('SELECT balance FROM users WHERE id = ?', [primaryId]);
      balance = Number(balanceRows[0]?.balance || 0);

      const payload = {
        requested_user_id: userId,
        resolved_user_id: primaryId,
        delta,
        balance,
      };
      await exec(
        'INSERT INTO events (user_id, type, meta) VALUES (?, ?, ?)',
        [primaryId, 'balance_update', JSON.stringify(payload)]
      );
    });

    res.json({ ok: true, user_id: primaryId, balance, delta });
  } catch (e) {
    if (e?.message === 'user_not_found') {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }
    console.error('/admin/topup error', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

export default router;
