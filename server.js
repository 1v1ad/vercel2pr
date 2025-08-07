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

// CORS под Netlify
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const signJWT = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.sendStatus(401);
  }
}

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// заглушка для редиректа (должна существовать и отдавать 200)
app.get('/api/auth/vk/callback', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><p>OK</p>');
});

// ===== обмен кода =====
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no_code' });

  // вспомогательный логгер ошибок axios
  const logAxiosError = (label, err) => {
    const s = err?.response?.status;
    const u = err?.config?.url;
    const d = err?.response?.data;
    console.error(`${label} FAILED:`, { status: s, url: u, data: d });
  };

  try {
    // 1) OIDC токен от VK ID: https://id.vk.com/oauth2/token
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: String(VK_CLIENT_ID),
      client_secret: String(VK_CLIENT_SECRET),
      redirect_uri: String(REDIRECT_URI),
      code: String(code),
    });

    let token;
    try {
      const tokenResp = await axios.post(
        'https://id.vk.com/oauth2/token',
        form.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          timeout: 8000,
          validateStatus: () => true, // сами проверим код
        }
      );

      if (tokenResp.status < 200 || tokenResp.status >= 300) {
        console.error('TOKEN ENDPOINT ERROR:', {
          status: tokenResp.status,
          url: tokenResp.config?.url,
          data: tokenResp.data,
        });
        return res.status(502).json({ error: 'vk_exchange_failed', details: tokenResp.data });
      }

      token = tokenResp.data;
    } catch (e) {
      logAxiosError('TOKEN REQUEST', e);
      return res.status(502).json({ error: 'vk_exchange_failed' });
    }

    if (token?.error) {
      console.error('TOKEN ERROR (body):', token);
      return res.status(502).json({ error: 'vk_exchange_failed', details: token });
    }
    if (!token?.access_token) {
      console.error('TOKEN MISSING FIELDS:', token);
      return res.status(502).json({ error: 'vk_access_token_failed' });
    }

    // 2) userinfo у VK ID — именно /oauth2/userinfo (НЕ user_info)
    let info;
    try {
      const infoResp = await axios.get('https://id.vk.com/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}`, 'Accept': 'application/json' },
        timeout: 8000,
        validateStatus: () => true,
      });

      if (infoResp.status < 200 || infoResp.status >= 300) {
        console.error('USERINFO ENDPOINT ERROR:', {
          status: infoResp.status,
          url: infoResp.config?.url,
          data: infoResp.data,
        });
        return res.status(502).json({ error: 'vk_userinfo_failed', details: infoResp.data });
      }

      info = infoResp.data;
    } catch (e) {
      logAxiosError('USERINFO REQUEST', e);
      return res.status(502).json({ error: 'vk_userinfo_failed' });
    }

    if (!info?.sub) {
      console.error('USERINFO MISSING sub:', info);
      return res.status(502).json({ error: 'vk_userinfo_failed' });
    }

    const vkId = Number(info.sub) || parseInt(info.sub, 10) || info.sub;

    await prisma.user.upsert({
      where: { vk_id: vkId },
      update: {
        first_name: info.given_name || info.name || null,
        last_name:  info.family_name || null,
        avatar:     info.picture || null,
        email:      info.email || null,
      },
      create: {
        vk_id:      vkId,
        first_name: info.given_name || info.name || '',
        last_name:  info.family_name || '',
        avatar:     info.picture || null,
        email:      info.email || null,
      }
    });

    // JWT-кука (кросс-домен)
    res.cookie('token', signJWT({ id: vkId }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000,
    });

    res.json({ ok: true });
  } catch (e) {
    // общий перехват, если что-то пошло не так
    console.error('VK auth exception (outer):', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'vk_exchange_failed' });
  }
});

// текущий пользователь
app.get('/api/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { vk_id: req.user.id },
    select: { vk_id: true, first_name: true, last_name: true, avatar: true, email: true, created_at: true },
  });
  if (!me) return res.sendStatus(404);
  res.json(me);
});

// logout
app.post('/api/logout', (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'none', secure: true });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API started on :${PORT}`);
  console.log(`VK app: ${VK_CLIENT_ID}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
});
