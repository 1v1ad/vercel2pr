// src/routes_auth.js
import express from 'express';
import crypto from 'crypto';
import cookie from 'cookie';
import { upsertUser, logEvent } from './db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

const COOKIE_SID   = 'sid';
const COOKIE_PKCE  = 'vk_pkce';
const COOKIE_STATE = 'vk_state';

function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').split(',')[0];
  return `${proto}://${host}`;
}

function envVK() {
  return {
    clientId:     process.env.VK_CLIENT_ID || process.env.VK_ID || '',
    clientSecret: process.env.VK_CLIENT_SECRET || process.env.VK_SECRET || '',
    redirectUri:  process.env.VK_REDIRECT_URI || '',
    frontendUrl:  process.env.FRONT_URL || process.env.FRONTEND_URL || '/lobby.html',
  };
}

function signSession(payload) {
  const key = process.env.JWT_SECRET || 'dev-secret';
  return jwt.sign(payload, key, { expiresIn: '30d' });
}

/** === PKCE === */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function makePkcePair() {
  const verifier  = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** ===== VK: start (обязательно!) ===== */
router.get(['/api/auth/vk/start','/vk/start'], (req, res) => {
  const { clientId, redirectUri } = envVK();
  if (!clientId) return res.status(500).send('vk: clientId not set');

  const { verifier, challenge } = makePkcePair();
  const state = crypto.randomBytes(16).toString('hex');

  res.setHeader('Set-Cookie', [
    cookie.serialize(COOKIE_PKCE,  verifier, { httpOnly:true, secure:true, sameSite:'none', path:'/', maxAge:600 }),
    cookie.serialize(COOKIE_STATE, state,    { httpOnly:true, secure:true, sameSite:'none', path:'/', maxAge:600 }),
  ]);

  const cb = redirectUri || `${publicBase(req)}/api/auth/vk/callback`;
  const u  = new URL('https://id.vk.com/authorize');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: cb,
    response_type: 'code',
    scope: 'email',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  res.redirect(u.toString());
});

/** ===== VK: callback ===== */
router.get(['/api/auth/vk/callback','/vk/callback'], async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = envVK();
    const code  = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code) return res.status(400).send('vk: code is empty');

    const ck   = cookie.parse(req.headers.cookie || '');
    const ver  = ck[COOKIE_PKCE] || '';
    const st   = ck[COOKIE_STATE] || '';
    if (state && st && state !== st) return res.status(400).send('vk: bad state');

    const cb = redirectUri || `${publicBase(req)}/api/auth/vk/callback`;

    // 1) id.vk.com + PKCE
    let tokenData = null;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: cb,
        code_verifier: ver,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      const resp = await fetch('https://id.vk.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type':'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10000),
      });
      tokenData = await resp.json();
    } catch {}

    // 2) fallback: старый oauth
    if (!tokenData?.access_token) {
      const q = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret || '',
        redirect_uri: cb,
        code,
        v: '5.199',
        grant_type: 'authorization_code',
      });
      try {
        const r2 = await fetch('https://oauth.vk.com/access_token?' + q.toString(), {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        tokenData = await r2.json();
      } catch {}
    }

    const accessToken = tokenData?.access_token || tokenData?.token;
    const vkUserId    = tokenData?.user_id || tokenData?.userId;
    if (!accessToken || !vkUserId) {
      return res
        .status(502)
        .send('vk token error: ' + JSON.stringify({ attempts: [{ host:'id.vk.com', used_secret: !!clientSecret, status: tokenData?.status || 404, body: tokenData?.body || '---' }]}));
    }

    // профиль
    let first_name = '', last_name = '', avatar = '';
    try {
      const prof = new URL('https://api.vk.com/method/users.get');
      prof.search = new URLSearchParams({
        access_token: accessToken,
        v: '5.199',
        fields: 'photo_200,first_name,last_name'
      }).toString();
      const resp = await fetch(prof, { signal: AbortSignal.timeout(10000) });
      const js = await resp.json();
      const r = js?.response?.[0];
      if (r) { first_name = r.first_name || ''; last_name = r.last_name || ''; avatar = r.photo_200 || ''; }
    } catch {}

    const user = await upsertUser({
      provider: 'vk',
      provider_user_id: String(vkUserId),
      name: [first_name, last_name].filter(Boolean).join(' ') || `id${vkUserId}`,
      avatar,
    });

    const sid = signSession({ id: user.id, provider: 'vk', vk_id: vkUserId });
    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_SID, sid, {
      httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 60*60*24*30
    }));

    logEvent(user.id, 'auth_success', { provider: 'vk' }).catch(() => {});
    res.redirect(frontendUrl || '/lobby.html');
  } catch (e) {
    res.status(500).send('vk: ' + (e?.message || 'unknown'));
  }
});

/** ===== TG: callback (Telegram Login Widget) =====
 * Ожидает те же параметры, что присылает Telegram (id, first_name, last_name, photo_url, auth_date, hash).
 * Проверяем hash через BOT_TOKEN. Если токена нет — возвращаем 400 (чтобы в проде не забыть).
 */
router.get(['/api/auth/tg/callback','/tg/callback'], async (req, res) => {
  try {
    const BOT = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
    if (!BOT) return res.status(400).send('tg verify fail: no token');

    const data = { ...req.query };
    const theirHash = String(data.hash || '');
    delete data.hash;

    // формируем checkString
    const entries = Object.entries(data)
      .filter(([,v]) => typeof v !== 'undefined' && v !== '')
      .map(([k,v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    // секрет по правилам Telegram
    const secret = crypto.createHash('sha256').update(BOT).digest();
    const myHash = crypto.createHmac('sha256', secret).update(entries).digest('hex');

    if (myHash !== theirHash) return res.status(401).send('tg verify fail');

    const tid = String(data.id);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
    const avatar = data.photo_url || '';

    const user = await upsertUser({
      provider: 'tg',
      provider_user_id: tid,
      name: name || `tg${tid}`,
      avatar,
    });

    const sid = signSession({ id: user.id, provider: 'tg', tg_id: tid });
    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_SID, sid, {
      httpOnly:true, secure:true, sameSite:'none', path:'/', maxAge:60*60*24*30
    }));

    logEvent(user.id, 'auth_success', { provider: 'tg' }).catch(() => {});
    const to = process.env.FRONT_URL || process.env.FRONTEND_URL || '/lobby.html';
    res.redirect(to);
  } catch (e) {
    res.status(500).send('tg: ' + (e?.message || 'unknown'));
  }
});

/** ===== /api/me ===== */
router.get(['/api/me','/me'], async (req, res) => {
  try {
    const ck = cookie.parse(req.headers.cookie || '');
    const sid = ck[COOKIE_SID];
    if (!sid) return res.json({ ok:true, user:null, provider:null });

    let payload = null;
    try {
      payload = jwt.verify(sid, process.env.JWT_SECRET || 'dev-secret');
    } catch {
      return res.json({ ok:true, user:null, provider:null });
    }

    const user = await (await import('./db.js')).getUserById(payload.id);
    if (!user) return res.json({ ok:true, user:null, provider:null });

    res.json({ ok:true, user, provider: user.provider });
  } catch {
    res.json({ ok:true, user:null, provider:null });
  }
});

export default router;
