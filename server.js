import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import geoip from 'geoip-lite';

import { ensureTables, getUserById, logEvent, updateUserCountryIfNull } from './src/db.js';
import authRouter from './src/routes_auth.js';
import linkRouter from './src/routes_link.js';
import tgRouter from './src/routes_tg.js';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || '*';
const DEVICE_ID_HEADER = process.env.DEVICE_ID_HEADER || 'x-device-id';

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', DEVICE_ID_HEADER],
}));
app.use(cookieParser());
app.use(express.json());

// Log country code (best-effort) for IPs
app.use(async (req, _res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const geo = ip ? geoip.lookup(ip) : null;
    req.__country_code = geo?.country || null;
  } catch {}
  next();
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// API routers
app.use('/api/auth', authRouter);
app.use('/api/auth/tg', tgRouter);
app.use('/api', linkRouter);

// Example of a small whoami (could be useful for admin/front)
app.get('/api/whoami', async (req, res) => {
  try {
    const sid = req.cookies?.sid;
    if (!sid) return res.json({ ok: true, user: null });
    // do not verify here — front should call a "session verify" in real app
    return res.json({ ok: true, user: null });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API on :${PORT}`));

(async () => {
  try {
    await ensureTables();
    console.log('DB ready (ensureTables done)');
  } catch (e) {
    console.error('DB init error (non-fatal):', e);
  }
})();