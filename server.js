// server.js — API для GG ROOM (HUM баланс + линковка + события)
import publicRoutes from './src/routes_public.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import geoip from 'geoip-lite';

import { db, ensureTables, logEvent, updateUserCountryIfNull } from './src/db.js';
import adminRoutes from './src/routes_admin.js';
import authRouter from './src/routes_auth.js';
import linkRouter from './src/routes_link.js';
import tgRouter from './src/routes_tg.js';
import profileLinkRoutes from './src/routes_profile_link.js';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// === HUM: баланс по провайдеру (tg/vk) с суммой по hum_id ===
app.get('/api/balance/by-provider', async (req, res) => {
  try {
    const provider = String(req.query.provider || '').trim();
    const pid = String(req.query.provider_user_id || '').trim();
    if (!provider || !pid) return res.status(400).json({ ok:false, error:'bad_params' });

    const q = `
      with acc as (
        select user_id from auth_accounts where provider=$1 and provider_user_id=$2 limit 1
      ),
      me as (
        select id, coalesce(hum_id,id) as hum_id from users where id = (select user_id from acc)
      ),
      agg as (
        select sum(coalesce(balance,0))::bigint as hum_balance
        from users u join me on coalesce(u.hum_id,u.id)=me.hum_id
      )
      select u.id, u.first_name, u.last_name, u.avatar,
             (select hum_balance from agg) as balance
      from users u join me on u.id=me.id
      limit 1
    `;
    const r = await db.query(q, [provider, pid]);
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'not_found' });
    return res.json({ ok:true, user: r.rows[0] });
  } catch (e) {
    console.error('by-provider error', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// health
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/api/admin/health', (_req, res) => res.json({ ok: true }));

// helper: извлекаем uid из sid/JWT или X-User-Id
const resolveUserId = (req) => {
  const headerUid = Number(req.get('X-User-Id') || req.query.user_id || 0);
  if (Number.isFinite(headerUid) && headerUid > 0) return headerUid;

  const token = req.cookies?.sid;
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch { return null; }
};

// профиль текущего пользователя с HUM-балансом и флагами linked
// исправляю /api/me (убираю неоднозначный id) и оставляю флаги linked
app.get('/api/me', async (req, res) => {
  try {
    const headerUid = Number(req.get('X-User-Id') || req.query.user_id || 0);
    const resolveUserId = (req) => {
      if (Number.isFinite(headerUid) && headerUid > 0) return headerUid;
      const token = req.cookies?.sid;
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length < 2) return null;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const uid = Number(payload?.uid || 0);
        return Number.isFinite(uid) && uid > 0 ? uid : null;
      } catch { return null; }
    };

    const uid = resolveUserId(req);
    if (!uid) return res.json({ ok: false, error: 'no_user' });

    const query = `
      with me as (
        select id, coalesce(hum_id, id) as hum_id
        from users where id = $1
      ),
      cluster as (
        -- ВАЖНО: берём именно u.id, иначе "id" неоднозначен (u.id и me.id)
        select u.id as id
        from users u
        join me on coalesce(u.hum_id,u.id)=me.hum_id
      ),
      links as (
        select
          bool_or(provider='vk') as has_vk,
          bool_or(provider='tg') as has_tg
        from auth_accounts
        where user_id in (select id from cluster)
      ),
      agg as (
        select sum(coalesce(balance, 0))::bigint as hum_balance
        from users u join me on coalesce(u.hum_id, u.id) = me.hum_id
      )
      select u.id, u.vk_id, u.first_name, u.last_name, u.avatar,
             coalesce(u.hum_id, u.id) as hum_id,
             (select hum_balance from agg) as balance,
             (select has_vk from links) as has_vk,
             (select has_tg from links) as has_tg
      from users u join me on u.id = me.id
      limit 1
    `;
    const result = await db.query(query, [uid]);
    if (!result.rows?.length) return res.json({ ok: false, error: 'not_found' });

    const user = result.rows[0];
    const provider = String(user.vk_id || '').startsWith('tg:') ? 'tg' : 'vk';
    res.json({
      ok: true,
      user: {
        ...user,
        provider,
        linked: { vk: !!user.has_vk, tg: !!user.has_tg }
      }
    });
  } catch (e) {
    console.error('me error', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});



// маршруты
app.use('/api/admin', adminRoutes);
app.use('/api/profile/link', profileLinkRoutes);
app.use('/api/auth/tg', tgRouter);
app.use('/api/auth', authRouter);
app.use('/api', publicRoutes);
app.use('/api', linkRouter);

// события
app.post('/api/events', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ ok: false, error: 'type required' });

    const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHeader.split(',')[0].trim();
    let userId = resolveUserId(req);

    let country_code = null;
    try {
      const hit = ip && geoip.lookup(ip);
      if (hit && hit.country) country_code = hit.country;
    } catch {}

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

// root
app.get('/', (_req, res) => res.send('VK Auth backend up'));

// bootstrap
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API on', PORT));

(async () => {
  try {
    await ensureTables();
    console.log('DB ready (ensureTables done)');
  } catch (e) {
    console.error('DB init error (non-fatal):', e);
  }
})();
