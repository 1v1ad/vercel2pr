// src/routes_auth.js — VK-авторизация + proof-link по HUM (без перевешивания уже привязанного VK)
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent, db, updateUserCountryIfNull } from './db.js';
import { getDeviceId, upsertAuthAccount, linkPendingsToUser } from './linking.js';

const router = express.Router();

function envVK() {
  const e = process.env;
  const clientId     = e.VK_CLIENT_ID;
  const clientSecret = e.VK_CLIENT_SECRET;
  const redirectUri  = e.VK_REDIRECT_URI || e.REDIRECT_URI || `${e.API_BASE || ''}/api/auth/vk/cb`;
  const frontendUrl  = e.FRONTEND_URL  || e.CLIENT_URL || 'https://sweet-twilight-63a9b6.netlify.app';
  for (const [k,v] of Object.entries({ VK_CLIENT_ID:clientId, VK_CLIENT_SECRET:clientSecret, VK_REDIRECT_URI:redirectUri })) {
    if (!v) throw new Error(`env ${k} is required`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function firstIp(req) {
  const h = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return h.split(',')[0].trim();
}
function userAgent(req) { return (req.headers['user-agent'] || '').slice(0,256); }

// GeoIP по IP: ipwho.is, заполняем users.country_code / country_name (только если ещё не заполнено)
async function geoipCountryFromReq(req){
  const ip = firstIp(req);
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  try{
    const url = 'https://ipwho.is/' + encodeURIComponent(ip) + '?fields=success,country,country_code';
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.success === false || !j.country_code) return null;
    return {
      code: String(j.country_code).toUpperCase(),
      name: j.country || null
    };
  }catch(e){
    console.warn('vk geoip lookup failed', e?.message || e);
    return null;
  }
}

async function ensureCountryFromIp(userId, req){
  if (!userId) return;
  const geo = await geoipCountryFromReq(req);
  if (!geo) return;
  try{
    await updateUserCountryIfNull(userId, {
      country_code: geo.code,
      country_name: geo.name
    });
  }catch(e){
    console.warn('vk ensureCountryFromIp failed', e?.message || e);
  }
}

// sid -> uid (как в server.js)
function decodeUidFromSid(req) {
  try {
    const token = req.cookies?.sid;
    if (!token) return null;
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    if (!payload || typeof payload.uid !== 'number') return null;
    return payload.uid;
  } catch {
    return null;
  }
}

// ===== LINK TOKENS =====

async function insertLinkToken({ user_id, target, return_url }) {
  const token = crypto.randomBytes(16).toString('hex');
  const res = await db.query(
    `insert into link_tokens(token, user_id, target, created_at, expires_at, return_url)
     values ($1,$2,$3,now(),now() + interval '10 minutes',$4)
     returning token`,
    [token, user_id, target, return_url || null]
  );
  return res.rows[0]?.token || null;
}

async function getLinkTokenRow(token, target) {
  if (!token || !target) return null;
  try {
    const r = await db.query(
      `select token, user_id, target, return_url
         from link_tokens
        where token = $1 and target = $2 and now() < expires_at and not coalesce(done,false)
        limit 1`,
      [String(token), String(target)]
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function markLinkTokenDone(token) {
  if (!token) return;
  try {
    await db.query(`update link_tokens set done=true where token=$1`, [token]);
  } catch {}
}

// ===== VK START =====

router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = envVK();

    // ⬇️ НОВЫЙ БЛОК
    const deviceIdFromQuery = (req.query.device_id || '').toString().trim();
    if (deviceIdFromQuery) {
      res.cookie('device_id', deviceIdFromQuery, {
        httpOnly: true,          // JS его не читает, он нужен только бэку
        sameSite: 'lax',
        secure: true,            // на onrender всё по https
        path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000
      });
    }

    // режим привязки — кладём cookie link_state (не требуем state от фронта)
    if (req.query.mode === 'link') {
      const st = {
        target: 'vk',
        nonce: crypto.randomBytes(8).toString('hex'),
        ts: Date.now(),
      };
      const payload = Buffer.from(JSON.stringify(st)).toString('base64url');
      res.cookie('link_state', payload, {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: 10 * 60 * 1000,
      });
    }

    const verifier = createCodeVerifier();
    req.session = req.session || {};
    req.session.vk_code_verifier = verifier;

    const challenge = await createCodeChallenge(verifier);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'vk_oauth'
    });

    const vkAuthUrl = `https://oauth.vk.com/authorize?${params.toString()}`;

    try {
      await logEvent({
        user_id: null,
        event_type: 'auth_start',
        payload: { provider: 'vk' },
        ip: firstIp(req),
        ua: userAgent(req)
      });
    } catch {}

    res.redirect(vkAuthUrl);
  } catch (e) {
    console.error('VK start error:', e);
    res.status(500).send('VK auth init error');
  }
});

