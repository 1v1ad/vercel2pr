// src/routes_telegram_webhook.js
import { Router } from 'express';
import { db } from './db.js';
import { setPhoneAndAutoMerge } from './linking.js';

const router = Router();

router.post('/webhook', async (req, res) => {
  try {
    const sec = (req.query?.secret || '').toString();
    if (!sec || sec !== (process.env.BOT_WEBHOOK_SECRET || 'dev')) {
      return res.status(403).send('forbidden');
    }

    const update = req.body || {};
    const msg = update.message || update.edited_message || null;
    if (!msg) return res.json({ ok: true });

    // Контакт
    if (msg.contact && msg.from) {
      const phone = msg.contact.phone_number;
      const tgId = String(msg.from.id);

      // Находим user_id по auth_accounts(provider='tg')
      const r = await db.query(
        `select user_id from auth_accounts where provider = 'tg' and provider_user_id = $1 limit 1`,
        [tgId]
      );
      const userId = r.rows?.[0]?.user_id || null;
      if (userId) {
        await setPhoneAndAutoMerge(userId, phone, { method: 'tg-contact', source: '/provider/telegram/webhook' });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('tg webhook error', e?.message || e);
    return res.json({ ok: false });
  }
});

export default router;
