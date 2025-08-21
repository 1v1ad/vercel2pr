import { Router } from 'express';
import { db } from './db.js';
import { requireUserId, generateLinkCode, claimCodeAndMerge, setPhoneAndAutoMerge } from './linking.js';

const router = Router();

// Health
router.get('/alive', (_req, res) => res.json({ ok: true }));

// Who am I (minimal)
router.get('/whoami', async (req, res) => {
  try {
    let uid;
    try { uid = requireUserId(req); } catch { uid = null; }
    if (!uid) return res.json({ ok: true, user: null });

    const { rows } = await db.query(
      `select u.id, u.first_name, u.last_name, u.avatar, u.balance,
              array_agg(distinct aa.provider) as providers,
              bool_or(aa.phone_hash is not null) as has_phone
         from users u
         left join auth_accounts aa on aa.user_id = u.id
        where u.id = $1
        group by u.id`, [uid]
    );
    const user = rows[0] || null;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Generate LINK-XXXX code
router.post('/link/code/generate', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const r = await generateLinkCode(userId, 15);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'error' });
  }
});

// Claim code
router.post('/link/code/claim', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const code = (req.body?.code || '').trim().toUpperCase();
    if (!/^LINK-[A-Z0-9]{4}$/.test(code)) return res.status(400).json({ ok: false, error: 'bad_code' });

    const meta = { ip: req.ip, ua: req.headers['user-agent'] || '' };
    const r = await claimCodeAndMerge(userId, code, meta);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'error' });
  }
});

// Submit phone to auto-merge (phone-match)
router.post('/link/phone', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { phone } = req.body || {};
    const meta = { ip: req.ip, ua: req.headers['user-agent'] || '' };
    const r = await setPhoneAndAutoMerge(userId, phone, meta);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || 'error' });
  }
});

export default router;
