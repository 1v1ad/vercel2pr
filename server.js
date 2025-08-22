import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import geoip from 'geoip-lite';

import {
  ensureTables,
  getUserById,
  logEvent,
  updateUserCountryIfNull,
} from './src/db.js';

import authRouter from './src/routes_auth.js';
import tgRouter from './src/routes_tg.js';
import adminRouter from './src/routes_admin.js';
import { verifySession } from './src/jwt.js';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || '*';
const DEVICE_ID_HEADER = process.env.DEVICE_ID_HEADER || 'x-device-id';

app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', DEVICE_ID_HEADER, 'x-admin-key'],
}));

app.use(cookieParser());
app.use(express.json());

// Geo by IP (best-effort)
app.use((req, _res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '')
      .toString()
      .split(',')[0]
      .trim();
    const geo = ip ? geoip.lookup(ip) : null;
    req.__country_code = geo?.country || null;
  } catch {}
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/auth/tg', tgRouter);
app.use('/api/admin', adminRouter);

// Frontend expects /api/me
app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies?.sid || null;
    const data = token ? verifySession(token) : null;
    const user = data?.uid ? await getUserById(data.uid) : null;
    res.json({ ok: true, user, provider: data?.prov || null });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const token = req.cookies?.sid || null;
    const data = token ? verifySession(token) : null;
    const userId = data?.uid || null;

    const country_code = req.__country_code || null;

    await logEvent({
      user_id: userId,
      event_type: String(req.body?.type || 'client_event'),
      payload: req.body?.payload || null,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
      country_code,
    });

    if (userId && country_code) {
      await updateUserCountryIfNull(userId, {
        country_code,
        country_name: country_code,
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/events error:', e?.message);
    res.status(500).json({ ok: false });
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