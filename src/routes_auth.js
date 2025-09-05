
// src/routes_auth.js — v13
// Changes vs v12:
//  - "Последний логин побеждает": при входе через VK/TG обновляем имя/аватар и ставим src_provider ('vk'|'tg')
//  - /api/me добавляет поле provider (из БД, иначе из cookie 'src')
//  - Сохраняем CORS/anti-cache, VK id_token декод, users.get fallback
import { Router } from 'express';
import crypto from 'crypto';
import { db, upsertVK, upsertTG } from './db.js';
import { signSession, readSession, clearSession, COOKIE_NAME, cookieOpts } from './jwt.js';

const router = Router();

const FRONT = process.env.FRONT_ORIGIN || process.env.FRONTEND_URL || process.env.FRONT_URL || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
const BACKEND_BASE =
  process.env.BACKEND_BASE ||
  process.env.PUBLIC_BACKEND_URL ||
  (process.env.VK_REDIRECT_URI ? new URL(process.env.VK_REDIRECT_URI).origin : '');

function allowCORS(req, res){
  const origin = req.headers.origin || '';
  const allowed = FRONT || origin || '*';
  res.set('Access-Control-Allow-Origin', allowed);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function noStore(res){
  res.set('Cache-Control','no-store, no-cache, must-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.set('Vary','Cookie, Origin');
}
function redirectAfterLogin(res){
  const to = process.env.AFTER_LOGIN_URL || (FRONT ? FRONT + '/lobby.html' : '/health');
  res.redirect(to);
}
function base64url(buf){
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function genCodeVerifier(){ return base64url(crypto.randomBytes(64)); }
function codeChallengeFrom(verifier){ return base64url(crypto.createHash('sha256').update(verifier).digest()); }
function cookieOptsPkce(){ return { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10 * 60 * 1000 }; }

// Health
function healthHandler(req,res){ allowCORS(req,res); noStore(res); res.json({ ok:true, ts: Date.now() }); }
router.all('/health', healthHandler);
router.all('/api/health', healthHandler);

// Build marker
router.get(['/auth/_build','/api/auth/_build'], (req, res) => {
  allowCORS(req,res); noStore(res);
  res.json({
    router: 'v13',
    uses: {
      TELEGRAM_BOT_TOKEN: !!(process.env.TELEGRAM_BOT_TOKEN),
      TG_BOT_TOKEN: !!(process.env.TG_BOT_TOKEN),
      FRONT_ORIGIN: !!(process.env.FRONT_ORIGIN),
      FRONTEND_URL: !!(process.env.FRONTEND_URL),
      FRONT_URL: !!(process.env.FRONT_URL),
      VK_REDIRECT_URI: process.env.VK_REDIRECT_URI || null,
      BACKEND_BASE: (process.env.BACKEND_BASE || process.env.PUBLIC_BACKEND_URL || null),
      VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
      VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET
    }
  });
});

// /api/me
router.options(['/api/me','/me'], (req,res)=>{ allowCORS(req,res); res.sendStatus(204); });
router.get(['/api/me','/me'], async (req, res) => {
  allowCORS(req,res); noStore(res);
  const sess = readSession(req);
  if (!sess?.uid) return res.json({ ok:true, user: null, provider: null });
  const u = await db.get('SELECT * FROM users WHERE id=?', [sess.uid]);
  let provider = null;
  try {
    const row = await db.get('SELECT src_provider FROM users WHERE id=?', [sess.uid]);
    provider = row?.src_provider || null;
  } catch {}
  if (!provider) provider = req.cookies?.src || null;
  res.json({ ok:true, user: u || null, provider });
});

router.post(['/api/logout','/logout'], (req, res) => { allowCORS(req,res); noStore(res); clearSession(res); res.json({ ok:true }); });

// --- VK OAuth ---
router.get(['/auth/vk/start','/api/auth/vk/start'], (req, res) => {
  const client_id = process.env.VK_CLIENT_ID;
  if (!client_id) return res.status(500).send('VK_CLIENT_ID is not set');
  const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');
  const state = crypto.randomBytes(16).toString('hex');
  const code_verifier = genCodeVerifier();
  const code_challenge = codeChallengeFrom(code_verifier);
  res.cookie('vk_state', state, cookieOptsPkce());
  res.cookie('vk_code_verifier', code_verifier, cookieOptsPkce());
  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'vkid.personal_info');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

async function vkAuthTokenViaIdHost({ code, client_id, client_secret, redirect_uri, code_verifier, device_id }){
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id,
    client_secret: client_secret || '',
    redirect_uri,
    code_verifier,
    device_id: device_id || ''
  });
  const resp = await fetch('https://id.vk.com/oauth2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { host:'id.vk.com', ok: resp.ok, status: resp.status, text, json };
}
async function vkAuthTokenViaLegacy({ code, client_id, client_secret, redirect_uri, code_verifier, device_id }){
  const params = new URLSearchParams({
    client_id,
    client_secret: client_secret || '',
    redirect_uri,
    code,
    code_verifier,
    device_id: device_id || ''
  });
  const resp = await fetch('https://oauth.vk.com/access_token?' + params.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { host:'oauth.vk.com', ok: resp.ok, status: resp.status, text, json };
}

router.get(['/auth/vk/callback','/api/auth/vk/callback'], async (req, res) => {
  try {
    allowCORS(req,res); noStore(res);
    const { code, state, device_id } = req.query;
    const savedState = req.cookies?.vk_state;
    const code_verifier = req.cookies?.vk_code_verifier;
    if (!code || !state || !savedState || savedState !== state || !code_verifier) {
      return res.status(400).send('invalid state');
    }
    res.clearCookie('vk_state', { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    const client_id = process.env.VK_CLIENT_ID;
    const client_secret = process.env.VK_CLIENT_SECRET || '';
    const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');

    const a1 = await vkAuthTokenViaIdHost({ code, client_id, client_secret, redirect_uri, code_verifier, device_id });
    const a2 = a1.ok ? null : await vkAuthTokenViaLegacy({ code, client_id, client_secret, redirect_uri, code_verifier, device_id });
    const success = a1.ok ? a1 : (a2 && a2.ok ? a2 : null);
    if (!success) {
      return res.status(502).send('vk token error: ' + JSON.stringify({
        attempts: [
          { host: a1.host, status: a1.status, body: a1.text?.slice(0,400) },
          a2 ? { host: a2.host, status: a2.status, body: a2.text?.slice(0,400) } : null
        ].filter(Boolean)
      }));
    }
    const token = success.json || {};

    // Resolve VK id
    let avatar = '', firstName = '', lastName = '';
    let vk_id = token.user_id?.toString() || (token.user && (token.user.id || token.user.user_id) ? String(token.user.id || token.user.user_id) : '');

    if (!vk_id && token.id_token && typeof token.id_token === 'string') {
      const parts = token.id_token.split('.');
      if (parts.length >= 2) {
        try {
          const payload = parts[1].replace(/-/g,'+').replace(/_/g,'/');
          const pad = payload.length % 4 === 2 ? '==' : (payload.length % 4 === 3 ? '=' : '');
          const json = JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
          vk_id = String(json.sub || json.user_id || json.uid || '');
          firstName = firstName || json.given_name || json.first_name || '';
          lastName  = lastName  || json.family_name || json.last_name || '';
          avatar    = avatar    || json.picture || json.photo || '';
        } catch {}
      }
    }

    // users.get try
    try {
      if (token.access_token) {
        const apiV = process.env.VK_API_VERSION || '5.199';
        const infoResp = await fetch(`https://api.vk.com/method/users.get?v=${apiV}&fields=photo_200&access_token=${encodeURIComponent(token.access_token)}`);
        const info = await infoResp.json();
        if (info?.response?.[0]) {
          const p = info.response[0];
          if (p.id) vk_id = String(p.id);
          firstName = p.first_name || firstName || '';
          lastName = p.last_name || lastName || '';
          avatar = p.photo_200 || avatar || '';
        }
      }
    } catch {}

    if (!vk_id) {
      return res.status(502).send('vk: cannot resolve user id');
    }

    const user = await upsertVK(vk_id, { firstName, lastName, avatar });

    // LAST-LOGIN-WINS: обновляем базовые поля и маркер провайдера
    try {
      await db.run('UPDATE users SET first_name=?, last_name=?, avatar=?, src_provider=? WHERE id=?',
        [firstName || user.first_name || '', lastName || user.last_name || '', avatar || user.avatar || '', 'vk', user.id]);
    } catch {}

    const jwt = signSession({ uid: user.id });
    res.cookie(COOKIE_NAME, jwt, cookieOpts());
    res.cookie('src', 'vk', { ...cookieOpts(), httpOnly:false });
    redirectAfterLogin(res);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('vk callback error');
  }
});

// VK debug
router.get(['/auth/vk/debug','/api/auth/vk/debug'], (req, res) => {
  allowCORS(req,res); noStore(res);
  res.json({
    client_id_present: !!process.env.VK_CLIENT_ID,
    has_secret: !!process.env.VK_CLIENT_SECRET,
    redirect_uri: (process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback')),
    state_cookie: !!req.cookies?.vk_state,
    verifier_cookie: !!req.cookies?.vk_code_verifier
  });
});

// --- Telegram ---
function parseRawQuery(req){
  const idx = req.originalUrl.indexOf('?');
  const raw = idx >= 0 ? req.originalUrl.slice(idx+1) : '';
  const usp = new URLSearchParams(raw);
  const obj = {};
  for (const [k,v] of usp.entries()){ obj[k] = v; }
  return obj;
}
const TG_ALLOWED_KEYS = new Set(['id','first_name','last_name','username','photo_url','auth_date','hash']);
function buildDataCheckStringFiltered(obj){
  const entries = Object.entries(obj)
    .filter(([k]) => k !== 'hash' && TG_ALLOWED_KEYS.has(k))
    .sort(([a],[b]) => a.localeCompare(b));
  return entries.map(([k,v]) => `${k}=${v}`).join('\n');
}
function verifyTelegramAuth(req, botToken){
  const data = parseRawQuery(req);
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const checkHash = data.hash;
  const dataCheck = buildDataCheckStringFiltered(data);
  const hmac = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const authDate = Number(data.auth_date || '0');
  if (authDate && (Math.floor(Date.now()/1000) - authDate) > 24*3600) return false;
  return hmac === checkHash;
}

router.get(['/auth/tg/callback','/api/auth/tg/callback'], async (req, res) => {
  try {
    allowCORS(req,res); noStore(res);
    const botToken = TG_TOKEN;
    if (!botToken) return res.status(500).send('TELEGRAM_BOT_TOKEN not set');
    if (!verifyTelegramAuth(req, botToken)) return res.status(401).send('tg verify fail');

    const q = parseRawQuery(req);
    const tg_id = q.id?.toString();
    const firstName = q.first_name || '';
    const lastName = q.last_name || '';
    const avatar = q.photo_url || '';
    const user = await upsertTG(tg_id, { firstName, lastName, avatar });

    // last-login-wins
    try {
      await db.run('UPDATE users SET first_name=?, last_name=?, avatar=?, src_provider=? WHERE id=?',
        [firstName || user.first_name || '', lastName || user.last_name || '', avatar || user.avatar || '', 'tg', user.id]);
    } catch {}

    const jwt = signSession({ uid: user.id });
    res.cookie(COOKIE_NAME, jwt, cookieOpts());
    res.cookie('src', 'tg', { ...cookieOpts(), httpOnly:false });
    redirectAfterLogin(res);
  } catch (e) {
    console.error('[TG callback] error', e);
    res.status(500).send('tg callback error');
  }
});

export default router;
