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

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0) return cb(null, true);
    cb(CORS_ORIGINS.includes(origin) ? null : new Error('CORS: origin not allowed'), CORS_ORIGINS.includes(origin));
  },
  credentials: true,
}));
app.options('*', cors());

app.use(cookieParser());
app.use(express.json());

// Best-effort country by IP
app.use((req, _res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const geo = ip ? geoip.lookup(ip) : null;
    req.__country_code = geo?.country || null;
  } catch {}
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/auth/tg', tgRouter);
app.use('/api/admin', adminRouter);

app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies?.sid || null;
    const data = token ? (await import('./src/jwt.js')).then(m => m.verifySession(token)) : null;
    const user = data?.uid ? await getUserById(data.uid) : null;
    res.json({ ok: true, user, provider: data?.prov || null });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const token = req.cookies?.sid || null;
    const data = token ? (await import('./src/jwt.js')).then(m => m.verifySession(token)) : null;
    const userId = (await data)?.uid || null;
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
      await updateUserCountryIfNull(userId, { country_code, country_name: country_code });
    }

    res.json({ ok: true });
  } catch (e) {
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