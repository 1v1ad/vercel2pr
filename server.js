import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import geoip from 'geoip-lite';

import { ensureTables, getUserById, logEvent, updateUserCountryIfNull } from './src/db.js';
import authRouter from './src/routes_auth.js';
import linkRouter from './src/routes_link.js';
import tgRouter from './src/routes_tg.js';

// Старт VK (редирект на oauth.vk.com, ставим httpOnly куки со state и did)
import makeVkStartRouter from './routes/vk_start_router.js';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

const FRONTEND_URL = process.env.FRONTEND_URL;

app.use(cors({
  origin: [
    FRONTEND_URL,
    'https://sweet-twilight-63a9b6.netlify.app',
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password', 'X-Device-Id'],
  maxAge: 86400,
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health
app.get('/health', (_, res) => res.status(200).send('ok'));

// === TG FIX: до роутера вычищаем НЕ-Telegram параметры, чтобы не ломать подпись ===
app.use('/api/auth/tg/callback', (req, _res, next) => {
  if (req.query) {
    const allowed = new Set([
      'id','first_name','last_name','username','photo_url','auth_date','hash'
    ]);
    for (const k of Object.keys(req.query)) {
      if (!allowed.has(k)) delete req.query[k]; // выкидываем did и прочее
    }
  }
  next();
});

// Telegram auth callback (как было)
app.use('/api/auth/tg', tgRouter);

// Старт VK (наш новый эндпоинт)
app.use('/api/auth/vk', makeVkStartRouter());

// Остальные маршруты
app.use('/api', linkRouter);
app.use('/api/auth', authRouter);

// === Admin feature (optional) ===
if ((process.env.FEATURE_ADMIN || '').toLowerCase() === 'true') {
  const { default: adminRouter } = await import('./src/routes_admin.js');
  app.use('/api/admin', adminRouter);
}

// Session info для фронта
app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies['sid'];
    if (!token) return res.status(401).json({ ok: false });

    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const user = await getUserById(payload.uid);
    if (!user) return res.status(401).json({ ok: false });

    res.json({
      ok: true,
      user: {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: user.balance ?? 0,
      },
    });
  } catch {
    res.status(401).json({ ok: false });
  }
});

// Client events (аналитика)
app.post('/api/events', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ ok: false, error: 'type required' });

    const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHeader.split(',')[0].trim();
    let userId = null;

    let country_code = null;
    try {
      const hit = ip && geoip.lookup(ip);
      if (hit && hit.country) country_code = hit.country;
    } catch {}

    const token = req.cookies['sid'];
    if (token) {
      try {
        const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        userId = p.uid || null;
      } catch {}
    }

    await logEvent({
      user_id: userId,
      event_type: String(type).slice(0, 64),
      payload: payload || null,
      ip,
      ua: (req.headers['user-agent'] || '').slice(0, 256),
      country_code,
    });

    if (userId && country_code) {
      await updateUserCountryIfNull(userId, { country_code, country_name: country_code });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('events error', e);
    res.status(500).json({ ok: false });
  }
});

// Root
app.get('/', (_, res) => res.send('VK Auth backend up'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API on :${PORT}`));

// Инициализация БД асинхронно
(async () => {
  try {
    await ensureTables();
    console.log('DB ready (ensureTables done)');
  } catch (e) {
    console.error('DB init error (non-fatal):', e);
  }
})();
