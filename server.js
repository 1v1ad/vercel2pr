import express from 'express';
import cookieParser from 'cookie-parser';
import authRouter from './src/routes_auth.js';
// Optional: alias so /api/auth/tg/* forwards to existing /api/tg/* routes you already have
import tgAlias from './src/tg_alias.js';

const app = express();

console.log('[BOOT] env check:', {
  JWT_SECRET: !!process.env.JWT_SECRET,
  VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
  VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET,
  VK_REDIRECT_URI: !!process.env.VK_REDIRECT_URI,
  FRONTEND_URL: !!process.env.FRONTEND_URL,
});

app.use(cookieParser());

// health
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/api/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));

// mount auth
app.use(['/api/auth', '/auth'], authRouter);

// keep TG login working if your real router lives on /api/tg/**
// (/api/auth/tg/* -> /api/tg/*)
app.use('/api/auth/tg', tgAlias);

// 404 fallback
app.use((req, res) => {
  res.status(404).type('text/plain').send(`Not found: ${req.method} ${req.originalUrl}`);
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log('API on :' + port);
  console.log('==> Try /api/auth/healthz and /auth/healthz');
});
