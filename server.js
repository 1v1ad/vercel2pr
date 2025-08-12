// server.js — CORS + admin routes + health
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import adminRouter from './src/routes_admin.js';
import healthRouter from './src/routes_health.js';

const app = express();

app.use(cookieParser());
app.use(express.json());

const FRONT = process.env.FRONTEND_URL;

// CORS: важны credentials и разрешение нашего заголовка
app.use(cors({
  origin: [FRONT],
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: [
    'Content-Type','Authorization',
    'X-Admin-Password','X-Admin-Secret',
    'x-admin-password','x-admin-secret'
  ]
}));

// Health и версия
app.use('/api/health', healthRouter);

// Админ
if (process.env.FEATURE_ADMIN === 'true') {
  app.use('/api/admin', adminRouter);
} else {
  console.log('FEATURE_ADMIN is not true — admin routes disabled');
}

// здоровье
app.get('/', (_req, res) => res.json({ ok:true, ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('API on', PORT, 'FRONT=', FRONT, 'FEATURE_ADMIN=', process.env.FEATURE_ADMIN);
});
