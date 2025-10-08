// vercel2pr/src/server.js
// Node 18+/20+, ESM. Центральная точка API.

// ── базовое окружение ─────────────────────────────────────────────────────────
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { db } from './db.js';
import adminRoutes from './routes_admin.js';

// ── конфиг ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

// Если нужно ограничить фронты, укажи через запятую:
// FRONT_ORIGIN="https://sweet-twilight-63a9b6.netlify.app,https://example.com"
const ORIGINS = String(process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;            // SSR/curl
  if (ORIGINS.length === 0) return true; // dev/по умолчанию
  return ORIGINS.some(o => origin === o || origin.endsWith('.' + o.replace(/^\*\./,'').replace(/^https?:\/\//,'')));
}

const corsOptions = {
  origin(origin, cb) { cb(null, isAllowedOrigin(origin)); },
  credentials: true,
};

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ── health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/api/admin/health', (_req, res) => res.json({ ok: true }));

// ── /api/me — возвращаем HUM-баланс ──────────────────────────────────────────
// Источник user_id: временно из X-User-Id или из куки (как и было).
app.get('/api/me', async (req, res) => {
  try {
    const raw = req.get('X-User-Id') || req.cookies?.uid || req.cookies?.user_id || req.query?.uid || '';
    const uid = parseInt(String(raw), 10);
    if (!Number.isFinite(uid) || uid <= 0) return res.json({ ok: false, error: 'no_user' });

    // Берём строку пользователя
    const rMe = await db.query(
      `select id, coalesce(hum_id,id) as hum_id, vk_id,
              coalesce(first_name,'') first_name,
              coalesce(last_name,'')  last_name,
              coalesce(avatar,'')     avatar,
              coalesce(balance,0)     balance
         from users
        where id=$1`,
      [uid]
    );
    if (!rMe.rowCount) return res.json({ ok: false, error: 'user_not_found' });
    const me = rMe.rows[0];

    // HUM-сумма балансов по всем строкам с тем же HUM
    const rSum = await db.query(
      `with hid as (select coalesce(hum_id,id) h from users where id=$1)
       select coalesce(sum(u.balance),0)::int as hum_balance
         from users u, hid
        where coalesce(u.hum_id,u.id)=hid.h`,
      [uid]
    );
    const humBalance = rSum.rows?.[0]?.hum_balance ?? 0;

    const provider =
      me.vk_id && !String(me.vk_id).startsWith('tg:')
        ? 'vk'
        : (String(me.vk_id || '').startsWith('tg:') ? 'tg' : null);

    res.json({
      ok: true,
      user: {
        id: me.id,
        hum_id: me.hum_id,
        vk_id: me.vk_id,
        first_name: me.first_name,
        last_name: me.last_name,
        avatar: me.avatar,
        balance: humBalance, // ← показываем общий HUM-баланс
        provider,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ── админ-роуты ───────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);

// ── 404/ошибки ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: String(err?.message || err) });
});

// ── старт ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`API is live on :${PORT}`);
});

export default app;
