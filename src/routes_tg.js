// src/routes_tg.js — TG callback: актёр = users.vk_id = 'tg:<id>' (нативный TG-user),
// HUM-merge по proof, сессию и auth_success пишем от лица TG-актёра.
// auth_accounts.user_id НЕ перевешиваем (только проставляем, если NULL).

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db, getUserById, logEvent } from './db.js';
import { signSession } from './jwt.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

const firstIp = (req) => (String(req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim();
const safe = (s) => (s==null ? null : String(s));
const getDeviceId = (req) => safe(req.query?.device_id || req.cookies?.device_id || '');

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

// --- Актёр TG = native user (users.vk_id = 'tg:<id>') ---
async function getNativeTgUserId(tgId){
  if (!tgId) return null;
  const tgVkId = 'tg:' + tgId;
  try{
    const r = await db.query("select id from users where vk_id=$1 limit 1", [tgVkId]);
    return r.rows.length ? Number(r.rows[0].id) : null;
  }catch{ return null; }
}
async function ensureNativeTgUser(tgId, profile = {}){
  const existing = await getNativeTgUserId(tgId);
  if (existing) return existing;
  const fn = safe(profile.first_name) || '';
  const ln = safe(profile.last_name)  || '';
  const av = safe(profile.photo_url)  || '';
  const tgVkId = 'tg:' + tgId;
  try{
    const ins = await db.query(
      "insert into users (vk_id, first_name, last_name, avatar) values ($1,$2,$3,$4) returning id",
      [tgVkId, fn, ln, av]
    );
    const id = Number(ins.rows[0].id);
    try { await logEvent({ user_id:id, event_type:'user_create', payload:{ provider:'tg', tg_id: tgId }, ip:null, ua:null }); } catch {}
    return id;
  }catch(e){
    console.error('ensureNativeTgUser: insert failed', e?.message);
    return null;
  }
}

// аккуратно (без ребинда) проставим auth_accounts.user_id, если там NULL
async function bindAuthAccountIfNullToUser(tgId, userId){
  if (!tgId || !userId) return;
  try{
    await db.query(
      "update auth_accounts set user_id=$2, updated_at=now() where provider='tg' and provider_user_id=$1 and user_id is null",
      [String(tgId), Number(userId)]
    );
  }catch(e){ console.warn('bindAuthAccountIfNullToUser failed', e?.message); }
}

router.all('/callback', async (req, res) => {
  // лог старта авторизации
  try {
    await logEvent({
      user_id:null, event_type:'auth_start',
      payload:{ provider:'tg' }, ip:firstIp(req),
      ua:(req.headers['user-agent']||'').slice(0,256)
    });
  } catch {}

  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = getDeviceId(req);
    const tgId = safe(data.id || '');
    const mode = safe(data.mode || 'login'); // 'login' | 'link'
    const primaryUid = getSessionUid(req) || null;

    // 1) upsert auth_account (user_id не трогаем тут)
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

    // 2) гарантируем нативного TG-пользователя и считаем его актёром
    const actorUid = await ensureNativeTgUser(tgId, data);

    // 3) если в auth_accounts.user_id пусто — аккуратно привяжем к этому пользователю
    try { await bindAuthAccountIfNullToUser(tgId, actorUid); } catch {}

    // 4) proof-merge: склеиваем актёра в HUM мастера (без перевешивания аккаунтов)
    if (mode === 'link' && tgId && primaryUid && actorUid && actorUid !== primaryUid) {
      let masterHum = primaryUid;
      try{
        const r = await db.query("select coalesce(hum_id,id) as hum_id from users where id=$1", [primaryUid]);
        if (r.rows.length) masterHum = Number(r.rows[0].hum_id);
      }catch{}
      try {
        await db.query("update users set hum_id=$1 where id=$2 and (hum_id is null or hum_id<>$1)",
          [masterHum, actorUid]);
      } catch (e) {
        console.warn('tg link hum set failed', e?.message);
      }
      try {
        await logEvent({
          user_id: primaryUid,
          event_type: 'merge_proof',
          payload: { provider:'tg', tg_id: tgId || null, from_user_id: actorUid, to_hum_id: masterHum, method:'proof' },
          ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256)
        });
      } catch {}
    }

    // 5) Ставим сессию от имени актёра TG — чтобы /api/me и события отражали провайдера входа
    try {
      const uidForSession = actorUid || primaryUid || null;
      if (uidForSession) {
        const user = await getUserById(uidForSession);
        if (user) {
          const jwtStr = signSession({ uid: user.id });
          res.cookie('sid', jwtStr, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000 });
        }
      }
    } catch {}

    // 6) мягкая склейка по устройству (опционально)
    try { if (deviceId) await autoMergeByDevice({ deviceId, tgId }); } catch {}

    // 7) Редирект в лобби
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider','tg');
    if (tgId) url.searchParams.set('id', tgId);
    if (data.first_name) url.searchParams.set('first_name', safe(data.first_name));
    if (data.last_name)  url.searchParams.set('last_name',  safe(data.last_name));
    if (data.username)   url.searchParams.set('username',   safe(data.username));
    if (data.photo_url)  url.searchParams.set('photo_url',  safe(data.photo_url));

    // 8) ЛОГ: auth_success — строго от лица TG-актёра (users.vk_id='tg:<id>')
    try {
      await logEvent({
        user_id: actorUid || null,
        event_type: (mode === 'link' ? 'link_success' : 'auth_success'),
        payload:{ provider:'tg', pid: tgId || null, mode, actor_user_id: actorUid, primary_uid: primaryUid },
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
