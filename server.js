// src/server.js
// Node 20+, ESM. Центральная точка подключения роутов.
// Делает CORS с credentials, куки, health, и монтирует /api/admin + прочие маршруты.

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import morgan from 'morgan';

// ---------- конфиг ----------
const PORT = process.env.PORT || 10000;

// Разрешённые фронты (через запятую). Например:
// FRONT_ORIGIN="https://sweet-twilight-63a9b6.netlify.app,https://ggroom.app"
const ORIGINS = String(process.env.FRONT_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Функция допуска с поддоменами: *.example.com
function isAllowedOrigin(origin) {
  if (!origin) return true; // для curl / SSR
  if (ORIGINS.length === 0) return true; // если не задано — разрешим всё (dev)
  return ORIGINS.some(o => origin === o || origin.endsWith('.' + o.replace(/^\*\./, '')));
}

const corsOptions = {
  origin(origin, cb) {
    return cb(null, isAllowedOrigin(origin));
  },
  credentials: true,
};

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---------- health ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// этот эндпоинт ждёт админка при нажатии «Проверка»
app.get('/api/admin/health', (_req, res) => {
  res.json({ ok: true });
});

// ---------- роуты ----------
// Подключаем обязательно админские
import adminRoutes from './routes_admin.js';
app.use('/api/admin', adminRoutes);

// Остальные подключаем «мягко» — если файл есть
async function optional(path) {
  try {
    const m = await import(path);
    return m?.default || m;
  } catch {
    return null;
  }
}

// Примеры типичных модулей (подключатся, если существуют в репо)
const authRoutes = await optional('./routes_auth.js');
if (authRoutes) app.use('/api', authRoutes);

const meRoutes = await optional('./routes_me.js');
if (meRoutes) app.use('/api', meRoutes);

const profileRoutes = await optional('./routes_profile.js');
if (profileRoutes) app.use('/api', profileRoutes);

const linkRoutes = await optional('./routes_link.js');
if (linkRoutes) app.use('/api', linkRoutes);

// ---------- 404 / ошибки ----------
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

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`API is live on :${PORT}`);
});

export default app;
