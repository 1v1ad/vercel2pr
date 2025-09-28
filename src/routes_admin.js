// src/routes_admin.js
import express from 'express';
import { tx, isPg } from './db.js';

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

function parseUserId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('invalid_user');
  return Math.trunc(n);
}

router.post(['/admin/topup', '/api/admin/topup'], ensureAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const requestedUserId = parseUserId(body.user_id ?? body.id ?? body.userId);
    const delta = toRublesInt(body.amount ?? body.delta);

    const nowExpr = isPg() ? 'now()' : "datetime('now')";

    const result = await tx(async (client) => {
      const selectSqlBase = 'SELECT id, balance, primary_user_id FROM users WHERE id = $1';
      const selectSql = isPg() ? `${selectSqlBase} FOR UPDATE` : selectSqlBase;

      const current = await client.query(selectSql, [requestedUserId]);
      if (!current.rows.length) {
        throw new Error('user_not_found');
      }

      const resolvedId = Number(current.rows[0].primary_user_id || current.rows[0].id);
      if (!resolvedId) {
        throw new Error('user_not_found');
      }

      let resolvedRow = current.rows[0];
      if (resolvedId !== current.rows[0].id) {
        const resolved = await client.query(selectSql, [resolvedId]);
        if (!resolved.rows.length) throw new Error('resolved_user_not_found');
        resolvedRow = resolved.rows[0];
      }

      const updateSql = `UPDATE users SET balance = COALESCE(balance,0) + $1, updated_at = ${nowExpr} WHERE id = $2 RETURNING balance`;
      const updated = await client.query(updateSql, [delta, resolvedId]);
      const newBalance = updated.rows[0]?.balance ?? (Number(resolvedRow.balance || 0) + delta);

      await client.query(
        'INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)',
        [
          resolvedId,
          'balance_update',
          {
            requested_user_id: requestedUserId,
            resolved_user_id: resolvedId,
            delta,
          },
        ]
      );

      return { balance: Number(newBalance), resolved_user_id: resolvedId };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err?.message || 'unknown_error';
    if (message === 'invalid_amount' || message === 'invalid_user') {
      return res.status(400).json({ ok: false, error: message });
    }
    if (message === 'user_not_found' || message === 'resolved_user_not_found') {
      return res.status(404).json({ ok: false, error: message });
    }
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
