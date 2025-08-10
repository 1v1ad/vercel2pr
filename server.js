import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

// Рабочая авторизация (через куки/PKCE/pg)
import { ensureTables } from './src/db.js';
import authRouter from './src/routes_auth.js';

// Админка на Prisma (оставляем, добьём после)
import adminRouter from './src/routes/admin.js';

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL || '*';

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(cookieParser());
app.use(express.json());

// Авторизация VK
app.use('/api/auth', authRouter);

// Админка
app.use('/api/admin', adminRouter);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date() }));

// Root
app.get('/', (_req, res) => res.send('Backend up'));

const PORT = process.env.PORT || 3001;

ensureTables()
  .then(() => {
    app.listen(PORT, () => console.log(`API on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed', e);
    process.exit(1);
  });
