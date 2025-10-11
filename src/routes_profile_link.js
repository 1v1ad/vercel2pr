import express from 'express';
import { randomBytes } from 'crypto';
import { db } from './db.js';

const router = express.Router();

// local helper: parse JWT-ish cookie "sid" -> { uid }
function decodeSidCookie(req) {
  try {
    const token = req.cookies?.sid;
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const uid = Number(payload?.uid || 0);
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch { return null; }
}

async function ensureLinkTable() {
  await db.query(`
    create table if not exists link_tokens (
      token text primary key,
      user_id bigint not null,
      target text not null,            -- 'vk' | 'tg'
      return_url text,
      created_at timestamptz default now(),
      expires_at timestamptz not null,
      done boolean default false
    );
    create index if not exists link_tokens_expires_idx on link_tokens(expires_at);
  `);
}

function genToken(){ return randomBytes(24).toString('hex') + Date.now().toString(36); }

// Back-compat: POST /start returns a URL to open
router.post('/start', async (req, res) => {
  try {
    const uid = Number(req.get('X-User-Id') || req.body?.user_id || decodeSidCookie(req) || 0);
    const target = String(req.body?.target || '').trim();
    const returnUrl = String(req.body?.return || req.query?.return || '');
    if (!uid || !['vk','tg'].includes(target)) return res.status(400).json({ ok:false, error:'bad_args' });

    await ensureLinkTable();
    const ttlMinutes = 15;
    const token = genToken();
    const expires = new Date(Date.now() + ttlMinutes*60*1000);
    await db.query(
      `insert into link_tokens(token,user_id,target,return_url,expires_at) values($1,$2,$3,$4,$5)`,
      [token, uid, target, returnUrl || null, expires]
    );
    const url = `/api/profile/link/start?target=${encodeURIComponent(target)}&state=${encodeURIComponent(token)}${ returnUrl ? `&return=${encodeURIComponent(returnUrl)}` : '' }`;
    res.json({ ok:true, url, token, ttl_minutes: ttlMinutes });
  } catch(e){
    console.error('link start(post) error', e);
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// Primary: GET /start -> 302 to /api/auth/{vk|tg}/start?mode=link&state=token
router.get('/start', async (req, res) => {
  try {
    const uid = Number(req.get('X-User-Id') || req.query?.user_id || decodeSidCookie(req) || 0);
    const target = (req.query?.target || (req.query?.vk ? 'vk' : (req.query?.tg ? 'tg' : ''))).toString();
    const returnUrl = String(req.query?.return || '');
    if (!uid || !['vk','tg'].includes(target)) return res.status(400).send('bad_args');

    await ensureLinkTable();
    const ttlMinutes = 15;
    const token = String(req.query?.state || '') || genToken();
    const expires = new Date(Date.now() + ttlMinutes*60*1000);

    // upsert token row (fresh token each time)
    await db.query(
      `insert into link_tokens(token,user_id,target,return_url,expires_at)
       values($1,$2,$3,$4,$5)
       on conflict (token) do update set user_id=excluded.user_id, target=excluded.target, return_url=excluded.return_url, expires_at=excluded.expires_at, done=false`,
      [token, uid, target, returnUrl || null, expires]
    );

    const location = `/api/auth/${target}/start?mode=link&state=${encodeURIComponent(token)}${ returnUrl ? `&return=${encodeURIComponent(returnUrl)}` : '' }`;
    res.redirect(302, location);
  } catch(e){
    console.error('link start(get) error', e);
    res.status(500).send('server_error');
  }
});

// Check status (optional for polling UIs)
router.get('/status', async (req,res) => {
  try {
    const token = String(req.query?.token || '');
    if (!token) return res.status(400).json({ ok:false, error:'bad_args' });
    const r = await db.query(`select done, now()>expires_at as expired from link_tokens where token=$1`, [token]);
    if (!r.rows?.length) return res.json({ ok:false, error:'not_found' });
    res.json({ ok:true, done: !!r.rows[0].done, expired: !!r.rows[0].expired });
  } catch(e){
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

export default router;
