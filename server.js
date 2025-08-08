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

const signJWT = (p) => jwt.sign(p, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.sendStatus(401); }
}

// ── VK ID OIDC endpoints ──
const ISSUER = 'https://id.vk.com';
let TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
let USERINFO_ENDPOINT = `${ISSUER}/oauth2/userinfo`;

async function resolveVkIdEndpoints() {
  try {
    const d = await axios.get(`${ISSUER}/.well-known/openid-configuration`, {
      timeout: 6000, validateStatus: () => true, headers: { Accept: 'application/json' }
    });
    if (d.status >= 200 && d.status < 300 && d.data) {
      TOKEN_ENDPOINT = d.data.token_endpoint || TOKEN_ENDPOINT;
      USERINFO_ENDPOINT = d.data.userinfo_endpoint || USERINFO_ENDPOINT;
      console.log('OIDC discovery OK:', { TOKEN_ENDPOINT, USERINFO_ENDPOINT });
      return;
    }
    console.warn('OIDC discovery FAILED:', d.status);
  } catch (e) {
    console.warn('OIDC discovery error:', e.message);
  }
  console.log('Using VK ID endpoints (fallback):', { TOKEN_ENDPOINT, USERINFO_ENDPOINT });
}
resolveVkIdEndpoints();

app.get('/health', (_req, res) => res.json({ ok: true }));

// На всякий: сохраняем device_id из callback (не обязательно)
app.get('/api/auth/vk/callback', (req, res) => {
  const deviceId = req.query.device_id || req.query.deviceId || '';
  if (deviceId) {
    res.cookie('vk_device_id', String(deviceId), {
      httpOnly: true, sameSite: 'none', secure: true, maxAge: 10*60*1000
    });
    console.log('VK device_id captured via callback');
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><p>OK</p>');
});

// ── обмен code → token → userinfo ──
app.post('/api/auth/vk', async (req, res) => {
  const {
    code,
    device_id: deviceIdBody,
    deviceId: deviceIdBodyCamel,
    code_verifier: verifierBody,
    verifier: verifierAlt,
    pkce_verifier: verifierAlt2
  } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no_code' });

  const device_id = deviceIdBody || deviceIdBodyCamel || req.cookies.vk_device_id || '';
  const code_verifier = verifierBody || verifierAlt || verifierAlt2 || '';

  if (!TOKEN_ENDPOINT || !USERINFO_ENDPOINT) await resolveVkIdEndpoints();

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: String(VK_CLIENT_ID),
    client_secret: String(VK_CLIENT_SECRET),
    redirect_uri: String(REDIRECT_URI),
    code: String(code),
    ...(device_id ? { device_id: String(device_id) } : {}),
    ...(code_verifier ? { code_verifier: String(code_verifier) } : {}) // ← PKCE!
  });

  // 1) token
  let tokenResp;
  try {
    tokenResp = await axios.post(TOKEN_ENDPOINT, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      timeout: 8000, validateStatus: () => true
    });
    if (tokenResp.status === 404) {
      const alt = TOKEN_ENDPOINT.endsWith('/token') ? `${ISSUER}/oauth2/auth` : `${ISSUER}/oauth2/token`;
      console.warn('TOKEN 404, trying alt:', alt);
      tokenResp = await axios.post(alt, form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        timeout: 8000, validateStatus: () => true
      });
    }
  } catch (e) {
    console.error('TOKEN REQUEST FAILED:', { status: e?.response?.status, url: e?.config?.url, data: e?.response?.data });
    return res.status(502).json({ error: 'vk_access_token_failed' });
  }

  if (tokenResp.status < 200 || tokenResp.status >= 300 || tokenResp.data?.error) {
    console.error('TOKEN ERROR:', { status: tokenResp.status, url: tokenResp.config?.url, data: tokenResp.data });
    return res.status(502).json({ error: 'vk_access_token_failed', details: tokenResp.data });
  }

  const token = tokenResp.data;
  if (!token?.access_token) {
    console.error('TOKEN MISSING FIELDS:', token);
    return res.status(502).json({ error: 'vk_access_token_failed' });
  }

  // 2) userinfo
  let infoResp;
  try {
    const uinfo = new URL(USERINFO_ENDPOINT);
    uinfo.searchParams.set('client_id', String(VK_CLIENT_ID));
    infoResp = await axios.get(uinfo.toString(), {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      timeout: 8000, validateStatus: () => true
    });
    if (infoResp.status === 404) {
      const alt = USERINFO_ENDPOINT.endsWith('/userinfo') ? `${ISSUER}/oauth2/user_info` : `${ISSUER}/oauth2/userinfo`;
      console.warn('USERINFO 404, trying alt:', alt);
      const altUrl = new URL(alt);
      altUrl.searchParams.set('client_id', String(VK_CLIENT_ID));
      infoResp = await axios.get(altUrl.toString(), {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
        timeout: 8000, validateStatus: () => true
      });
    }
  } catch (e) {
    console.error('USERINFO REQUEST FAILED:', { status: e?.response?.status, url: e?.config?.url, data: e?.response?.data });
    return res.status(502).json({ error: 'vk_userinfo_failed' });
  }

  if (infoResp.status < 200 || infoResp.status >= 300 || !infoResp.data) {
    console.error('USERINFO ERROR:', { status: infoResp.status, url: infoResp.config?.url, data: infoResp.data });
    return res.status(502).json({ error: 'vk_userinfo_failed', details: infoResp.data });
  }

  const u = infoResp.data;
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
    httpOnly: true, sameSite: 'none', secure: true, maxAge: 30 * 24 * 3600 * 1000
  });

  res.json({ ok: true });
});

// API
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
