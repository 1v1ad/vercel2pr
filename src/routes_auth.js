// src/routes_auth.js
import { Router } from 'express';
import crypto from 'crypto';
import { db, upsertVK, upsertTG } from './db.js';
import { signSession, readSession, clearSession, COOKIE_NAME, cookieOpts } from './jwt.js';

const router = Router();

const FRONT_ORIGIN = process.env.FRONT_ORIGIN || '';
const BACKEND_BASE = process.env.BACKEND_BASE || process.env.PUBLIC_BACKEND_URL || '';

// ---------- Helpers ----------
function redirectAfterLogin(res){
  const to = process.env.AFTER_LOGIN_URL || (FRONT_ORIGIN ? FRONT_ORIGIN + '/lobby.html' : '/health');
  res.redirect(to);
}

// ---------- Session ----------
router.get(['/api/me','/me'], async (req, res) => {
  const sess = readSession(req);
  if (!sess?.uid) return res.json({ ok:true, user: null });
  const u = await db.get('SELECT * FROM users WHERE id=?', [sess.uid]);
  res.json({ ok:true, user: u || null });
});

router.post(['/api/logout','/logout'], (req, res) => {
  clearSession(res);
  res.json({ ok:true });
});

// ---------- VK OAuth (code flow) ----------
// Старт: редиректим на id.vk.com/authorize
router.get(['/auth/vk/start','/api/auth/vk/start'], (req, res) => {
  const client_id = process.env.VK_CLIENT_ID;
  if (!client_id) return res.status(500).send('VK_CLIENT_ID is not set');
  const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');
  const state = encodeURIComponent(req.query.returnTo || '');
  const url = new URL('https://id.vk.com/authorize');
  url.searchParams.set('client_id', client_id);
  url.searchParams.set('redirect_uri', redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'email');
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// Callback: меняем code на токен и достаём профиль
router.get(['/auth/vk/callback','/api/auth/vk/callback'], async (req, res) => {
  try {
    const code = req.query.code?.toString();
    if (!code) return res.status(400).send('missing code');
    const client_id = process.env.VK_CLIENT_ID;
    const client_secret = process.env.VK_CLIENT_SECRET;
    const redirect_uri = process.env.VK_REDIRECT_URI || (BACKEND_BASE + '/api/auth/vk/callback');
    if (!client_id || !client_secret) return res.status(500).send('VK creds not set');

    // VK ID token exchange
    const tokenResp = await fetch('https://id.vk.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        client_secret,
        redirect_uri,
        code
      })
    });
    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return res.status(502).send('vk token error: ' + txt);
    }
    const token = await tokenResp.json();

    // Профиль через старый VK API (при наличии access_token)
    let avatar = '', firstName = '', lastName = '';
    try {
      const apiV = process.env.VK_API_VERSION || '5.199';
      const infoResp = await fetch(`https://api.vk.com/method/users.get?v=${apiV}&fields=photo_200`, {
        headers: { 'Authorization': `Bearer ${token.access_token}` }
      });
      const info = await infoResp.json();
      if (info?.response?.[0]) {
        const p = info.response[0];
        firstName = p.first_name || '';
        lastName  = p.last_name || '';
        avatar    = p.photo_200 || '';
      }
    } catch (e) {}

    const vk_id = token.user_id?.toString() || token.user?.id?.toString();
    if (!vk_id) return res.status(502).send('vk: cannot resolve user id');
    const user = await upsertVK(vk_id, { firstName, lastName, avatar });
    const jwt = signSession({ uid: user.id });
    res.cookie(COOKIE_NAME, jwt, cookieOpts());
    redirectAfterLogin(res);
  } catch (e) {
    console.error('[VK callback] error', e);
    res.status(500).send('vk callback error');
  }
});

// ---------- Telegram Login Widget ----------
function verifyTelegramAuth(data, botToken){
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const checkHash = data.hash;
  const params = Object.entries(data)
    .filter(([k]) => k !== 'hash')
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(params).digest('hex');
  return hmac === checkHash;
}

router.get(['/auth/tg/callback','/api/auth/tg/callback'], async (req, res) => {
  try {
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) return res.status(500).send('TG_BOT_TOKEN not set');
    const data = Object.fromEntries(Object.entries(req.query).map(([k,v]) => [k, Array.isArray(v)?v[0]:v]));
    if (!verifyTelegramAuth(data, botToken)) return res.status(401).send('tg verify fail');

    const tg_id = data.id?.toString();
    const firstName = data.first_name || '';
    const lastName = data.last_name || '';
    const avatar = data.photo_url || '';
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
