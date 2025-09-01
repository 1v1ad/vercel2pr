// src/routes_tg.js
// Telegram auth + account linking + device based auto-merge

import { Router } from 'express';
import crypto from 'crypto';
import { db } from './db.js';
import { autoMergeByDevice, resolvePrimaryUserId } from './merge.js';

const router = Router();

function tgVerify(data, botToken) {
  const checkHash = data.hash;
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const payload = Object.keys(data)
    .filter(k => k !== 'hash')
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\\n');
  const hmac = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
  return hmac === checkHash;
}

// Telegram login callback
router.get('/callback', async (req, res) => {
  try {
    const botToken = (process.env.TG_BOT_TOKEN || process.env.BOT_TOKEN || '').toString();
    if (!botToken) return res.status(500).send('TG bot token not configured');

    const q = req.query || {};
    const ok = tgVerify(q, botToken);
    if (!ok) return res.status(401).send('invalid tg login');

    // Find or create user
    const tgid = String(q.id);
    const deviceId = (q.device_id || req.get('X-Device-Id') || '').toString().trim();

    // Create user if needed
    let userId;
    const u = await db.query('select id from users where username = $1 or (meta->>\'tg_id\') = $1 limit 1', [tgid]);
    if (u.rowCount) {
      userId = u.rows[0].id;
    } else {
      const ins = await db.query(
        `insert into users(first_name, last_name, username, meta)
             values($1,$2,$3, jsonb_build_object('tg_id',$4))
          returning id`,
        [q.first_name || '', q.last_name || '', q.username || '', tgid]
      );
      userId = ins.rows[0].id;
    }

    // Link auth account
    await db.query(
      `insert into auth_accounts(user_id, provider, provider_user_id, device_id)
           values($1,'tg',$2,$3)
       on conflict (provider, provider_user_id)
       do update set user_id=excluded.user_id, device_id=coalesce(excluded.device_id, auth_accounts.device_id)`,
      [userId, tgid, deviceId || null]
    );

    // Auto-merge by device (if same device already had VK user)
    if (deviceId) {
      await autoMergeByDevice(userId, deviceId);
      userId = await resolvePrimaryUserId(userId);
    }

    // Minimal session cookie (you likely already have middleware for that)
    res.cookie('uid', String(userId), { httpOnly: true, sameSite: 'lax' });
    res.redirect('/lobby.html?logged=1');
  } catch (e) {
    res.status(500).send(String(e && e.message || e));
  }
});

export default router;
