// src/routes_auth.js
// Авторизация TG + VK, выдача JWT в httpOnly-куке, безопасные редиректы.
// Требует: cookie-parser в app, ENV: JWT_SECRET, TG_BOT_TOKEN,
// VK_CLIENT_ID, VK_CLIENT_SECRET, (опц.) FRONT_ORIGIN, COOKIE_DOMAIN.

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { verifyTelegramInitData } from './verifyTelegram.js';
import { db } from './db.js'; // ожидается твой обёрточный модуль БД

const router = Router();

// ────────────────────────────────────────────────────────────
// Конфиг
// ────────────────────────────────────────────────────────────
const JWT_SECRET = (process.env.JWT_SECRET || '').toString();
const COOKIE_NAME = process.env.AUTH_COOKIE || 'gg_token';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const FRONT_DEFAULT =
  process.env.FRONT_ORIGIN ||
  process.env.FRONT_URL ||
  'https://sweet-twilight-63a9b6.netlify.app'; // подставь свой фронт, если укажешь в ENV — возьмётся оттуда

const VK_CLIENT_ID = (process.env.VK_CLIENT_ID || '').toString();
const VK_CLIENT_SECRET = (process.env.VK_CLIENT_SECRET || '').toString();

// ────────────────────────────────────────────────────────────
// Утилиты
// ────────────────────────────────────────────────────────────
function backendBase(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').toString();
  const host = req.get('host');
  return `${proto}://${host}`;
}

function safeFront(next) {
  try {
    if (!next) return FRONT_DEFAULT;
    const u = new URL(next, FRONT_DEFAULT);
    // Не даём увести наружу: если origin другой — жёстко на наш FRONT.
    if (u.origin !== new URL(FRONT_DEFAULT).origin) return FRONT_DEFAULT;
    return u.toString();
  } catch {
    return FRONT_DEFAULT;
  }
}

function signJwt(claims) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not set');
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  const opt = {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
  };
  if (COOKIE_DOMAIN) opt.domain = COOKIE_DOMAIN;
  res.cookie(COOKIE_NAME, token, opt);
}

function clearAuthCookie(res) {
  const opt = { path: '/' };
  if (COOKIE_DOMAIN) opt.domain = COOKIE_DOMAIN;
  res.clearCookie(COOKIE_NAME, opt);
}

// На разных инсталлах БД-обёртка называется по-разному — делаем «мягкий» upsert.
// Если у тебя свои методы — просто адаптируй один блок внутри.
async function upsertUserFromProvider(provider, provider_id, profile = {}) {
  if (!db) return null;

  // 1) Если есть явный удобный метод — используем.
  if (typeof db.upsertUserFromProvider === 'function') {
    return db.upsertUserFromProvider(provider, provider_id, profile);
  }

  // 2) Частый вариант: найти по провайдеру → если нет — создать пользователя
  try {
    if (typeof db.userByProviderId === 'function') {
      const found = await db.userByProviderId(provider, provider_id);
      if (found) return found;
    }
  } catch (e) {
    console.warn('[auth] userByProviderId failed:', e?.message || e);
  }

  try {
    if (typeof db.createUserWithProvider === 'function') {
      return await db.createUserWithProvider({ provider, provider_id, profile });
    }
  } catch (e) {
    console.warn('[auth] createUserWithProvider failed:', e?.message || e);
  }

  // 3) Минимальный фоллбек — вообще без записи в БД (не рекомендуется, но даст жить фронту)
  return {
    id: null,
    name: profile.firstName || profile.username || 'User',
    avatar: profile.avatar || null,
    providers: [provider],
    provider_id,
  };
}

// ────────────────────────────────────────────────────────────
// Диагностика
// ────────────────────────────────────────────────────────────
router.get('/auth/ping', (req, res) => res.json({ ok: true, service: 'auth' }));

