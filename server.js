// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

import authRouter from './src/routes_auth.js';
import adminRouter from './src/routes_admin.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- базовая диагностика окружения (без утечек значений) ----
console.log('[BOOT] env check:', {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT || 3000,
  JWT_SECRET: !!process.env.JWT_SECRET,
  DATABASE_URL: !!process.env.DATABASE_URL,
  VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
  VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET,
  FEATURE_ADMIN: process.env.FEATURE_ADMIN,
  ADMIN_PASSWORD_SET: !!process.env.ADMIN_PASSWORD,
});

// ---- CORS (по умолчанию открыто, можно сузить FRONTEND_URL) ----
const origin = process.env.FRONTEND_URL || true;
app.use(cors({ origin, credentials: true }));

// ---- общие middlewares ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ---- статика фронта (если используется папка public) ----
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ---- маршруты авторизации/апи ----
app.use('/auth', authRouter);

// admin включает свою мидлвару авторизации внутри src/routes_admin.js
if (process.env.FEATURE_ADMIN === 'true' || process.env.FEATURE_ADMIN === '1') {
  app.use('/admin', adminRouter);
  console.log('[BOOT] /admin routes enabled');
} else {
  console.log('[BOOT] /admin routes disabled (FEATURE_ADMIN not true)');
}

// ---- health-check ----
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- SPA fallback (если нужно раздавать index.html для корня) ----
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---- запуск ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[BOOT] up on :${PORT}`);
});
