// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter from './src/routes_auth.js';
import adminRouter from './src/routes_admin.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.use('/auth', authRouter);

if (process.env.FEATURE_ADMIN === 'true' || process.env.FEATURE_ADMIN === '1') {
  app.use('/admin', adminRouter);
  console.log('[BOOT] /admin routes enabled');
} else {
  console.log('[BOOT] /admin routes disabled (FEATURE_ADMIN not true)');
}

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[BOOT] up on :${PORT}`);
});
