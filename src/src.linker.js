// STEP 1: Background account linker (pure functions, no framework lock-in)
// Use with your existing VK/TG callbacks *after* you have verified the provider token.
// Minimal API you need to call:
//   const user = await upsertAndLink({ provider, provider_user_id, username, first_name, last_name, avatar_url, phone_hash, device_id });
//
// It will:
//  - find existing user by provider id
//  - or reuse a user matched by device_id (hashed) or phone hash
//  - or create a new user
//  - link the provider identity
//  - backfill empty profile fields (avatar/name)
//  - return the unified user row

import crypto from 'crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false });
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev_cookie_secret';

function hDevice(id) {
  if (!id) return null;
  return crypto.createHash('sha256').update(`${id}|${COOKIE_SECRET}`).digest('hex');
}

export async function upsertAndLink({ provider, provider_user_id, username, first_name, last_name, avatar_url, phone_hash, device_id }) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const one = async (text, params=[]) => (await client.query(text, params)).rows;

    const byProv = await one(
      `select u.* from auth_accounts a join users u on u.id = a.user_id where a.provider=$1 and a.provider_user_id=$2`,
      [provider, String(provider_user_id)]
    );
    let user = byProv[0] || null;
    let userId = user?.id || null;

    const devHash = device_id ? hDevice(device_id) : null;
    const byDev  = devHash ? await one(`select user_id from device_links where device_id_hash=$1`, [devHash]) : [];
    const devUserId = byDev[0]?.user_id || null;

    const byPhone = phone_hash ? await one(`select user_id from auth_accounts where phone_hash=$1 limit 1`, [phone_hash]) : [];
    const phoneUserId = byPhone[0]?.user_id || null;

    if (!userId) {
      if (devUserId) userId = devUserId;
      else if (phoneUserId) userId = phoneUserId;
      else {
        const cr = await one(
          `insert into users(first_name,last_name,avatar_url) values ($1,$2,$3) returning *`,
          [first_name || null, last_name || null, avatar_url || null]
        );
        user = cr[0];
        userId = user.id;
      }
    }

    await client.query(
      `insert into auth_accounts(user_id,provider,provider_user_id,username,phone_hash,meta)
         values ($1,$2,$3,$4,$5,$6)
       on conflict (provider, provider_user_id) do update
         set user_id = excluded.user_id,
             username = coalesce(excluded.username, auth_accounts.username),
             phone_hash = coalesce(excluded.phone_hash, auth_accounts.phone_hash),
             meta = coalesce(excluded.meta, auth_accounts.meta)`,
      [userId, provider, String(provider_user_id), username || null, phone_hash || null, null]
    );

    if (devHash) {
      await client.query(
        `insert into device_links(device_id_hash, user_id) values ($1,$2)
         on conflict (device_id_hash) do update
           set user_id = excluded.user_id, last_seen_at=now(), seen_count = device_links.seen_count+1`,
        [devHash, userId]
      );
    }

    // Backfill missing profile fields
    await client.query(
      `update users set
        first_name = coalesce(first_name, $2),
        last_name  = coalesce(last_name,  $3),
        avatar_url = coalesce(avatar_url, $4)
       where id = $1`,
      [userId, first_name || null, last_name || null, avatar_url || null]
    );

    const fin = await one(`select * from users where id=$1`, [userId]);
    await client.query('commit');
    return fin[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await pool.query(
    `insert into events(user_id,event_type,payload,ip,ua,country_code) values ($1,$2,$3,$4,$5,$6)`,
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}
