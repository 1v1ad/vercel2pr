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
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
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

// ---- OIDC discovery + fallback ----
const ISSUER = 'https://id.vk.com';
let TOKEN_ENDPOINT = null;
let USERINFO_ENDPOINT = null;

async function resolveVkIdEndpoints() {
  const fallbackToken = [
    `${ISSUER}/oauth2/token`,
    `${ISSUER}/oauth2/auth`
  ];
  const fallbackUserInfo = [
    `${ISSUER}/oauth2/userinfo`,
    `${ISSUER}/oauth2/user_info`
  ];

  try {
    const d = await axios.get(`${ISSUER}/.well-known/openid-configuration`, {
      timeout: 6000, validateStatus: () => true,
      headers: { Accept: 'application/json' }
    });
    if (d.status >= 200 && d.status < 300 && d.data) {
      TOKEN_ENDPOINT = d.data.token_endpoint || null;
      USERINFO_ENDPOINT = d.data.userinfo_endpoint || null;
      console.log('OIDC discovery OK:', {
        token_endpoint: TOKEN_ENDPOINT, userinfo_endpoint: USERINFO_ENDPOINT
      });
    } else {
      console.warn('OIDC discovery FAILED:', d.status, d.data?.error || '');
    }
  } catch (e) {
    console.warn('OIDC discovery error:', e.message);
  }

  // fallback, если discovery не дал URL
  if (!TOKEN_ENDPOINT) TOKEN_ENDPOINT = fallbackToken[0];
  if (!USERINFO_ENDPOINT) USERINFO_ENDPOINT = fallbackUserInfo[0];

  console.log('Using VK ID endpoints:', {
    TOKEN_ENDPOINT, USERINFO_ENDPOINT
  });
}
resolveVkIdEndpoints();

// ------------------- health/callback -------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/auth/vk/callback', (_req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><p>OK</p>');
});

// ------------------- VK exchange ----------------------
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no_code' });

  const logAxiosError = (label, err) => {
    console.error(`${label} FAILED:`, {
      status: err?.response?.status,
      url: err?.config?.url,
      data: err?.response?.data
    });
  };

  // Если внезапно ещё не успели определить эндпоинты на старте
  if (!TOKEN_ENDPOINT || !USERINFO_ENDPOINT) await resolveVkIdEndpoints();

  // --- 1) обмен code -> access_token ---
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: String(VK_CLIENT_ID),
    client_secret: String(VK_CLIENT_SECRET),
    redirect_uri: String(REDIRECT_URI),
    code: String(code)
  });

  let token;
  try {
    let resp = await axios.post(TOKEN_ENDPOINT, form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      timeout: 8000, validateStatus: () => true
    });

    // если 404 по текущему token endpoint — пробуем альтернативу
    if (resp.status === 404) {
      const alt = TOKEN_ENDPOINT.endsWith('/token')
        ? `${ISSUER}/oauth2/auth`
        : `${ISSUER}/oauth2/token`;
      console.warn('TOKEN 404, trying alt:', alt);
      TOKEN_ENDPOINT = alt;
      resp = await axios.post(TOKEN_ENDPOINT, form.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 8000, validateStatus: () => true
      });
    }

    if (resp.status < 200 || resp.status >= 300) {
      console.error('TOKEN ENDPOINT ERROR:', {
        status: resp.status, url: resp.config?.url, data: resp.data
      });
      return res.status(502).json({ error: 'vk_exchange_failed', details: resp.data });
    }
    token = resp.data;
  } catch (e) {
    logAxiosError('TOKEN REQUEST', e);
    return res.status(502).json({ error: 'vk_exchange_failed' });
  }

  if (token?.error || !token?.access_token) {
    console.error('TOKEN BODY ISSUE:', token);
    return res.status(502).json({ error: 'vk_access_token_failed', details: token });
  }

  // --- 2) userinfo ---
  try {
    // Особенность VK ID: добавим client_id в userinfo-запрос.
    const userinfoUrl = new URL(USERINFO_ENDPOINT);
    userinfoUrl.searchParams.set('client_id', String(VK_CLIENT_ID));

    let infoResp = await axios.get(userinfoUrl.toString(), {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      timeout: 8000, validateStatus: () => true
    });

    // если 404 — пробуем альтернативный путь
    if (infoResp.status === 404) {
      const alt = USERINFO_ENDPOINT.endsWith('/userinfo')
        ? `${ISSUER}/oauth2/user_info`
        : `${ISSUER}/oauth2/userinfo`;
      console.warn('USERINFO 404, trying alt:', alt);
      const altUrl = new URL(alt);
      altUrl.searchParams.set('client_id', String(VK_CLIENT_ID));
      USERINFO_ENDPOINT = alt;
      infoResp = await axios.get(altUrl.toString(), {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
        timeout: 8000, validateStatus: () => true
      });
    }

    if (infoResp.status < 200 || infoResp.status >= 300) {
      console.error('USERINFO ENDPOINT ERROR:', {
        status: infoResp.status, url: infoResp.config?.url, data: infoResp.data
      });
      return res.status(502).json({ error: 'vk_userinfo_failed', details: infoResp.data });
    }

    const u = infoResp.data || {};
    if (!u?.sub) {
      console.error('USERINFO missing sub:', u);
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

    res.cookie('token', signJWT({ id: vkId }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('USERINFO REQUEST FAILED:', {
      status: e?.response?.status,
      url: e?.config?.url,
      data: e?.response?.data
    });
    res.status(502).json({ error: 'vk_userinfo_failed' });
  }
});

// ------- API -------
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
