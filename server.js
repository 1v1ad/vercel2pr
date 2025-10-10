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
import publicRouter from './src/routes_public.js'; // <-- новый публичный роутер (GET /api/user/:id)

dotenv.config();

const app = express();
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/api/admin/health', (_req, res) => res.json({ ok: true }));

const resolveUserId = (req) => {
  const headerUid = Number(req.get('X-User-Id') || req.query.user_id || 0);
  if (Number.isFinite(headerUid) && headerUid > 0) {
    return headerUid;
  }

  const token = req.cookies?.sid;
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch {
    return null;
  }
};

app.get('/api/me', async (req, res) => {
  try {
    const uid = resolveUserId(req);
    if (!uid) return res.json({ ok: false, error: 'no_user' });

    const query = `
      with me as (
        select id, coalesce(hum_id, id) as hum_id
        from users where id = $1
      ),
      agg as (
        select sum(coalesce(balance, 0))::bigint as hum_balance
        from users u join me on coalesce(u.hum_id, u.id) = me.hum_id
      )
      select u.id, u.vk_id, u.first_name, u.last_name, u.avatar,
             coalesce(u.hum_id, u.id) as hum_id,
             (select hum_balance from agg) as balance
      from users u join me on u.id = me.id
      limit 1
    `;
    const result = await db.query(query, [uid]);
    if (!result.rows?.length) return res.json({ ok: false, error: 'not_found' });

    const user = result.rows[0];
    const provider = String(user.vk_id || '').startsWith('tg:') ? 'tg' : 'vk';
    res.json({ ok: true, user: { ...user, provider } });
  } catch (e) {
    console.error('me error', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- новый публичный роутер (например, GET /api/user/:id для точного баланса TG/VK) ---
app.use('/api', publicRouter);

app.use('/api/admin', adminRoutes);
app.use('/api/profile/link', profileLinkRoutes);
app.use('/api/auth/tg', tgRouter);
app.use('/api/auth', authRouter);
app.use('/api', linkRouter);

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

app.get('/', (_req, res) => res.send('VK Auth backend up'));

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
