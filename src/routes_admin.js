import { Router } from 'express';

const router = Router();

// health
router.get('/api/admin/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// summary/daily — параметр days из query (по умолчанию 7)
// фронт ранее бился об разные варианты — поддержим и кривые пути
router.get(['/api/admin/summary/daily', '/api/admin/daily', '/api/admin/dailyDays', /^\/api\/admin\/daily.*/], (req, res) => {
  const days = Number(req.query.days || req.query.limit || 7) || 7;
  const toISO = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const points = Array.from({ length: days }, (_, i) => ({
    date: toISO(days - 1 - i),
    users: 0,
    deposits: 0,
    revenue: 0
  }));
  res.json({ ok: true, points, daily: points });
});

// события в таблицы — пока пусто, но контракт сохраним
router.get('/api/admin/events', (req, res) => {
  res.json({ ok: true, rows: [], total: 0 });
});

// последние пополнения — пусто (пока БД не подключена)
router.get('/api/admin/topups', (req, res) => {
  res.json({ ok: true, rows: [], total: 0 });
});

// ручное пополнение — заглушка 200, чтобы интерфейс не падал
router.post('/api/admin/topup', (req, res) => {
  res.json({ ok: true });
});

export default router;
