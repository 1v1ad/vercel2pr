// Lightweight Express backend for Render — resilient to missing 'pg'
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const PORT          = process.env.PORT || 3000;
const FRONTEND_URL  = process.env.FRONTEND_URL || '*';
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_PASSWORD= process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || 'admin';
const DATABASE_URL  = process.env.DATABASE_URL || '';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: (_origin, cb) => cb(null, true),
  credentials: true
}));

// ---- DB (optional). Service starts even if 'pg' is not installed or DATABASE_URL is empty.
let db = null;
if (DATABASE_URL) {
  try {
    const pg = await import('pg'); // dynamic import avoids startup crash if pg is missing
    const { Pool } = pg;
    db = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false
    });
    console.log('[boot] PG pool ready');
  } catch (e) {
    console.warn('[boot] PG not available, running without DB:', e?.message || e);
    db = null;
  }
}

function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function parseSid(req) {
  try {
    const t = req.cookies?.sid;
    if (!t) return null;
    return jwt.verify(t, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---- health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now(), db: Boolean(db) }));

// ---- /api/me (clustered balance if DB is present)
app.get('/api/me', async (req, res) => {
  try {
    if (!db) return res.json({ ok: true, user: null, note: 'no-db' });

    const sid = parseSid(req);
    let user = null;

    if (sid?.uid) {
      const { rows } = await db.query(
        'select id, vk_id, first_name, last_name, avatar, balance, meta from users where id=$1',
        [sid.uid]
      );
      user = rows[0] || null;
    }

    const deviceIdCookie = (req.cookies?.device_id || '').trim();
    const dids = [];
    if (deviceIdCookie) dids.push(deviceIdCookie);

    const ids = new Set();
    if (user?.id) ids.add(user.id);

    if (dids.length) {
      const q2 = await db.query(
        "select distinct user_id from auth_accounts where user_id is not null and coalesce(meta->>'device_id','')<>'' and meta->>'device_id' = any($1::text[])",
        [dids]
      );
      for (const r of q2.rows) ids.add(r.user_id);

      const q2b = await db.query(`
        select distinct
          case
            when provider='vk' then (select id from users u where u.vk_id::text = a.provider_user_id limit 1)
            when provider='tg' then (select id from users u where u.vk_id = 'tg:' || a.provider_user_id limit 1)
            else null
          end as uid
        from auth_accounts a
        where coalesce(a.meta->>'device_id','')<>'' and a.meta->>'device_id' = any($1::text[])
      `, [dids]);
      for (const r of q2b.rows) if (r.uid) ids.add(r.uid);
    }

    if (ids.size) {
      const allIds = Array.from(ids);
      const rootsQ = await db.query(
        "select id, coalesce(nullif(meta->>'merged_into','')::int, id) as root_id from users where id = any($1::int[])",
        [allIds]
      );
      const extraRoots = new Set();
      for (const row of rootsQ.rows) if (row.root_id && !ids.has(row.root_id)) extraRoots.add(row.root_id);
      for (const root of extraRoots) ids.add(root);

      if (extraRoots.size) {
        const membersQ = await db.query(
          "select id from users where (meta->>'merged_into')::int = any($1::int[])",
          [Array.from(extraRoots)]
        );
        for (const row of membersQ.rows) ids.add(row.id);
      }
    }

    const clusterIds = Array.from(ids);
    let total = user?.balance || 0;
    if (clusterIds.length) {
      const sumQ = await db.query(
        "select coalesce(sum(coalesce(balance,0)),0)::int as total from users where id = any($1::int[])",
        [clusterIds]
      );
      total = sumQ.rows?.[0]?.total ?? total;
    }

    res.json({
      ok: true,
      user: user ? {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: total
      } : null
    });
  } catch (e) {
    console.error('/api/me error', e);
    res.status(500).json({ ok:false });
  }
});

// ---- background link stub (safe even without DB)
app.post('/api/link/background', async (req, res) => {
  try {
    if (!db) return res.json({ ok:true, merged:false, note:'no-db' });
    const { provider, provider_user_id, username, device_id } = req.body || {};
    if (!provider || !provider_user_id) return res.json({ ok:false, reason:'bad_payload' });

    await db.query(`
      insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
      values (null, $1, $2, $3, null, jsonb_build_object('device_id',$4))
      on conflict (provider, provider_user_id) do update set
        username = coalesce(excluded.username, auth_accounts.username),
        meta     = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
        updated_at = now()
    `, [provider, String(provider_user_id), username || null, device_id || null]);

    res.json({ ok:true, merged:false });
  } catch (e) {
    console.warn('link/background error', e?.message);
    res.json({ ok:false, error:String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log('server listening on :' + PORT);
});