// ===== VK CALLBACK =====

router.get('/vk/cb', async (req, res) => {
  const { code, state } = req.query;
  const { clientId, clientSecret, redirectUri, frontendUrl } = envVK();

  if (!code || state !== 'vk_oauth') {
    return res.status(400).send('Invalid VK auth callback');
  }

  try {
    const verifier = req.session?.vk_code_verifier;
    if (!verifier) {
      return res.status(400).send('Missing PKCE verifier');
    }

    const tokenResponse = await axios.post(
      'https://oauth.vk.com/access_token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code: code.toString(),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { user_id: vkUserId, access_token } = tokenResponse.data || {};
    if (!vkUserId || !access_token) {
      return res.status(400).send('Invalid VK token response');
    }

    const userInfoResponse = await axios.get(
      'https://api.vk.com/method/users.get',
      {
        params: {
          user_ids: vkUserId,
          fields: 'photo_100,first_name,last_name',
          access_token,
          v: '5.131'
        }
      }
    );

    const vkUser = (userInfoResponse.data && userInfoResponse.data.response && userInfoResponse.data.response[0]) || null;
    if (!vkUser) {
      return res.status(400).send('Failed to fetch VK user');
    }

    const vk_id = String(vkUser.id);
    const first_name = vkUser.first_name || '';
    const last_name  = vkUser.last_name || '';
    const avatar     = vkUser.photo_100 || '';

    const deviceId = getDeviceId(req);

    let linkAttempt = false;
    let linkTokenRow = null;

    const linkCookie = (req.cookies?.link_state || '').toString();
    if (linkCookie) {
      try {
        const decoded = Buffer.from(linkCookie, 'base64url').toString('utf8');
        const st = JSON.parse(decoded);
        if (st && st.target === 'vk' && typeof st.nonce === 'string') {
          linkAttempt = true;
          linkTokenRow = await getLinkTokenRow(st.nonce, 'vk');
        }
      } catch {}
    }

    if (linkAttempt && linkTokenRow && linkTokenRow.user_id) {
      const primaryUserId = Number(linkTokenRow.user_id);
      try {
        const { rows } = await db.query(
          'select id, hum_id from users where id = $1 limit 1',
          [primaryUserId]
        );
        if (!rows.length) {
          throw new Error('primary_user_not_found');
        }

        const primary = rows[0];
        const humId = primary.hum_id || primary.id;

        try {
          await db.query(
            `insert into auth_accounts (provider, provider_user_id, user_id, meta)
             values ($1,$2,$3,$4)
             on conflict (provider, provider_user_id) do update set
               user_id = excluded.user_id,
               meta    = coalesce(auth_accounts.meta, '{}'::jsonb) || excluded.meta`,
            ['vk', vk_id, primary.id, { device_id: deviceId || null }]
          );
        } catch (e) {
          await logEvent({
            user_id: primary.id,
            event_type: 'link_error',
            payload: { provider: 'vk', vk_id, error: e?.message || String(e) },
            ip: firstIp(req),
            ua: userAgent(req)
          });
          throw e;
        }

        try {
          await logEvent({
            user_id: humId,
            event_type: 'link_success',
            payload: { provider: 'vk', vk_id, device_id: deviceId || null },
            ip: firstIp(req),
            ua: userAgent(req)
          });
        } catch {}

        try {
          const jwtStr = signSession({ uid: primary.id });
          res.cookie('sid', jwtStr, {
            httpOnly: true,
            sameSite: 'none',
            secure: true,
            path: '/',
            maxAge: 30 * 24 * 3600 * 1000
          });
        } catch (e) {
          console.warn('sid cookie set failed', e?.message || e);
        }

        try {
          await linkPendingsToUser(primary.id, deviceId || null);
        } catch (e) {
          console.warn('linkPendingsToUser failed', e?.message || e);
        }

        try {
          res.clearCookie('link_state', { httpOnly:true, sameSite:'lax', secure:true, path:'/' });
          if (linkTokenRow) await markLinkTokenDone(linkTokenRow.token);
        } catch {}

        const returnUrl = linkTokenRow.return_url || `${frontendUrl}/lobby.html`;
        return res.redirect(returnUrl + '?linked=vk');
      } catch (e) {
        if (linkAttempt) {
          try {
            await logEvent({
              event_type: 'link_error',
              payload: { provider: 'vk', vk_id, error: e?.message || String(e) },
              ip: firstIp(req),
              ua: userAgent(req)
            });
          } catch {}
        }
      }
    }

    const uidFromSid = decodeUidFromSid(req);
    if (uidFromSid && linkAttempt && linkTokenRow && linkTokenRow.user_id && uidFromSid === linkTokenRow.user_id) {
      try {
        const { rows } = await db.query(
          'select id, hum_id from users where id = $1 limit 1',
          [uidFromSid]
        );
        if (rows.length) {
          const primary = rows[0];
          const humId = primary.hum_id || primary.id;

          try {
            await db.query(
              `insert into auth_accounts (provider, provider_user_id, user_id, meta)
               values ($1,$2,$3,$4)
               on conflict (provider, provider_user_id) do update set
                 user_id = excluded.user_id,
                 meta    = coalesce(auth_accounts.meta, '{}'::jsonb) || excluded.meta`,
              ['vk', vk_id, primary.id, { device_id: deviceId || null }]
            );
          } catch (e) {
            await logEvent({
              user_id: primary.id,
              event_type: 'link_error',
              payload: { provider: 'vk', vk_id, error: e?.message || String(e) },
              ip: firstIp(req),
              ua: userAgent(req)
            });
            throw e;
          }

          try {
            await logEvent({
              user_id: humId,
              event_type: 'link_success',
              payload: { provider: 'vk', vk_id, device_id: deviceId || null },
              ip: firstIp(req),
              ua: userAgent(req)
            });
          } catch {}

          try {
            await linkPendingsToUser(primary.id, deviceId || null);
          } catch (e) {
            console.warn('linkPendingsToUser failed', e?.message || e);
          }

          try {
            res.clearCookie('link_state', { httpOnly:true, sameSite:'lax', secure:true, path:'/' });
            const token = linkTokenRow?.token;
            if (token) await markLinkTokenDone(token);
          } catch {}

          const returnUrl = linkTokenRow.return_url || `${frontendUrl}/lobby.html`;
          return res.redirect(returnUrl + '?linked=vk');
        }
      } catch (e) {
        if (linkAttempt) {
          try {
            await logEvent({
              event_type: 'link_error',
              payload: { provider: 'vk', vk_id, error: e?.message || String(e) },
              ip: firstIp(req),
              ua: userAgent(req)
            });
          } catch {}
        }
      }
    }

    const user = await upsertUser({ vk_id, first_name, last_name, avatar });
    // 7) GeoIP: пробуем определить страну по IP (только если ещё не заполнена)
    try {
      await ensureCountryFromIp(user.id, req);
    } catch (_) {}

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { provider: 'vk', vk_id },
      ip: firstIp(req),
      ua: userAgent(req)
    });

    try {
      await upsertAuthAccount({
        provider: 'vk',
        provider_user_id: vk_id,
        user_id: user.id,
        meta: { device_id: deviceId || null }
      });
    } catch (e) {
      console.warn('upsertAuthAccount vk failed', e?.message || e);
    }

    try {
      await linkPendingsToUser(user.id, deviceId || null);
    } catch (e) {
      console.warn('linkPendingsToUser failed', e?.message || e);
    }

    const jwtStr = signSession({ uid: user.id });
    res.cookie('sid', jwtStr, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.redirect(`${frontendUrl}/lobby.html`);
  } catch (e) {
    console.error('VK callback error:', e);
    res.status(500).send('VK auth callback error');
  }
});

export default router;
