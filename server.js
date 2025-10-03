// ─────────────────────────────────────────────────────────────
// GG Room — backend (Render)
// Этот файл — единая точка входа. Render запускает его через npm start.
// ─────────────────────────────────────────────────────────────
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import bodyParser from 'body-parser';

import { db, ensureTables } from './src/db.js';
import adminRoutes from './src/routes_admin.js';
import authRoutes from './src/routes_auth.js';
import tgRoutes from './src/routes_tg.js';
import linkRoutes from './src/routes_link.js';

// ─────────────────────────────────────────────────────────────
// Настройки порта и базового URL фронта
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';

const app = express();

// ─────────────────────────────────────────────────────────────
// CORS: позволяем onrender.com, *.netlify.app, localhost
// с поддержкой credentials (cookies)
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  let allow = false;
  try {
    const h = new URL(origin).hostname;
    allow =
      h.endsWith('.netlify.app') ||
      h.endsWith('netlify.app') ||
      h.endsWith('.onrender.com') ||
      h === 'localhost' || h.endsWith('.localhost');
  } catch (_) {}
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────
// Общие middleware
// ─────────────────────────────────────────────────────────────
app.use(morgan('tiny'));
app.use(cookieParser());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────
// Вспомогалки
// ─────────────────────────────────────────────────────────────
function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

function uidFromSid(req) {
  try {
    const t = (req.cookies && req.cookies['sid']) || null;
    if (!t) return null;
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return (p && p.uid) || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// API: /api/me — возвращает пользователя и СУММАРНЫЙ баланс по кластеру
// (объединение VK+TG+device, плюс merged_into)
// ─────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  try {
    const uid = uidFromSid(req);
    if (!uid) return res.json({ ok: false });

    const { rows: r0 } = await db.query('select * from users where id=$1 limit 1', [uid]);
    if (!r0.length) return res.json({ ok: false });
    const user = r0[0];

    // собираем кластер id по session user
    const ids = new Set([user.id]);

    // 1) находим "root" по merged_into
    const { rows: rRoot } = await db.query(
      "select id, coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id=$1",
      [user.id]
    );
    const rootId = rRoot[0]?.root_id || user.id;
    ids.add(rootId);

    // 2) добавляем всех, кто в этот root слит
    const { rows: rMembers } = await db.query(
      "select id from users where (meta->>'merged_into')::int = $1",
      [rootId]
    );
    for (const r of rMembers) ids.add(r.id);

    // 3) device_id из cookie
    const deviceIdCookie = (req.cookies && req.cookies['device_id']) ? String(req.cookies['device_id']) : null;
    const dids = [];
    if (deviceIdCookie) dids.push(deviceIdCookie);

    // 4) по device_id тянем user_id из auth_accounts
    if (dids.length) {
      const q2 = await db.query(
        "select distinct user_id from auth_accounts where user_id is not null and coalesce(meta->>'device_id','')<>'' and meta->>'device_id' = any($1::text[])",
        [dids]
      );
      for (const r of q2.rows) ids.add(r.user_id);

      // фоллбек через provider_user_id → users
      const q2b = await db.query(`
        select distinct
          case
            when provider='vk' then (select id from users u where u.vk_id::text = a.provider_user_id limit 1)
            when provider='tg' then (select id from users u where u.vk_id = 'tg:' || a.provider_user_id limit 1)
            else null
          end as uid
        from auth_accounts a
        where coalesce(a.meta->>'device_id','')<>'' and a.meta->>'device_id' = any($1::text[])
      `, [dids]);
      for (const r of q2b.rows) if (r.uid) ids.add(r.uid);
    }

    // 5) ещё раз добавим root/members для всех найденных
    if (ids.size) {
      const allIds = Array.from(ids);
      const rootsQ = await db.query(
        "select id, coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id = any($1::int[])",
        [allIds]
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
    }

    const clusterIds = Array.from(ids);
    const { rows: sumRows } = await db.query(
      "select coalesce(sum(coalesce(balance,0)),0)::int as total from users where id = any($1::int[])",
      [clusterIds]
    );
    const total = sumRows[0]?.total ?? (user.balance || 0);

    res.json({
      ok: true,
      user: {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: total
      }
    });
  } catch (e) {
    res.status(401).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────────
// API: /api/events — лог клиентских событий
// ─────────────────────────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    const uid = uidFromSid(req);
    await db.query(
      'insert into events (user_id, event_type, payload, ip, ua) values ($1,$2,$3,$4,$5)',
      [ uid, String(type || ''), payload || {}, firstIp(req), (req.headers['user-agent']||'').slice(0,256) ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// ─────────────────────────────────────────────────────────────
// Маршруты
// ─────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);
app.use('/api/auth',  authRoutes);
app.use('/api/tg',    tgRoutes);
app.use('/api/link',  linkRoutes);

// ─────────────────────────────────────────────────────────────
// Старт
// ─────────────────────────────────────────────────────────────
ensureTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GG backend listening on :${PORT}; FRONTEND_URL=${FRONTEND_URL}`);
    });
  })
  .catch((e) => {
    console.error('ensureTables failed', e);
    process.exit(1);
  });
