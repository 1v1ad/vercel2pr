import express from 'express';
import cookieParser from 'cookie-parser';
import authRouter from './src/routes_auth.js';
import tgRouter from './src/routes_tg.js';

const app = express();

console.log('[BOOT] env check:', {
  JWT_SECRET: !!process.env.JWT_SECRET,
  VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
  VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET,
  VK_REDIRECT_URI: !!process.env.VK_REDIRECT_URI,
  FRONTEND_URL: !!process.env.FRONTEND_URL,
});

app.use(cookieParser());

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/api/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use(['/api/auth', '/auth'], authRouter);
app.use(['/api/auth', '/auth'], tgRouter);

app.use((req, res, _next) => {
  res.status(404).type('text/plain').send(`Not found: ${req.method} ${req.originalUrl}`);
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log('API on :' + port);
  console.log('==> Try /api/auth/healthz and /auth/healthz');
});