router.post('/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// Telegram Login Widget callback
// ────────────────────────────────────────────────────────────
// Прилетает GET с query-параметрами. Подписаны ТОЛЬКО телеграм-поля.
// Любые device_id и т.п. игнорируются в verify.
router.get('/auth/tg/callback', async (req, res) => {
  try {
    const check = verifyTelegramInitData(req.query, process.env.TG_BOT_TOKEN);
    if (!check.ok) {
      console.warn('[auth][tg] verify fail:', check.reason);
      return res.status(400).send('tg callback error');
    }

    const tg = check.data;
    const provider = 'tg';
    const provider_id = `tg:${tg.id}`;

    const profile = {
      firstName: tg.first_name || '',
      lastName: tg.last_name || '',
      username: tg.username || '',
      avatar: tg.photo_url || '',
    };

    const user = await upsertUserFromProvider(provider, provider_id, profile);

    // Собираем JWT. Минимальный набор — uid (может быть null, если БД не пишет).
    const token = signJwt({
      uid: user?.id ?? null,
      p: provider,
      pid: provider_id,
      name: user?.name || `${profile.firstName} ${profile.lastName}`.trim(),
      avatar: user?.avatar || profile.avatar || null,
      iat: Math.floor(Date.now() / 1000),
    });

    setAuthCookie(res, token);

    const next = safeFront(req.query.next || `${FRONT_DEFAULT}/lobby.html#tg`);
    return res.redirect(302, next);
  } catch (e) {
    console.error('[auth][tg] callback error:', e);
    return res.status(500).send('tg callback error');
  }
});

// ────────────────────────────────────────────────────────────
// VK OAuth (поддержка VK ID и классического oauth.vk.com)
// ────────────────────────────────────────────────────────────
router.get('/auth/vk/start', (req, res) => {
  const redirect_uri =
    process.env.VK_REDIRECT_URI ||
    `${backendBase(req)}/api/auth/vk/callback`;

  const state = encodeURIComponent(
    (req.query.next && safeFront(req.query.next)) || `${FRONT_DEFAULT}/lobby.html#vk`
  );

  // Стандартный VK ID
  const url =
    `https://id.vk.com/oauth2/auth?` +
    `response_type=code&client_id=${encodeURIComponent(VK_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&scope=${encodeURIComponent('email')}` +
    `&state=${state}`;

  return res.redirect(302, url);
});

async function exchangeVkToken(code, redirect_uri) {
  // 1) Пробуем VK ID
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri,
    });

    const r = await fetch('https://id.vk.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (r.ok) return await r.json();
  } catch (e) {
    console.warn('[auth][vk] id.vk.com token fail:', e?.message || e);
  }

  // 2) Фоллбек на классический oauth.vk.com
  const url =
    `https://oauth.vk.com/access_token?client_id=${encodeURIComponent(VK_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(VK_CLIENT_SECRET)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&code=${encodeURIComponent(code)}`;

  const r2 = await fetch(url);
  if (!r2.ok) throw new Error(`oauth.vk.com token HTTP ${r2.status}`);
  return await r2.json();
}

async function fetchVkProfile(access_token, user_id) {
  // Универсальный способ — обычный VK API
  const url =
    `https://api.vk.com/method/users.get?user_ids=${encodeURIComponent(user_id)}` +
    `&fields=photo_200,screen_name` +
    `&v=5.131&access_token=${encodeURIComponent(access_token)}`;

  const r = await fetch(url);
  const j = await r.json();
  if (!j || !j.response || !Array.isArray(j.response) || !j.response[0]) {
    throw new Error('vk users.get bad response');
  }
  const u = j.response[0];
  return {
    id: u.id,
    first_name: u.first_name,
    last_name: u.last_name,
    username: u.screen_name || '',
    photo_url: u.photo_200 || '',
  };
}

router.get('/auth/vk/callback', async (req, res) => {
  const code = (req.query.code || '').toString();
  if (!code) return res.status(400).send('vk code missing');

  try {
    const redirect_uri =
      process.env.VK_REDIRECT_URI ||
      `${backendBase(req)}/api/auth/vk/callback`;

    const tok = await exchangeVkToken(code, redirect_uri);

    // Форматы токена различаются; пытаемся аккуратно вытащить user_id + access_token
    const access_token = tok.access_token || tok.token || tok.accessToken;
    const user_id = tok.user_id || tok.uid || tok.userId || tok.user?.id;

    if (!access_token || !user_id) {
      console.warn('[auth][vk] no access_token or user_id in token:', tok);
      return res.status(400).send('vk token error');
    }

    const profileRaw = await fetchVkProfile(access_token, user_id);

    const provider = 'vk';
    const provider_id = `vk:${profileRaw.id}`;
    const profile = {
      firstName: profileRaw.first_name || '',
      lastName: profileRaw.last_name || '',
      username: profileRaw.username || '',
      avatar: profileRaw.photo_url || '',
    };

    const user = await upsertUserFromProvider(provider, provider_id, profile);

    const token = signJwt({
      uid: user?.id ?? null,
      p: provider,
      pid: provider_id,
      name:
        user?.name ||
        `${profile.firstName} ${profile.lastName}`.trim() ||
        profile.username ||
        'VK User',
      avatar: user?.avatar || profile.avatar || null,
      iat: Math.floor(Date.now() / 1000),
    });

    setAuthCookie(res, token);

    // state — это next в виде абсолютного URL нашей витрины
    const next = safeFront(req.query.state || `${FRONT_DEFAULT}/lobby.html#vk`);
    return res.redirect(302, next);
  } catch (e) {
    console.error('[auth][vk] callback error:', e);
    return res.status(500).send('vk callback error');
  }
});

// ────────────────────────────────────────────────────────────
// Утилити-ручка для фронта/диагностики
// ────────────────────────────────────────────────────────────
router.get('/auth/whoami', (req, res) => {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.json({ ok: true, user: null });
    const data = jwt.verify(raw, JWT_SECRET);
    res.json({ ok: true, user: data });
  } catch {
    res.json({ ok: true, user: null });
  }
});

export default router;
