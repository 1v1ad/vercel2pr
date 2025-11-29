// src/routes_auth.js — VK-авторизация + proof-link по HUM (без перевешивания уже привязанного VK)
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent, db } from './db.js';
import { getDeviceId, upsertAuthAccount, linkPendingsToUser } from './linking.js';

const router = express.Router();

function envVK() {
  const e = process.env;
  const clientId     = e.VK_CLIENT_ID;
  const clientSecret = e.VK_CLIENT_SECRET;
  const redirectUri  = e.VK_REDIRECT_URI || e.REDIRECT_URI || `${e.API_BASE || ''}/api/auth/vk/cb`;
  const frontendUrl  = e.FRONTEND_URL  || e.CLIENT_URL || 'https://sweet-twilight-63a9b6.netlify.app';
  for (const [k,v] of Object.entries({ VK_CLIENT_ID:clientId, VK_CLIENT_SECRET:clientSecret, VK_REDIRECT_URI:redirectUri, FRONTEND_URL:frontendUrl })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function firstIp(req) {
  const h = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return h.split(',')[0].trim();
}
function userAgent(req) { return (req.headers['user-agent'] || '').slice(0,256); }

// sid -> uid (как в server.js)
function decodeUidFromSid(req) {
  try {
    const token = req.cookies?.sid;
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch { return null; }
}

// cookie link_state (JSON или base64url JSON)
function readLinkStateCookie(req) {
  const raw = req.cookies?.link_state;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch {
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
    catch { return null; }
  }
}

// validate link_tokens by state (fallback к БД, безопасно)
async function readLinkTokenFromDB(state, target) {
  try {
    if (!state) return null;
    const r = await db.query(
      `select token, user_id, target, return_url
         from link_tokens
        where token = $1 and target = $2 and now() < expires_at and not coalesce(done,false)
        limit 1`,
      [String(state), String(target)]
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}
async function markLinkTokenDone(token) {
  if (!token) return;
  try { await db.query(`update link_tokens set done=true where token=$1`, [token]); } catch {}
}

// ===== VK START =====
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = envVK();

    // режим привязки — кладём cookie link_state (не требуем state от фронта)
    if (req.query.mode === 'link') {
      const st = {
        target: 'vk',
        nonce: crypto.randomBytes(8).toString('hex'),
        return: req.query.return ? String(req.query.return) : null
      };
      res.cookie('link_state', JSON.stringify(st), { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:15*60*1000 });
    }

    const state         = crypto.randomBytes(16).toString('hex'); // свой state для VK (CSRF)
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    res.cookie('vk_state', state,                 { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:10*60*1000 });
    res.cookie('vk_code_verifier', codeVerifier,  { httpOnly:true, sameSite:'lax', secure:true, path:'/', maxAge:10*60*1000 });

    await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'vk' }, ip:firstIp(req), ua:userAgent(req) });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

// общий обработчик колбэка (для /vk/cb и /vk/callback)
async function vkCallbackHandler(req, res) {
  const { code, state, device_id } = req.query;
  const deviceId = getDeviceId(req); // наш внутренний device_id (cookie/query/header)
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    res.clearCookie('vk_state', { path:'/' });
    res.clearCookie('vk_code_verifier', { path:'/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = envVK();

    // обмен кода на токен (vkid -> fallback oauth)
    let tokenData = null;
    try {
      const resp = await axios.post(
        'https://id.vk.com/oauth2/auth',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          device_id: device_id || ''
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch {
      const resp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
          code_verifier: codeVerifier,
          device_id: device_id || ''
        },
        timeout: 10000
      });
      tokenData = resp.data;
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) return res.status(400).send('Token exchange failed');

    // профиль (не критично, если не вернулся)
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000
      });
      const r = u.data?.response?.[0];
      if (r) { first_name = r.first_name || ''; last_name = r.last_name || ''; avatar = r.photo_200 || ''; }
    } catch {}

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');

    // ===== PROOF LINK MODE (HUM, без перевешивания существующего VK) =====
    let linkAttempt = false;
    try {
      // 1) читаем cookie link_state или запись из link_tokens
      let link = readLinkStateCookie(req);
      let linkTokenRow = null;
      if ((!link || link.target !== 'vk') && req.query?.state) {
        linkTokenRow = await readLinkTokenFromDB(String(req.query.state), 'vk');
        if (linkTokenRow) {
          link = { target:'vk', nonce:String(linkTokenRow.token), return: linkTokenRow.return_url || null };
        }
      }
      if (link || linkTokenRow) linkAttempt = true;

      if (link && link.target === 'vk') {
        // master (кому всё привязываем) — из sid или link_tokens
        let humId = decodeUidFromSid(req);
        if (!humId && linkTokenRow) humId = Number(linkTokenRow.user_id) || null;
        if (!humId) {
          await logEvent({ user_id:null, event_type:'link_error',
            payload:{ provider:'vk', reason:'no_session' }, ip:firstIp(req), ua:userAgent(req) });
          res.clearCookie('link_state', { path:'/' });
          return res.redirect((link.return || `${frontendUrl}/lobby.html`) + '?link=error');
        }

        // актёр: к кому уже привязан этот VK
        let actorUid = null;
        try {
          const r = await db.query("select user_id from auth_accounts where provider='vk' and provider_user_id=$1 limit 1", [vk_id]);
          if (r.rows.length && r.rows[0].user_id) actorUid = Number(r.rows[0].user_id);
        } catch {}

        // masterHum
        let masterHum = humId;
        try {
          const r = await db.query("select coalesce(hum_id,id) as hum_id from users where id=$1", [humId]);
          if (r.rows.length) masterHum = Number(r.rows[0].hum_id);
        } catch {}

        if (actorUid) {
          // VK уже чей-то — склеиваем того пользователя в HUM masterHum
          if (actorUid !== masterHum) {
            try {
              await db.query("update users set hum_id=$1 where id=$2 and (hum_id is null or hum_id<>$1)", [masterHum, actorUid]);
            } catch(e){ console.warn('vk link: set hum_id failed', e?.message); }

            try {
              await logEvent({
                user_id: humId,
                event_type: 'merge_proof',
                payload: { provider:'vk', vk_id, from_user_id: actorUid, to_hum_id: masterHum, method:'proof' },
                ip:firstIp(req), ua:userAgent(req)
              });
            } catch {}
          }

          // мета и отметка о линке (user_id не трогаем!)
          try {
            await db.query(
              `update auth_accounts
                  set meta = jsonb_strip_nulls(coalesce(meta,'{}') || jsonb_build_object('linked_at',now(),'ip',$2,'ua',$3)),
                      updated_at = now()
                where provider='vk' and provider_user_id=$1`,
              [vk_id, firstIp(req), userAgent(req)]
            );
          } catch {}
               } else {
          // VK ещё ни к кому не привязан — первая привязка к master (это ок)
          try {
            await db.query(
              `insert into auth_accounts (user_id, provider, provider_user_id, meta)
               values ($1,'vk',$2, jsonb_build_object(
                 'linked_at', now(),
                 'ip',        $3,
                 'ua',        $4,
                 'device_id', $5
               ))
               on conflict (provider, provider_user_id)
               do update set
                 user_id = coalesce(auth_accounts.user_id, excluded.user_id),
                 meta    = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}') || excluded.meta),
                 updated_at=now()`,
              [humId, vk_id, firstIp(req), userAgent(req), deviceId || null]
            );
          } catch(e){ console.warn('vk link: initial bind failed', e?.message); }
        }


        await logEvent({ user_id:humId, event_type:'link_success',
          payload:{ provider:'vk', pid: vk_id }, ip:firstIp(req), ua:userAgent(req) });

        res.clearCookie('link_state', { path:'/' });
        if (linkTokenRow) await markLinkTokenDone(linkTokenRow.token);

        return res.redirect((link.return || `${frontendUrl}/lobby.html`) + '?linked=vk');
      }
    } catch (e) {
      // логируем ошибку link только если это был ИМЕННО link-поток
      if (linkAttempt) {
        try { await logEvent({ event_type:'link_error', payload:{ provider:'vk', error:String(e?.message||e) }, ip:firstIp(req), ua:userAgent(req) }); } catch {}
      }
      // дальше идём как обычный логин
    }
    // ===== /PROOF LINK MODE =====

    // обычный логин
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await logEvent({ user_id:user.id, event_type:'auth_success', payload:{ provider:'vk', vk_id }, ip:firstIp(req), ua:userAgent(req) });
    // записываем VK-аккаунт в auth_accounts и пытаемся фоном подтянуть висящие учётки по device_id
    try {
      const did = deviceId || null;

      await upsertAuthAccount({
        userId: user.id,
        provider: 'vk',
        providerUserId: vk_id,
        username: null,
        phoneHash: null,
        meta: did ? { device_id: did } : {}
      });

      if (did) {
        try {
          await linkPendingsToUser({
            userId: user.id,
            provider: 'vk',
            deviceId: did,
            phoneHash: null,
            ip: firstIp(req),
            ua: userAgent(req)
          });
        } catch (e) {
          console.warn('vk auth: linkPendingsToUser failed', e?.message || e);
        }
      }
    } catch (e) {
      console.warn('vk auth: upsertAuthAccount failed', e?.message || e);
    }

    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000
    });

    const url = new URL('/lobby.html', envVK().frontendUrl);
    url.searchParams.set('logged','1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
}

router.get('/vk/cb', vkCallbackHandler);
router.get('/vk/callback', vkCallbackHandler); // алиас на случай старых редиректов

export default router;
