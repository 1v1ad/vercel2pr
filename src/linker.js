// ESM module
import crypto from 'crypto';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev_cookie_secret';

function hashDeviceId(id) {
  if (!id) return null;
  return crypto.createHash('sha256').update(`${id}|${COOKIE_SECRET}`).digest('hex');
}

async function q(text, params=[]) { return (await pool.query(text, params)).rows; }

export async function upsertAndLink({ provider, provider_user_id, username, first_name, last_name, avatar_url, phone_hash, device_id }) {
  const devHash = device_id ? hashDeviceId(device_id) : null;

  // 1) By provider
  let rows = await q(
    `select u.* from auth_accounts a join users u on u.id=a.user_id where a.provider=$1 and a.provider_user_id=$2`,
    [provider, String(provider_user_id)]
  );
  let user = rows[0] || null;
  let userId = user?.id || null;

  // 2) By device
  if (!userId && devHash) {  // NOTE: corrected "and" to "&&" later
    rows = await q(`select user_id from device_links where device_id_hash=$1`, [devHash]);
    userId = rows[0]?.user_id || null;
  }

  // 3) By phone hash
  if (!userId && phone_hash) {
    rows = await q(`select user_id from auth_accounts where phone_hash=$1 limit 1`, [phone_hash]);
    userId = rows[0]?.user_id || null;
  }

  // Create user if still none
  if (!userId) {
    rows = await q(
      `insert into users(first_name,last_name,avatar_url) values ($1,$2,$3) returning *`,
      [first_name || null, last_name || null, avatar_url || null]
    );
    user = rows[0]; userId = user.id;
  }

  // Link provider identity
  await pool.query(
    `insert into auth_accounts(user_id,provider,provider_user_id,username,phone_hash,meta)
       values ($1,$2,$3,$4,$5,$6)
     on conflict (provider, provider_user_id) do update
       set user_id=excluded.user_id,
           username=coalesce(excluded.username, auth_accounts.username),
           phone_hash=coalesce(excluded.phone_hash, auth_accounts.phone_hash),
           meta=coalesce(excluded.meta, auth_accounts.meta)`,
    [userId, provider, String(provider_user_id), username || null, phone_hash || null, null]
  );

  // Link device
  if (devHash) {
    await pool.query(
      `insert into device_links(device_id_hash,user_id) values ($1,$2)
       on conflict (device_id_hash) do update
         set user_id=excluded.user_id, last_seen_at=now(), seen_count=device_links.seen_count+1`,
      [devHash, userId]
    );
  }

  // Backfill empty profile fields
  await pool.query(
    `update users set
      first_name=coalesce(first_name,$2),
      last_name =coalesce(last_name,$3),
      avatar_url=coalesce(avatar_url,$4)
     where id=$1`,
    [userId, first_name || null, last_name || null, avatar_url || null]
  );

  const f = await q(`select * from users where id=$1`, [userId]);
  return f[0];
}

export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await pool.query(
    `insert into events(user_id,event_type,payload,ip,ua,country_code) values ($1,$2,$3,$4,$5,$6)`,
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}

// Helpers you may want inside callbacks
export function readDeviceId(req) {
  return (
    req?.query?.did ||
    req?.headers?.['x-device-id'] ||
    (req?.cookies ? req.cookies.did : '') ||
    ''
  )?.toString().slice(0,200) || null;
}
export function firstIp(req) {
  return (req?.headers?.['x-forwarded-for'] || req?.ip || '').toString().split(',')[0].trim();
}
export function userAgent(req) {
  return (req?.headers?.['user-agent'] || '').slice(0,256);
}
