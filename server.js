// server.js — backend for vercel2pr
// ──────────────────────────────────────────────────────────────────────────────
// Включает:
//  - динамический CORS с поддержкой Netlify Deploy Preview
//  - /api/me: суммарный баланс по кластеру (VK+TG+device) + merged_into
//  - /api/events: сбор аналитики
//  - роуты: /api/auth/*, /api/tg/*, /api/link/*, /api/admin/*
//  - trust proxy, cookies, json, логгирование
// ──────────────────────────────────────────────────────────────────────────────

// вариант А — короче и обычно удобнее
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { db, ensureTables } from './src/db.js';
import adminRoutes from './src/routes_admin.js';
import authRoutes from './src/routes_auth.js';
import tgRoutes from './src/routes_tg.js';
import linkRoutes from './src/routes_link.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);

// ──────────────────────────────────────────────────────────────────────────────
// CORS (динамический origin + credentials:true)
// Разрешаем основной фронт и превью: https://deploy-preview-XX--sweet-twilight-63a9b6.netlify.app
// Обнови FRONTEND_URL при необходимости.
// ──────────────────────────────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const allowList = new Set([
  FRONTEND_URL,
  'http://localhost:5173',
  'https://sweet-twilight-63a9b6.netlify.app',
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / same-origin
  if (allowList.has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (!/^https?:$/.test(protocol)) return false;
    // Любые превью Netlify для этого сайта:
    // https://deploy-preview-<n>--sweet-twilight-63a9b6.netlify.app
    if (hostname.endsWith('--sweet-twilight-63a9b6.netlify.app')) return true;
  } catch (_) {}
  return false;
}

const corsOptions = {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'OPTIONS'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ──────────────────────────────────────────────────────────────────────────────
// Parsers & logging
// ──────────────────────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ──────────────────────────────────────────────────────────────────────────────
// База и таблицы
// ──────────────────────────────────────────────────────────────────────────────
await ensureTables();

// ──────────────────────────────────────────────────────────────────────────────
// Вспомогалки
// ──────────────────────────────────────────────────────────────────────────────
function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

async function getUserById(id) {
  const { rows } = await db.query('select * from users where id=$1', [id]);
  return rows[0] || null;
}

// Дешифровка sid без проверки подписи (как в роут-пакетах)
function uidFromSid(req) {
  try {
    const t = req.cookies && req.cookies.sid;
    if (!t) return null;
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return p && p.uid || null;
  } catch (_) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// /api/me — суммарный баланс по кластеру (VK+TG+device + merged_into)
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  try {
    const uid = uidFromSid(req);
    if (!uid) return res.status(401).json({ ok: false });

    const user = await getUserById(uid);
    if (!user) return res.status(401).json({ ok: false });

    const ids = new Set([user.id]);

    // 1) расширяем кластер через merged_into (корень + участники)
    const rootsQ = await db.query(
      "select id, coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id = any($1::int[])",
      [[user.id]]
    );
    const extraRoots = new Set();
    for (const row of rootsQ.rows) {
      if (row.root_id && !ids.has(row.root_id)) extraRoots.add(row.root_id);
    }
    for (const root of extraRoots) ids.add(root);
    if (extraRoots.size) {
      const membersQ = await db.query(
        "select id from users where (meta->>'merged_into')::int = any($1::int[])",
        [Array.from(extraRoots)]
      );
      for (const row of membersQ.rows) ids.add(row.id);
    }

    // 2) собираем device_id из cookie и учётных записей, связанных с пользователем
    const dids = new Set();
    const deviceCookie = req.cookies && req.cookies['device_id'] ? String(req.cookies['device_id']) : null;
    if (deviceCookie) dids.add(deviceCookie);

    const q1 = await db.query(
      "select distinct nullif(meta->>'device_id','') as did from auth_accounts where user_id = any($1::int[]) and coalesce(meta->>'device_id','') <> ''",
      [[user.id]]
    );
    for (const r of q1.rows) if (r.did) dids.add(r.did);

    const didList = Array.from(dids);

    // 3) по device_id подтягиваем user_id из auth_accounts + fallback через provider_user_id
    if (didList.length) {
      const q2 = await db.query(
        "select distinct user_id from auth_accounts where user_id is not null and coalesce(meta->>'device_id','')<>'' and meta->>'device_id' = any($1::text[])",
        [didList]
      );
      for (const r of q2.rows) if (r.user_id) ids.add(r.user_id);

      const q2b = await db.query(`
        select distinct
          case
            when provider='vk' then (select id from users u where u.vk_id::text = a.provider_user_id limit 1)
            when provider='tg' then (select id from users u where u.vk_id = 'tg:' || a.provider_user_id limit 1)
            else null
          end as uid
        from auth_accounts a
        where coalesce(a.meta->>'device_id','') <> ''
          and a.meta->>'device_id' = any($1::text[])
      `, [didList]);
      for (const r of q2b.rows) if (r.uid) ids.add(r.uid);
    }

    // 4) финально снова расширим по merged_into на случай, если подтянули новые id
    if (ids.size) {
      const allIds = Array.from(ids);
      const rootsQ2 = await db.query(
        "select id, coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id = any($1::int[])",
        [allIds]
      );
      const extraRoots2 = new Set();
      for (const row of rootsQ2.rows) {
        if (row.root_id && !ids.has(row.root_id)) extraRoots2.add(row.root_id);
      }
      for (const root of extraRoots2) ids.add(root);
      if (extraRoots2.size) {
        const membersQ2 = await db.query(
          "select id from users where (meta->>'merged_into')::int = any($1::int[])",
          [Array.from(extraRoots2)]
        );
        for (const row of membersQ2.rows) ids.add(row.id);
      }
    }

    const clusterIds = Array.from(ids);
    const { rows: sumRows } = await db.query(
      "select coalesce(sum(coalesce(balance,0)),0)::int as total from users where id = any($1::int[])",
      [clusterIds]
    );
    const total = (sumRows[0] && sumRows[0].total) ? sumRows[0].total : (user.balance || 0);

    res.json({
      ok: true,
      user: {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: total,
      }
    });
  } catch (e) {
    console.error('/api/me error:', e?.message || e);
    res.status(401).json({ ok: false });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// /api/events — сбор аналитики с клиента
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  try {
    const { type, event_type, payload } = req.body || {};
    const uid = uidFromSid(req);
    const ip = firstIp(req);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 512);

    // Совместимость: поле event_type — основное; type — на всякий случай
    const et = (event_type || type || '').toString().slice(0, 64) || 'client_event';

    await db.query(
      'insert into events (user_id, event_type, payload, ip, ua) values ($1,$2,$3,$4,$5)',
      [uid, et, payload || {}, ip, ua]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/events error:', e?.message || e);
    res.status(500).json({ ok: false });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Подключаем роуты
// ──────────────────────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);
app.use('/api/auth',  authRoutes);
app.use('/api/tg',    tgRoutes);
app.use('/api/link',  linkRoutes);

// healthcheck
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Статические файлы (если нужны)
app.use('/static', express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
  console.log('FRONTEND_URL:', FRONTEND_URL);
});
