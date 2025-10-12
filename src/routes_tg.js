// src/routes_tg.js — TG callback + proof-merge (HUM) + гарантированный актёр (user_id TG) + корректный лог
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
function getSessionUid(req){
  const token = (req.cookies?.sid || '').toString();
  if (!token) return null;
  try{
    const data = jwt.verify(token, process.env.JWT_SECRET);
    if (data && data.uid) return Number(data.uid);
  }catch(_){}
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

// текущий актёр для tg_id (если уже привязан)
async function getActorUidForTg(tgId){
  if (!tgId) return null;
  try{
    const r = await db.query(
      "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 limit 1",
      [tgId]
    );
    return (r.rows.length && r.rows[0].user_id) ? Number(r.rows[0].user_id) : null;
  }catch(_){ return null; }
}

/**
 * ensureActorForTg(tgId, profile)
 * Гарантирует, что у данного tgId есть свой users.id (актёр) и он проставлен в auth_accounts.user_id.
 * 1) Если в auth_accounts уже стоит user_id — возвращаем его.
 * 2) Иначе ищем users.vk_id='tg:<tgId>'; если нет, создаём.
 * 3) Проставляем auth_accounts.user_id там, где он NULL (не перевешиваем чужое!).
 * Возвращаем актёра (users.id) или null.
 */
async function ensureActorForTg(tgId, profile = {}){
  if (!tgId) return null;

  // уже привязан?
  const existing = await getActorUidForTg(tgId);
  if (existing) return existing;

  const tgVkId = 'tg:' + tgId;

  // ищем/создаём TG-пользователя
  let userId = null;
  try {
    const r0 = await db.query("select id from users where vk_id=$1 limit 1", [tgVkId]);
    if (r0.rows.length) userId = Number(r0.rows[0].id);
  } catch {}

  if (!userId) {
    const fn = safe(profile.first_name) || '';
    const ln = safe(profile.last_name)  || '';
    const av = safe(profile.photo_url)  || '';
    try {
      const ins = await db.query(
        "insert into users (vk_id, first_name, last_name, avatar) values ($1,$2,$3,$4) returning id",
        [tgVkId, fn, ln, av]
      );
      userId = Number(ins.rows[0].id);
      try {
        await logEvent({ user_id: userId, event_type:'user_create', payload:{ provider:'tg', tg_id: tgId }, ip:null, ua:null });
      } catch {}
    } catch (e) {
      console.error('ensureActorForTg: user insert failed', e?.message);
    }
  }

  // проставляем user_id там, где он NULL (не перевешиваем чужое)
  try {
    await db.query(
      "update auth_accounts set user_id=$2, updated_at=now() where provider='tg' and provider_user_id=$1 and user_id is null",
      [tgId, userId || null]
    );
  } catch (e) {
    console.warn('ensureActorForTg: bind auth_accounts failed', e?.message);
  }

  // итоговый актёр
  const final = await getActorUidForTg(tgId);
  return final || userId || null;
}

router.all('/callback', async (req, res) => {
  try { await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'tg' }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) }); } catch {}

  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = getDeviceId(req);
    const tgId = safe(data.id || '');
    const mode = safe(data.mode || 'login'); // 'login' | 'link'

    const primaryUid = getSessionUid(req) || null;

    // upsert auth_account (user_id не трогаем здесь)
    if (tgId) {
      try{
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
          values (null, 'tg', $1, $2, null, $3)
          on conflict (provider, provider_user_id) do update set
            username  = coalesce(excluded.username,  auth_accounts.username),
            meta      = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [
          tgId,
          safe(data.username),
          JSON.stringify({ device_id: deviceId || null })
        ]);
      }catch(e){
        console.warn('tg upsert failed', e?.message);
      }
    }

    // Гарантируем актёра (создаём TG-user при необходимости и ставим user_id в auth_accounts, если он был NULL)
    const actorUidFinal = await ensureActorForTg(tgId, data);

    // === PROOF LINK (HUM) — склейка TG-пользователя в HUM primary (без перевешивания учёток) ===
    if (mode === 'link' && tgId && primaryUid && actorUidFinal && actorUidFinal !== primaryUid) {
      let masterHum = primaryUid;
      try{
        const r = await db.query("select coalesce(hum_id,id) as hum_id from users where id=$1", [primaryUid]);
        if (r.rows.length) masterHum = Number(r.rows[0].hum_id);
      }catch(_){}

      try {
        await db.query("update users set hum_id=$1 where id=$2 and (hum_id is null or hum_id<>$1)", [masterHum, actorUidFinal]);
      } catch (e) {
        console.warn('tg link: set hum_id failed', e?.message);
      }
      try {
        await logEvent({
          user_id: primaryUid,
          event_type: 'merge_proof',
          payload: { provider:'tg', tg_id: tgId || null, from_user_id: actorUidFinal, to_hum_id: masterHum, method:'proof' },
          ip:firstIp(req),
          ua:(req.headers['user-agent']||'').slice(0,256)
        });
      } catch {}
    }

    // Ставим сессию — ПРИОРИТЕТ актёру TG (чтобы /api/me и события отражали провайдера входа)
    try {
      const uidForSession = actorUidFinal || primaryUid || null;
      if (uidForSession) {
        const user = await getUserById(uidForSession);
        if (user) {
          const jwtStr = signSession({ uid: user.id });
          res.cookie('sid', jwtStr, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000 });
        }
      }
    } catch {}

    // Автомерж по device_id — мягкая склейка (если используете)
    try { if (deviceId) await autoMergeByDevice({ deviceId, tgId }); } catch {}

    // Редирект в лобби
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider','tg');
    if (tgId) url.searchParams.set('id', tgId);
    if (data.first_name) url.searchParams.set('first_name', safe(data.first_name));
    if (data.last_name)  url.searchParams.set('last_name',  safe(data.last_name));
    if (data.username)   url.searchParams.set('username',   safe(data.username));
    if (data.photo_url)  url.searchParams.set('photo_url',  safe(data.photo_url));

    // ЛОГ: auth_success — строго от лица TG-актёра
    try {
      await logEvent({
        user_id: actorUidFinal || null,
        event_type: (mode === 'link' ? 'link_success' : 'auth_success'),
        payload:{ provider:'tg', pid: tgId || null, mode, actor_user_id: actorUidFinal, primary_uid: primaryUid },
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
