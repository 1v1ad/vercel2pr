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
  REDIRECT_URI,
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
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
};

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/auth/vk/callback', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>OK</title><p>OK</p>');
});

app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'no_code' });

  try {
    const tokenURL =
      `https://oauth.vk.com/access_token` +
      `?client_id=${encodeURIComponent(VK_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(VK_CLIENT_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`;

    const { data: t } = await axios.get(tokenURL);

    if (t.error) {
      console.error('VK auth error (raw):', t);
      return res.status(502).json({ error: 'vk_exchange_failed', details: t });
    }

    if (!t?.access_token || !t?.user_id) {
      console.error('VK access_token missing fields:', t);
      return res.status(502).json({ error: 'vk_access_token_failed' });
    }

    const infoURL =
      `https://api.vk.com/method/users.get?user_ids=${t.user_id}&fields=photo_100&v=5.199&access_token=${encodeURIComponent(t.access_token)}`;

    const { data: info } = await axios.get(infoURL);
    const user = info?.response?.[0];
    if (!user) {
      console.error('VK users.get error:', info);
      return res.status(502).json({ error: 'vk_userinfo_failed' });
    }

    await prisma.user.upsert({
      where: { vk_id: user.id },
      update: {
        first_name: user.first_name,
        last_name:  user.last_name,
        avatar:     user.photo_100,
        email:      t.email || null
      },
      create: {
        vk_id:      user.id,
        first_name: user.first_name,
        last_name:  user.last_name,
        avatar:     user.photo_100,
        email:      t.email || null
      }
    });

    res.cookie('token', signJWT({ id: user.id }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('VK auth exception:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'vk_exchange_failed' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { vk_id: req.user.id },
    select: { vk_id: true, first_name: true, last_name: true, avatar: true, email: true, created_at: true }
  });
  if (!me) return res.sendStatus(404);
  res.json(me);
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'none', secure: true });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API started on :${PORT}`);
  console.log(`VK app: ${VK_CLIENT_ID}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
});
