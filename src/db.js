import pkg from 'pg'; 
const { Pool } = pkg;
const pool=new Pool({ connectionString: process.env.DATABASE_URL });

export async function ensureTables(){
  const sql=`
  create table if not exists users(
    id bigserial primary key,
    vk_id text unique,
    telegram_id text unique,
    first_name text,
    last_name text,
    avatar text
  );
  create table if not exists events(
    id bigserial primary key,
    user_id bigint,
    event_type text,
    payload jsonb,
    ip text,
    ua text,
    created_at timestamptz default now()
  );`;
  await pool.query(sql);
}

export async function upsertUser({vk_id=null,telegram_id=null,first_name='',last_name='',avatar=''}){
  let row = null;
  if (vk_id){
    const q = await pool.query('select * from users where vk_id=$1 limit 1',[vk_id]);
    if (q.rows.length) row = q.rows[0];
  }
  if (!row && telegram_id){
    const q = await pool.query('select * from users where telegram_id=$1 limit 1',[telegram_id]);
    if (q.rows.length) row = q.rows[0];
  }
  if (!row){
    const ins = await pool.query(
      'insert into users(vk_id,telegram_id,first_name,last_name,avatar) values($1,$2,$3,$4,$5) returning *',
      [vk_id,telegram_id,first_name,last_name,avatar]
    );
    row = ins.rows[0];
  } else {
    const upd = await pool.query(
      'update users set first_name=coalesce($1,first_name), last_name=coalesce($2,last_name), avatar=coalesce($3,avatar) where id=$4 returning *',
      [first_name,last_name,avatar,row.id]
    );
    row = upd.rows[0];
  }
  return row;
}

export async function logEvent({user_id=null,event_type,payload=null,ip='',ua=''}){
  try{
    await pool.query('insert into events(user_id,event_type,payload,ip,ua) values($1,$2,$3,$4,$5)',[user_id,event_type,payload,ip,ua]);
  }catch(e){}
}
