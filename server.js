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
const app    = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

/* helpers */
const sign = p => jwt.sign(p, JWT_SECRET, { expiresIn: '30d' });
const auth = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.sendStatus(401); }
};

/* ─── VK OAuth one-tap ─── */
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'no_code' });

  try {
    /* exchange code → access_token */
    const tokenURL =
      `https://oauth.vk.com/access_token` +
      `?client_id=${VK_CLIENT_ID}` +
      `&client_secret=${VK_CLIENT_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${code}`;

    const { data: t } = await axios.get(tokenURL);        // user_id, access_token, email
    const infoURL =
      `https://api.vk.com/method/users.get` +
      `?user_ids=${t.user_id}&fields=photo_100&v=5.199&access_token=${t.access_token}`;

    const { data: { response: [u] } } = await axios.get(infoURL);

    /* upsert user */
    await prisma.user.upsert({
      where:  { vk_id: u.id },
      update: {
        first_name: u.first_name,
        last_name:  u.last_name,
        avatar:     u.photo_100,
        email:      t.email
      },
      create: {
        vk_id: u.id,
        first_name: u.first_name,
        last_name:  u.last_name,
        avatar:     u.photo_100,
        email:      t.email
      }
    });

    res.cookie('token', sign({ id: u.id }), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   30 * 24 * 3600 * 1000
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).json({ error: 'vk_exchange_failed' });
  }
});

/* current user */
app.get('/api/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({ where: { vk_id: req.user.id } });
  res.json(me);
});

/* logout */
app.post('/api/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('API started on :' + PORT));
