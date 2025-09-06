// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import adminRouter from './src/routes_admin.js';
import authRouter from './src/routes_auth.js';
import { ensureClusterId } from './src/merge.js';
import { initDB } from './src/db.js';

const app = express();
app.set('trust proxy', 1);

// базовые миддлвары
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// health
app.get(['/', '/health', '/healthz', '/health1'], (_req, res) =>
  res.json({ ok: true, ts: Date.now() })
);

// роуты (и дубль под /api для старых ссылок)
app.use(authRouter);
app.use('/api', authRouter);

app.use(adminRouter);
app.use('/api', adminRouter);

const PORT = process.env.PORT || 10000;

async function bootstrap() {
  // 1) инициализируем SQLite и миграции
  await initDB();

  // 2) необязательная инициализация cluster_id (если есть)
  try {
    if (typeof ensureClusterId === 'function') {
      await ensureClusterId();
    }
  } catch (e) {
    console.warn('[BOOT] ensureClusterId skipped:', e?.message || e);
  }

  // 3) стартуем сервер
  app.listen(PORT, () => console.log('[BOOT] listening on', PORT));
}

bootstrap().catch((e) => {
  console.error('[BOOT] fatal', e);
  process.exit(1);
});
