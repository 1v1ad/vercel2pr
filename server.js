import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import adminRouter from './src/routes_admin.js';
import authRouter from './src/routes_auth.js'; // оставляем как есть у тебя; если файла нет — создай пустой роутер
import { ensureClusterId } from './src/merge.js';

const app = express();

// sanity log
console.log('[BOOT] env check:', {
  JWT_SECRET: !!process.env.JWT_SECRET,
  ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
  NODE_ENV: process.env.NODE_ENV || 'dev',
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Публичные/авторизационные
app.use(authRouter);
// Админ
app.use('/admin', adminRouter);

// Health
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 10000;

async function bootstrap() {
  await ensureClusterId(); // перенеcли сюда из routes_admin.js
  app.listen(PORT, () => console.log(`[BOOT] listening on ${PORT}`));
}

bootstrap().catch(err => {
  console.error('[BOOT] fatal:', err);
  process.exit(1);
});
