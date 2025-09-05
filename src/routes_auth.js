
// src/routes_auth.js — v9
// - Anti-cache headers for auth and /api/me
// - VK token exchange: id.vk.com (PKCE, with/without secret) -> fallback oauth.vk.com/access_token (legacy)
// - TELEGRAM_BOT_TOKEN + strict TG verify
import { Router } from 'express';
import crypto from 'crypto';
import { db, upsertVK, upsertTG } from './db.js';
import { signSession, readSession, clearSession, COOKIE_NAME, cookieOpts } from './jwt.js';

const router = Router();

function noStore(res){
  res.set('Cache-Control','no-store, no-cache, must-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.set('Vary','Cookie');
}

// --- Build info endpoint (маячок версии и подключение env, без секретов) ---
router.get(['/auth/_build','/api/auth/_build'], (req, res) => {
  noStore(res);
  res.json({
    router: 'v9',
    uses: {
      TELEGRAM_BOT_TOKEN: !!(process.env.TELEGRAM_BOT_TOKEN),
      TG_BOT_TOKEN: !!(process.env.TG_BOT_TOKEN),
      FRONT_ORIGIN: !!(process.env.FRONT_ORIGIN),
      FRONTEND_URL: !!(process.env.FRONTEND_URL),
      FRONT_URL: !!(process.env.FRONT_URL),
      VK_REDIRECT_URI: process.env.VK_REDIRECT_URI || null,
      BACKEND_BASE: (process.env.BACKEND_BASE || process.env.PUBLIC_BACKEND_URL || null),
      VK_USE_CLIENT_SECRET: (process.env.VK_USE_CLIENT_SECRET === '1' || process.env.VK_TOKEN_AUTH === 'secret')
    }
  });
});

// --- Env compatibility ---
const FRONT = process.env.FRONT_ORIGIN || process.env.FRONTEND_URL || process.env.FRONT_URL || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
const USE_VK_SECRET = (process.env.VK_USE_CLIENT_SECRET === '1' || process.env.VK_TOKEN_AUTH === 'secret');

const BACKEND_BASE =
  process.env.BACKEND_BASE ||
  process.env.PUBLIC_BACKEND_URL ||
  (process.env.VK_REDIRECT_URI ? new URL(process.env.VK_REDIRECT_URI).origin : '');

// --- helpers ---
function redirectAfterLogin(res){
  const to = process.env.AFTER_LOGIN_URL || (FRONT ? FRONT + '/lobby.html' : '/health');
  res.redirect(to);
}
function base64url(buf){
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function genCodeVerifier(){ return base64url(crypto.randomBytes(64)); }
function codeChallengeFrom(verifier){ return base64url(crypto.createHash('sha256').update(verifier).digest()); }
function pkceCookieOpts(){ return { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge: 10 * 60 * 1000 }; }

// --- session/me ---
router.get(['/api/me','/me'], async (req, res) => {
  noStore(res);
  const sess = readSession(req);
  if (!sess?.uid) return res.json({ ok:true, user: null });
  const u = await db.get('SELECT * FROM users WHERE id=?', [sess.uid]);
  res.json({ ok:true, user: u || null });
});
router.post(['/api/logout','/logout'], (req, res) => {
  noStore(res);
  clearSession(res);
  res.json({ ok:true });
});

// --- VK OAuth (PKCE) ---
router.get(['/auth/vk/start','/api/auth/vk/start'], (req, res) => {
  const client_id = process.env.VK_CLIENT_ID;
  if (!client_id) return res.status(500).send('VK_CLIENT_ID is not set');
  const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');
  const state = encodeURIComponent(req.query.returnTo || '');
  const code_verifier = genCodeVerifier();
  const code_challenge = codeChallengeFrom(code_verifier);
  res.cookie('pkce_v', code_verifier, pkceCookieOpts());
  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'email');
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

async function vkTokenExchangeIdHost({ code, client_id, redirect_uri, code_verifier, withSecret }){
  const body = new URLSearchParams({
    grant_type: 'authorization_code', client_id, redirect_uri, code, code_verifier
  });
  if (withSecret && process.env.VK_CLIENT_SECRET) body.set('client_secret', process.env.VK_CLIENT_SECRET);
  const resp = await fetch('https://id.vk.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { host:'id.vk.com', ok: resp.ok, status: resp.status, text, json };
}

async function vkTokenExchangeLegacyHost({ code, client_id, redirect_uri, withSecret }){
  // Legacy OAuth host; PKCE не поддерживает, code_verifier не передаём
  const body = new URLSearchParams({
    client_id, redirect_uri, code
  });
  if (withSecret && process.env.VK_CLIENT_SECRET) body.set('client_secret', process.env.VK_CLIENT_SECRET);
  const resp = await fetch('https://oauth.vk.com/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { host:'oauth.vk.com', ok: resp.ok, status: resp.status, text, json };
}

router.get(['/auth/vk/callback','/api/auth/vk/callback'], async (req, res) => {
  try {
    noStore(res);
    const code = req.query.code?.toString();
    if (!code) return res.status(400).send('missing code');
    const client_id = process.env.VK_CLIENT_ID;
    const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');
    const code_verifier = req.cookies?.pkce_v;
    if (!client_id) return res.status(500).send('VK_CLIENT_ID not set');
    if (!code_verifier) return res.status(400).send('missing pkce verifier');

    // 1) New host, chosen mode
    const a1 = await vkTokenExchangeIdHost({ code, client_id, redirect_uri, code_verifier, withSecret: USE_VK_SECRET });
    // 2) New host, toggled mode
    const a2 = a1.ok ? null :
      await vkTokenExchangeIdHost({ code, client_id, redirect_uri, code_verifier, withSecret: !USE_VK_SECRET });
    // 3) Legacy host, with secret if есть
    const a3 = (a1.ok || (a2 && a2.ok)) ? null :
      await vkTokenExchangeLegacyHost({ code, client_id, redirect_uri, withSecret: true });

    const success = a1.ok ? a1 : (a2 && a2.ok ? a2 : (a3 && a3.ok ? a3 : null));
    const last = success || a3 || a2 || a1;

    if (!success) {
      const info = {
        attempts: [
          { host: a1.host, used_secret: USE_VK_SECRET, status: a1.status, body: a1.text?.slice(0,400) },
          a2 ? { host: a2.host, used_secret: !USE_VK_SECRET, status: a2.status, body: a2.text?.slice(0,400) } : null,
          a3 ? { host: a3.host, used_secret: true, status: a3.status, body: a3.text?.slice(0,400) } : null,
        ].filter(Boolean)
      };
      return res.status(502).send('vk token error: ' + JSON.stringify(info));
    }

    const token = success.json || {};
    let avatar = '', firstName = '', lastName = '';
    try {
      const apiV = process.env.VK_API_VERSION || '5.199';
      const infoResp = await fetch(`https://api.vk.com/method/users.get?v=${apiV}&fields=photo_200`, {
        headers: { 'Authorization': `Bearer ${token.access_token}` }
      });
      const info = await infoResp.json();
      if (info?.response?.[0]) { const p = info.response[0]; firstName = p.first_name || ''; lastName = p.last_name || ''; avatar = p.photo_200 || ''; }
    } catch {}

    const vk_id = token.user_id?.toString() || token.user?.id?.toString();
    if (!vk_id) return res.status(502).send('vk: cannot resolve user id');
    const user = await upsertVK(vk_id, { firstName, lastName, avatar });
    const jwt = signSession({ uid: user.id });
    res.cookie(COOKIE_NAME, jwt, cookieOpts());
    res.clearCookie('pkce_v', pkceCookieOpts());
    redirectAfterLogin(res);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('vk callback error');
  }
});

// --- Debug endpoint for VK config ---
router.get(['/auth/vk/debug','/api/auth/vk/debug'], (req, res) => {
  noStore(res);
  res.json({
    client_id_present: !!process.env.VK_CLIENT_ID,
    has_secret: !!process.env.VK_CLIENT_SECRET,
    use_secret_mode: USE_VK_SECRET,
    redirect_uri: (process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback')),
    pkce_cookie_present: !!req.cookies?.pkce_v
  });
});

// --- Telegram Login Widget ---
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
  const data = parseRawQuery(req); // сырые значения из querystring
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
    noStore(res);
    const botToken = TG_TOKEN;
    if (!botToken) return res.status(500).send('TELEGRAM_BOT_TOKEN not set');
    if (!verifyTelegramAuth(req, botToken)) return res.status(401).send('tg verify fail');

    const q = parseRawQuery(req);
    const tg_id = q.id?.toString();
    const firstName = q.first_name || '';
    const lastName = q.last_name || '';
    const avatar = q.photo_url || '';
    const user = await upsertTG(tg_id, { firstName, lastName, avatar });

    const jwt = signSession({ uid: user.id });
    res.cookie(COOKIE_NAME, jwt, cookieOpts());
    redirectAfterLogin(res);
  } catch (e) {
    console.error('[TG callback] error', e);
    res.status(500).send('tg callback error');
  }
});

export default router;
