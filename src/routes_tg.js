// src/routes_tg.js — TG callback + link-mode + device-session (без verifySession из jwt.js)
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db, getUserById, logEvent } from './db.js';
import { signSession } from './jwt.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}
function safe(s){ return (s==null ? null : String(s)); }
function getDeviceId(req){
  return safe(req.query?.device_id || req.cookies?.device_id || '');
}

// Мягко декодируем uid из cookie sid.
// Сначала пробуем верификацию через jsonwebtoken.verify(JWT_SECRET),
// если не получилось — делаем «best effort» base64url-декод без проверки подписи.
function getSessionUid(req){
  const token = (req.cookies?.sid || '').toString();
  if (!token) return null;

  // 1) Верная проверка
  try{
    const data = jwt.verify(token, process.env.JWT_SECRET);
    if (data && data.uid) return Number(data.uid);
  }catch(_){}

  // 2) Фолбэк: читаем payload без верификации
  try{
    const parts = token.split('.');
    if (parts.length >= 2){
      let payload = parts[1].replace(/-/g,'+').replace(/_/g,'/');
      while (payload.length % 4) payload += '=';
      const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (json && json.uid) return Number(json.uid);
    }
  }catch(_){}

  return null;
}

router.all('/callback', async (req, res) => {
  try {
    await logEvent({
      user_id:null,
      event_type:'auth_start',
      payload:{ provider:'tg' },
      ip:firstIp(req),
      ua:(req.headers['user-agent']||'').slice(0,256)
    });
  } catch {}

  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = getDeviceId(req);
    const tgId = safe(data.id || '');
    const mode = safe(data.mode || 'login'); // 'login' | 'link'

    // Определяем primary пользователя для привязки
    let primaryUid = getSessionUid(req);

    if (!primaryUid && deviceId) {
      try {
        const r = await db.query(
          "select user_id from auth_accounts where (meta->>'device_id') = $1 and user_id is not null order by updated_at desc limit 1",
          [deviceId]
        );
        if (r.rows.length && r.rows[0].user_id) primaryUid = Number(r.rows[0].user_id);
      } catch {}
    }

    // Разрешим явную передачу primary_uid с фронта (последний шанс)
    if (!primaryUid && mode === 'link') {
      const q = Number(safe(data.primary_uid));
      if (Number.isFinite(q) && q > 0) primaryUid = q;
    }

    // upsert TG auth_account; если знаем primaryUid — сразу проставим user_id
    if (tgId) {
      try{
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
          values ($1, 'tg', $2, $3, null, $4)
          on conflict (provider, provider_user_id) do update set
            user_id   = coalesce(auth_accounts.user_id, excluded.user_id),
            username  = coalesce(excluded.username,  auth_accounts.username),
            meta      = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [
          primaryUid || null,
          tgId,
          safe(data.username),
          JSON.stringify({ device_id: deviceId || null })
        ]);
      }catch(e){
        console.warn('tg upsert failed', e?.message);
      }
    }

    // В режиме link дожимаем user_id у TG-аккаунта
    if (mode === 'link' && tgId && primaryUid) {
      try {
        await db.query(
          "update auth_accounts set user_id = $1, updated_at=now() where provider='tg' and provider_user_id=$2 and (user_id is null or user_id=$1)",
          [primaryUid, tgId]
        );
      } catch {}
    }

    // Ставим сессию
    try {
      let uidForSession = primaryUid || null;
      if (!uidForSession && tgId) {
        const r = await db.query(
          "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 order by updated_at desc limit 1",
          [tgId]
        );
        if (r.rows.length && r.rows[0].user_id) uidForSession = Number(r.rows[0].user_id);
      }
      if (uidForSession) {
        const user = await getUserById(uidForSession);
        if (user) {
          const jwtStr = signSession({ uid: user.id });
          res.cookie('sid', jwtStr, {
            httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000
          });
        }
      }
    } catch {}

    // Автомерж по device_id (fire-and-forget)
    try { if (deviceId) await autoMergeByDevice({ deviceId, tgId }); } catch {}

    // Редирект в лобби
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider','tg');
    if (tgId) url.searchParams.set('id', tgId);
    if (data.first_name) url.searchParams.set('first_name', safe(data.first_name));
    if (data.last_name) url.searchParams.set('last_name', safe(data.last_name));
    if (data.username) url.searchParams.set('username', safe(data.username));
    if (data.photo_url) url.searchParams.set('photo_url', safe(data.photo_url));

    // Логируем успех
    try {
      let uidToLog = null;
      if (tgId) {
        const rLog = await db.query(
          "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 order by updated_at desc limit 1",
          [tgId]
        );
        uidToLog = (rLog.rows && rLog.rows[0] && rLog.rows[0].user_id) ? rLog.rows[0].user_id : null;
      }
      await logEvent({
        user_id: uidToLog,
        event_type: (mode === 'link' ? 'link_success' : 'auth_success'),
        payload:{ provider:'tg', tg_id: tgId || null, mode },
        ip:firstIp(req),
        ua:(req.headers['user-agent']||'').slice(0,256)
      });
    } catch {}

    res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error', e);
    res.redirect(302, (process.env.FRONTEND_URL || '') + '/lobby.html?provider=tg');
  }
});

export default router;
