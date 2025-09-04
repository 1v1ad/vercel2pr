// src/routes_tg.js — complete TG callback with device session + auto-merge
import { Router } from 'express';
import { db, getUserById } from './db.js';
import { signSession } from './jwt.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

function safe(s){ return (s==null ? null : String(s)); }

router.all('/callback', async (req, res) => {
  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = safe(req.query?.device_id || req.cookies?.device_id || '');
    const tgId = safe(data.id || '');

    // set session to primary user by deviceId (if known)
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
    res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error', e);
    res.redirect(302, (process.env.FRONTEND_URL || '') + '/lobby.html?provider=tg');
  }
});

export default router;
