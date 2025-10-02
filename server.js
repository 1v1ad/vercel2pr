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

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  const requested = (req.headers['access-control-request-headers'] || '').toString().toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const base = ['content-type','x-admin-password','x-admin-name'];
  res.setHeader('Access-Control-Allow-Headers', Array.from(new Set([...base, ...requested])).join(', '));
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
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
    if (!token) return res.status(401).json({ ok:false });

    let payload;
    try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { return res.status(401).json({ ok:false }); }

    const { rows: urows } = await db.query('select * from users where id=$1', [payload.uid]);
    const user = urows[0];
    if (!user) return res.status(401).json({ ok:false });

    // cookie device id (добавляем к найденным для расширения кластера)
    const deviceIdCookie = (req.cookies && req.cookies['device_id']) ? String(req.cookies['device_id']) : null;

    // 1) корень по merged_into (если есть)
    const rootQ = await db.query("select coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id=$1", [user.id]);
    const rootId = (rootQ.rows && rootQ.rows[0] && rootQ.rows[0].root_id) ? rootQ.rows[0].root_id : user.id;

    // 2) базовый набор по merged_into
    const baseQ = await db.query("select id from users where id=$1 or (meta->>'merged_into')::int = $1", [rootId]);
    const ids = new Set(baseQ.rows.map(r => r.id));

    // 3) расширяем по device_id из auth_accounts + из cookie
    let dids = [];
    if (ids.size > 0) {
      const q1 = await db.query("select distinct meta->>'device_id' as did from auth_accounts where user_id = any($1::int[]) and coalesce(meta->>'device_id','') <> ''", [Array.from(ids)]);
      dids = q1.rows.map(r => r.did).filter(Boolean);
    }
    if (deviceIdCookie) dids = Array.from(new Set([...dids, deviceIdCookie]));
    if (dids.length > 0) {
      const q2 = await db.query("select distinct user_id from auth_accounts where user_id is not null and coalesce(meta->>'device_id','') <> '' and meta->>'device_id' = any($1::text[])", [dids]);
      for (const r of q2.rows) ids.add(r.user_id);
    }

    const clusterIds = Array.from(ids);
    const sumQ = await db.query("select coalesce(sum(coalesce(balance,0)),0)::int as total from users where id = any($1::int[])", [clusterIds]);
    const effectiveBalance = (sumQ.rows && sumQ.rows[0] && sumQ.rows[0].total) ? sumQ.rows[0].total : (user.balance||0);

    res.json({ ok:true, user: { id:user.id, vk_id:user.vk_id, first_name:user.first_name, last_name:user.last_name, avatar:user.avatar, balance:effectiveBalance } });
  } catch (e) {
    res.status(401).json({ ok:false });
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
