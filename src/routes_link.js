import { Router } from 'express';

const router = Router();

/**
 * Небольшой "сервисный" роутер под /api
 * Ничего лишнего не импортируем, чтобы не ломать деплой.
 * Если понадобится — добавим сюда реальные endpoints.
 */

// Простой health для /api
router.get('/alive', (_req, res) => {
  res.json({ ok: true });
});

// Можно посмотреть ip клиента (удобно для отладки)
router.get('/whoami', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  res.json({
    ok: true,
    ip,
    ua: req.headers['user-agent'] || '',
  });
});

export default router;
