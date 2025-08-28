
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export async function ensureTables(){
  await pool.query(`
    create table if not exists users (
      id serial primary key,
      vk_id bigint unique,
      first_name text,
      last_name text,
      photo text,
      created_at timestamptz default now()
    );
    create table if not exists auth_accounts (
      id serial primary key,
      user_id integer references users(id) on delete cascade,
      provider text not null,
      provider_user_id text not null,
      meta jsonb default '{}'::jsonb,
      unique(provider, provider_user_id)
    );
    create table if not exists events (
      id serial primary key,
      user_id integer,
      type text,
      data jsonb,
      created_at timestamptz default now()
    );
  `);
}

export async function getUserById(id){
  const { rows } = await pool.query('select * from users where id=$1', [id]);
  if(!rows[0]) return null;
  const u = rows[0];
  // fetch linked providers
  const acc = await pool.query('select provider, provider_user_id from auth_accounts where user_id=$1', [u.id]);
  u.providers = acc.rows;
  return u;
}

export async function getUserByProvider(provider, pid){
  const { rows } = await pool.query(
    'select u.* from users u join auth_accounts a on a.user_id=u.id where a.provider=$1 and a.provider_user_id=$2',
    [provider, String(pid)]
  );
  return rows[0] || null;
}

async function linkAccount(userId, provider, providerUserId, meta={}){
  await pool.query(
    `insert into auth_accounts (user_id, provider, provider_user_id, meta)
     values ($1,$2,$3,$4)
     on conflict (provider, provider_user_id) do update set user_id=excluded.user_id, meta=excluded.meta`,
    [userId, provider, String(providerUserId), meta]
  );
}

export async function upsertVkUser(vk){
  // Try find existing by provider mapping
  let user = await getUserByProvider('vk', vk.id);
  if(user) return user;
  // If not found, try by vk_id in users table (legacy schema)
  const { rows } = await pool.query('select * from users where vk_id=$1', [vk.id]);
  if(rows[0]){
    user = rows[0];
  } else {
    const ins = await pool.query(
      'insert into users (vk_id, first_name, last_name, photo) values ($1,$2,$3,$4) returning *',
      [vk.id, vk.first_name||'', vk.last_name||'', vk.photo_200||vk.photo||'']
    );
    user = ins.rows[0];
  }
  // ensure mapping
  await linkAccount(user.id, 'vk', vk.id, { username: vk.screen_name || null });
  return user;
}

export async function attachTelegramToUser(userId, tg){
  await linkAccount(userId, 'tg', tg.id, { username: tg.username || null, name: tg.first_name || '' });
  return getUserById(userId);
}

export async function logEvent(userId, type, data){
  await pool.query('insert into events (user_id, type, data) values ($1,$2,$3)', [userId, type, data]);
}
