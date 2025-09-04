import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import geoip from 'geoip-lite';

import { db, ensureTables, getUserById, logEvent, updateUserCountryIfNull } from './src/db.js';
import authRouter from './src/routes_auth.js';
import linkRouter from './src/routes_link.js';
import tgRouter from './src/routes_tg.js'; // ← Добавили

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Password'],
  maxAge: 86400,
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ← Добавили для form-urlencoded
app.use(cookieParser());

// Health (прогрев)
app.get('/health', (_, res) => res.status(200).send('ok'));

// Telegram auth callback (НОВОЕ)
app.use('/api/auth/tg', tgRouter);

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

        // Собираем кластер связанных аккаунтов (merged_into + общий device_id) и считаем суммарный баланс
    let clusterIds = [user.id];
    try {
      const rootQ = await db.query("select coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id=$1", [user.id]);
      const rootId = rootQ.rows && rootQ.rows[0] && rootQ.rows[0].root_id ? rootQ.rows[0].root_id : user.id;
      const baseQ = await db.query("select id from users where id=$1 or (meta->>'merged_into')::int = $1", [rootId]);
      const set = new Set(baseQ.rows.map(r => r.id));
      // расширяем по device_id
      const didsQ = await db.query("select distinct meta->>'device_id' as did from auth_accounts where user_id = any($1::int[]) and coalesce(meta->>'device_id','') <> ''", [Array.from(set)]);
      const dids = didsQ.rows.map(r => r.did).filter(Boolean);
      if (dids.length) {
        const moreQ = await db.query("select distinct user_id from auth_accounts where user_id is not null and coalesce(meta->>'device_id','') <> '' and meta->>'device_id' = any($1::text[])", [dids]);
        for (const r of moreQ.rows) set.add(r.user_id);
      }
      clusterIds = Array.from(set);
    } catch {}

    let effectiveBalance = user.balance ?? 0;
    try {
      const sumQ = await db.query("select coalesce(sum(coalesce(balance,0)),0)::int as total from users where id = any($1::int[])", [clusterIds]);
      effectiveBalance = (sumQ.rows && sumQ.rows[0] && sumQ.rows[0].total) ? sumQ.rows[0].total : (user.balance ?? 0);
    } catch {}

    res.json({
      ok: true,
      user: {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: effectiveBalance,
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

// слушаем порт сразу, чтобы Render не «висел» при пробуждении
app.listen(PORT, () => console.log(`API on :${PORT}`));

// Инициализацию БД запускаем асинхронно, без блокировки старта
(async () => {
  try {
    await ensureTables();
    console.log('DB ready (ensureTables done)');
  } catch (e) {
    console.error('DB init error (non-fatal):', e);
  }
})();
