// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { ensureTables } from './src/db.js';
import authRouter from './src/routes_auth.js';
import adminRouter from './src/modules/admin/router.js'; // подключается по флагу ниже

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || '';
const PORT = process.env.PORT || 3001;

// CORS: разрешаем фронт и локалку
const allowedOrigins = new Set(
  FRONTEND_URL
    ? FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)
    : []
);
allowedOrigins.add('http://localhost:3000');
allowedOrigins.add('http://127.0.0.1:3000');

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / прямые запросы
      return cb(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(cookieParser());
app.use(express.json());

// Healthcheck
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Авторизация (рабочая, как в стабильной версии)
app.use('/api/auth', authRouter);

// Админка: только если включён фича-флаг
if (process.env.FEATURE_ADMIN === 'true') {
  app.use('/api/admin', adminRouter);
}

// Корень
app.get('/', (_req, res) => res.send('Backend is up'));

// Старт сервера после проверки/создания таблиц
ensureTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API listening on http://0.0.0.0:${PORT}`);
      console.log(`CORS allowed: ${[...allowedOrigins].join(', ')}`);
      if (process.env.FEATURE_ADMIN === 'true') {
        console.log('Admin module: ENABLED');
      } else {
        console.log('Admin module: disabled (set FEATURE_ADMIN=true to enable)');
      }
    });
  })
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
