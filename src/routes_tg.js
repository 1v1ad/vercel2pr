// src/routes_tg.js — TG callback + proof-merge (HUM) + корректный лог актёра
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

// helper: получить user_id, к которому сейчас привязан данный TG
async function getActorUidForTg(tgId){
  if (!tgId) return null;
  try{
    const r = await db.query("select user_id from auth_accounts where provider='tg' and provider_user_id=$1 limit 1", [tgId]);
    return (r.rows.length && r.rows[0].user_id) ? Number(r.rows[0].user_id) : null;
  }catch(_){ return null; }
}

router.all('/callback', async (req, res) => {
  try { await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'tg' }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) }); } catch {}

  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = getDeviceId(req);
    const tgId = safe(data.id || '');
    const mode = safe(data.mode || 'login'); // 'login' | 'link'

    // кто сейчас залогинен (primary-кластер)
    let primaryUid = getSessionUid(req) || null;

    // актёр = тот user_id, за которым уже закреплён TG
    let actorUid = await getActorUidForTg(tgId);

    // --- PROOF LINK по HUM (без перевешивания auth_accounts) ---
    if (mode === 'link' && tgId && primaryUid) {
      // HUM-ид мастера = hum_id(primary) или сам primary
      let masterHum = primaryUid;
      try{
        const r = await db.query("select coalesce(hum_id,id) as hum_id from users where id=$1", [primaryUid]);
        if (r.rows.length) masterHum = Number(r.rows[0].hum_id);
      }catch(_){}

      // если TG-аккаунт привязан к другому user_id — склеиваем его в HUM-кластер мастера
      if (actorUid && actorUid !== masterHum) {
        try {
          await db.query("update users set hum_id=$1 where id=$2 and (hum_id is null or hum_id<>$1)", [masterHum, actorUid]);
        } catch (e) {
          console.warn('tg link: set hum_id failed', e?.message);
        }

        // лог merge_proof
        try {
          await logEvent({
            user_id: primaryUid,
            event_type: 'merge_proof',
            payload: { provider:'tg', tg_id: tgId || null, from_user_id: actorUid, to_hum_id: masterHum, method:'proof' },
            ip:firstIp(req),
            ua:(req.headers['user-agent']||'').slice(0,256)
          });
        } catch {}
      }
    }

    // upsert TG auth_account: НЕ трогаем user_id (чтобы актёр сохранялся как есть)
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

    // после upsert обязательно перечитываем актёра
    let actorUidFinal = null;
    try { actorUidFinal = await getActorUidForTg(tgId); } catch {}

    // ставим сессию: ПРИОРИТЕТ актёру TG (чтобы события/ME отражали провайдера входа)
    try {
      let uidForSession = actorUidFinal || actorUid || primaryUid || null;
      if (uidForSession) {
        const user = await getUserById(uidForSession);
        if (user) {
          const jwtStr = signSession({ uid: user.id });
          res.cookie('sid', jwtStr, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000 });
        }
      }
    } catch {}

    // автомерж по device_id — можно оставить (работает через HUM)
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

    // ЛОГИ: auth_success — от лица актёра (user_id = реальный TG-user)
    try {
      await logEvent({
        user_id: (actorUidFinal ?? actorUid ?? primaryUid ?? null),
        event_type: (mode === 'link' ? 'link_success' : 'auth_success'),
        payload:{ provider:'tg', tg_id: tgId || null, mode, actor_user_id: actorUidFinal ?? actorUid, primary_uid: primaryUid },
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
