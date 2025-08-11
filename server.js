// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { ensureTables } from './src/db.js';
import authRouter from './src/routes_auth.js';
import adminRouter from './src/modules/admin/router.js'; // за флагом ниже

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || '';
const PORT = process.env.PORT || 3001;

// CORS
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
      if (!origin) return cb(null, true);
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

// Авторизация (стабильно, как сейчас)
app.use('/api/auth', authRouter);

// ✅ Админка только по фиче-флагу
if (process.env.FEATURE_ADMIN === 'true') {
  app.use('/api/admin', adminRouter);
}

// Корень
app.get('/', (_req, res) => res.send('Backend is up'));

// Старт
ensureTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API listening on http://0.0.0.0:${PORT}`);
      console.log(`Admin module: ${process.env.FEATURE_ADMIN === 'true' ? 'ENABLED' : 'disabled'}`);
    });
  })
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
