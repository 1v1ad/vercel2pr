import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const {
  PORT = process.env.PORT || 8080,
  FRONTEND_ORIGIN,
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  REDIRECT_URI, // должен совпадать с redirectUrl на фронте и в "Доверенных Redirect URI"
  JWT_SECRET
} = process.env;

const prisma = new PrismaClient();
const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const signJWT = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
const auth = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.sendStatus(401); }
};

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Заглушка для VK redirect (просто 200 OK)
app.get('/api/auth/vk/callback', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><p>OK</p>');
});

// === Главный роут обмена кода ===
// Теперь используем новый VK ID OIDC endpoint: https://id.vk.com/oauth2/token
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no_code' });

  try {
    // 1) Обмен code -> access_token (OIDC)
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: String(VK_CLIENT_ID),
      client_secret: String(VK_CLIENT_SECRET),
      redirect_uri: String(REDIRECT_URI),
      code: String(code)
    });

    const tokenResp = await axios.post('https://id.vk.com/oauth2/token', form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000
    });
    const t = tokenResp.data;
    if (t.error) {
      console.error('VK token error:', t);
      return res.status(502).json({ error: 'vk_exchange_failed', details: t });
    }
    if (!t?.access_token) {
      console.error('VK token missing fields:', t);
      return res.status(502).json({ error: 'vk_access_token_failed' });
    }

    // 2) Профиль пользователя через user_info (OIDC)
    //   Вернёт: sub (id), given_name, family_name, name, picture, email (если доступ разрешён)
    const infoResp = await axios.get('https://id.vk.com/oauth2/user_info', {
      headers: { Authorization: `Bearer ${t.access_token}` },
      timeout: 8000
    });
    const u = infoResp.data || {};
    if (!u?.sub) {
      console.error('VK user_info missing sub:', u);
      return res.status(502).json({ error: 'vk_userinfo_failed' });
    }

    const vkId = Number(u.sub) || parseInt(u.sub, 10) || u.sub;

    await prisma.user.upsert({
      where: { vk_id: vkId },
      update: {
        first_name: u.given_name || u.name || null,
        last_name:  u.family_name || null,
        avatar:     u.picture || null,
        email:      u.email || null
      },
      create: {
        vk_id:      vkId,
        first_name: u.given_name || u.name || '',
        last_name:  u.family_name || '',
        avatar:     u.picture || null,
        email:      u.email || null
      }
    });

    // 3) JWT cookie (кросс-домен)
    res.cookie('token', signJWT({ id: vkId }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok: true });
  } catch (e) {
    const data = e?.response?.data;
    console.error('VK auth exception:', data || e.message || e);
    res.status(500).json({ error: 'vk_exchange_failed', details: data });
  }
});

// Текущий пользователь для lobby.html
app.get('/api/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { vk_id: req.user.id },
    select: { vk_id: true, first_name: true, last_name: true, avatar: true, email: true, created_at: true }
  });
  if (!me) return res.sendStatus(404);
  res.json(me);
});

// Выход
app.post('/api/logout', (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'none', secure: true });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API started on :${PORT}`);
  console.log(`VK app: ${VK_CLIENT_ID}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
});
