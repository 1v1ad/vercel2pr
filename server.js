import express from 'express';
import cookieParser from 'cookie-parser';
import authRouter from './src/routes_auth.js';

const app = express();

// Minimal env sanity log
console.log('[BOOT] env check:', {
  JWT_SECRET: !!process.env.JWT_SECRET,
  VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
  VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET,
  VK_REDIRECT_URI: !!process.env.VK_REDIRECT_URI,
  FRONTEND_URL: !!process.env.FRONTEND_URL,
});

app.use(cookieParser());

// Health checks
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/api/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));
app.get('/auth/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Mount the auth router on BOTH prefixes to avoid 404 due to prefix mismatches
app.use(['/api/auth', '/auth'], authRouter);

// Fallback 404 visibility
app.use((req, res, _next) => {
  res.status(404).type('text/plain').send(`Not found: ${req.method} ${req.originalUrl}`);
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log('API on :' + port);
  console.log('==> Try /api/auth/healthz and /api/auth/start');
});