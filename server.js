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
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// mounts
app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRouter);
app.use('/api/tg', tgRouter);
// линковка: поддерживаем и новый и старый пути
app.use('/api/link', linkRouter);
app.use('/api', linkRouter); // fallback для старых клиентов
app.use('/api/profile-link', profileLinkRoutes);

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