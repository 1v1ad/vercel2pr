// src/routes_tg.js — TG callback: set VK session by device_id and store meta.device_id
import { Router } from 'express';
import { db, getUserById } from './db.js';
import { signSession } from './jwt.js';

const router = Router();
import { autoMergeByDevice } from './merge.js';

// Telegram widget callback
router.all('/callback', async (req, res) => {
  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = (req.query?.device_id || req.cookies?.device_id || '').toString().trim();

    // 1) If there is a user linked to this device_id -> immediately set session cookie to unify balance
    if (deviceId) {
      try {
        const r = await db.query(
          "select user_id from auth_accounts where (meta->>'device_id') = $1 and user_id is not null order by updated_at desc limit 1",
          [deviceId]
        );
        if (r.rows.length) {
          const uid = r.rows[0].user_id;
          const user = await getUserById(uid);
          if (user) {
            const jwt = signSession({ uid: user.id });
            res.cookie('sid', jwt, {
              httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 30*24*3600*1000
            });
          }
        }
      } catch (e) {
        console.warn('tg/callback: device session set failed:', e?.message);
      }
    }

    // 2) Upsert TG auth_account and remember device_id in meta (no forced merges here)
    const tgId = String(data.id || '');
    if (tgId) {
      try {
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
          values (null, 'tg', $1, $2, null, $3)
          on conflict (provider, provider_user_id) do update set
            username  = coalesce(excluded.username,  auth_accounts.username),
            meta      = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [
          tgId,
          data.username ? String(data.username) : null,
          JSON.stringify({ device_id: deviceId || null })
        ]);
      } catch (e) {
        console.warn('tg/callback: upsert auth_accounts failed:', e?.message);
      }
    }

    // 3) Redirect back to the frontend lobby with TG hints (UI will then pull /api/me and show VK if session set)
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const url = new URL('/lobby.html', frontend);
    url.searchParams.set('provider', 'tg');
    if (data.id) url.searchParams.set('id', String(data.id));
    if (data.first_name) url.searchParams.set('first_name', String(data.first_name));
    if (data.last_name) url.searchParams.set('last_name', String(data.last_name));
    if (data.username) url.searchParams.set('username', String(data.username));
    if (data.photo_url) url.searchParams.set('photo_url', String(data.photo_url));

    res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error:', e);
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(302, new URL('/lobby.html?provider=tg', frontend).toString());
  }
});

export default router;