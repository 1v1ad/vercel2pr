import express from 'express';
import { randomBytes } from 'crypto';

import { db } from './db.js';

const router = express.Router();

const generateToken = () => randomBytes(24).toString('hex') + Date.now().toString(36);

router.post('/start', async (req, res) => {
  try {
    const uid = Number(req.get('X-User-Id') || req.body?.user_id || 0);
    const target = String(req.body?.target || '').trim();
    if (!uid || !['vk', 'tg'].includes(target)) {
      return res.status(400).json({ ok: false, error: 'bad_args' });
    }

    const token = generateToken();
    const params = [token, uid, target];
    const insertSql = `
      insert into link_tokens(token, user_id, target, created_at, expires_at)
      values ($1, $2, $3, now(), now() + interval '15 minutes')
    `;
    try {
      await db.query(insertSql, params);
    } catch (err) {
      await db.query(`
        create table if not exists link_tokens (
          token text primary key,
          user_id bigint not null,
          target text not null,
          created_at timestamp without time zone not null,
          expires_at timestamp without time zone not null,
          done boolean default false
        )
      `);
      await db.query(insertSql, params);
    }

    const url = `/link/confirm?token=${encodeURIComponent(token)}`;
    res.json({ ok: true, token, url, ttl_minutes: 15 });
  } catch (e) {
    console.error('link start error', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/status', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ ok: false, error: 'bad_args' });

    const result = await db.query(
      'select done, now() > expires_at as expired from link_tokens where token = $1',
      [token]
    );
    if (!result.rows?.length) return res.json({ ok: false, error: 'not_found' });

    const row = result.rows[0];
    res.json({ ok: true, done: !!row.done, expired: !!row.expired });
  } catch (e) {
    console.error('link status error', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.post('/finish', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const providerUserId = String(req.body?.provider_user_id || '').trim();
    if (!token || !providerUserId) {
      return res.status(400).json({ ok: false, error: 'bad_args' });
    }

    const tokenResult = await db.query(
      'select user_id, target, expires_at, done from link_tokens where token = $1',
      [token]
    );
    if (!tokenResult.rows?.length) return res.status(404).json({ ok: false, error: 'not_found' });

    const tokenRow = tokenResult.rows[0];
    if (tokenRow.done || new Date(tokenRow.expires_at) < new Date()) {
      return res.json({ ok: false, error: 'expired' });
    }

    const ownerHumResult = await db.query(
      'select coalesce(hum_id, id) as hum_id from users where id = $1',
      [tokenRow.user_id]
    );
    const ownerHum = ownerHumResult.rows?.[0]?.hum_id || tokenRow.user_id;

    const linkedUserResult = await db.query(
      'select id, coalesce(hum_id, id) as hum_id from users where vk_id = $1',
      [providerUserId]
    );
    if (!linkedUserResult.rows?.length) {
      return res.json({ ok: false, error: 'provider_user_not_found' });
    }

    const linkedId = linkedUserResult.rows[0].id;

    await db.query(
      `update users
         set hum_id = $1,
             merged_via_proof = true
       where coalesce(hum_id, id) = (
         select coalesce(hum_id, id) from users where id = $2
       )`,
      [ownerHum, linkedId]
    );

    await db.query(
      'update users set merged_via_proof = true where coalesce(hum_id, id) = $1',
      [ownerHum]
    );

    await db.query('update link_tokens set done = true where token = $1', [token]);

    await db.query(
      `insert into events (user_id, hum_id, event_type, created_at, meta)
       values ($1, $2, 'hum_merge_proof', now(), $3::jsonb)`,
      [
        tokenRow.user_id,
        ownerHum,
        JSON.stringify({ provider_user_id: providerUserId, token, target: tokenRow.target }),
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('link finish error', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
