// src/routes_tg.js — complete TG callback + device session + auto-merge + proof-link
import { Router } from 'express';
import { db, getUserById, logEvent } from './db.js';
import { signSession } from './jwt.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}
function safe(s){ return (s==null ? null : String(s)); }

function decodeUidFromSid(req) {
  try {
    const token = req.cookies?.sid;
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch {
    return null;
  }
}
function readLinkState(req) {
  const raw = req.cookies?.link_state;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); } catch { return null; }
  }
}

router.all('/callback', async (req, res) => {
  try { await logEvent({ user_id:null, event_type:'auth_start', payload:{ provider:'tg' }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) }); } catch {}
  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = safe(req.query?.device_id || req.cookies?.device_id || '');
    const tgId = safe(data.id || '');

    // PROOF LINK MODE (до обычного поведения)
    try {
      const link = readLinkState(req);
      if (link && link.target === 'tg' && tgId) {
        const humId = decodeUidFromSid(req);
        if (!humId) {
          await logEvent({ user_id:null, event_type:'link_error',
            payload:{ provider:'tg', reason:'no_session' }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });
          res.clearCookie('link_state', { path:'/' });
          return res.redirect((link.return || '/lobby.html') + '?link=error');
        }
        const chk = await db.query(
          "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 and user_id is not null limit 1",
          [tgId]
        );
        if (chk.rows?.length && Number(chk.rows[0].user_id) !== Number(humId)) {
          await logEvent({ user_id:humId, event_type:'link_conflict',
            payload:{ provider:'tg', pid: tgId, other: chk.rows[0].user_id }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });
          res.clearCookie('link_state', { path:'/' });
          return res.redirect((link.return || '/lobby.html') + '?link=conflict');
        }
        await db.query(
          `insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
           values ($1,'tg',$2, $3, null, jsonb_build_object('linked',true))
           on conflict (provider, provider_user_id)
           do update set user_id=excluded.user_id, username=coalesce(excluded.username,auth_accounts.username), updated_at=now()`,
          [humId, tgId, safe(data.username)]
        );
        await logEvent({ user_id:humId, event_type:'link_success',
          payload:{ provider:'tg', pid: tgId }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });
        res.clearCookie('link_state', { path:'/' });
        return res.redirect((link.return || '/lobby.html') + '?linked=tg');
      }
    } catch (e) {
      try { await logEvent({ event_type:'link_error', payload:{ provider:'tg', error:String(e?.message||e) }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) }); } catch {}
    }

    // set session to primary user by deviceId (если известен)
    if (deviceId) {
      try {
        const r = await db.query(
          "select user_id from auth_accounts where (meta->>'device_id') = $1 and user_id is not null order by updated_at desc limit 1",
          [deviceId]
        );
        if (r.rows.length) {
          const user = await getUserById(r.rows[0].user_id);
          if (user) {
            const jwt = signSession({ uid: user.id });
            res.cookie('sid', jwt, {
              httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge:30*24*3600*1000
            });
          }
        }
      } catch {}
    }

    // upsert tg auth_account, remember device_id
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
      }catch(e){ console.warn('tg upsert failed', e?.message); }
    }

    // fire-and-forget auto-merge
    try { if (deviceId) await autoMergeByDevice({ deviceId, tgId }); } catch {}

    // redirect to frontend lobby with tg hints
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider','tg');
    if (tgId) url.searchParams.set('id', tgId);
    if (data.first_name) url.searchParams.set('first_name', safe(data.first_name));
    if (data.last_name) url.searchParams.set('last_name', safe(data.last_name));
    if (data.username) url.searchParams.set('username', safe(data.username));
    if (data.photo_url) url.searchParams.set('photo_url', safe(data.photo_url));
    
    try {
      let uidToLog = null;
      if (tgId) {
        const rLog = await db.query(
          "select user_id from auth_accounts where provider='tg' and provider_user_id=$1 order by updated_at desc limit 1",
          [tgId]
        );
        uidToLog = (rLog.rows && rLog.rows[0] && rLog.rows[0].user_id) ? rLog.rows[0].user_id : null;
      }
      await logEvent({ user_id: uidToLog, event_type:'auth_success', payload:{ provider:'tg', tg_id: tgId || null }, ip:firstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });
    } catch {}

    res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error', e);
    res.redirect(302, (process.env.FRONTEND_URL || '') + '/lobby.html?provider=tg');
  }
});

export default router;
