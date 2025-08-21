import { Router } from 'express';
import axios from 'axios';
import { db } from './db.js';
import { setPhoneAndAutoMerge } from './linking.js';

const router = Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET || 'dev';

function api(method, payload) {
  return axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });
}

router.post('/webhook', async (req, res) => {
  try {
    const secret = String(req.query?.secret || '');
    if (!secret || secret !== WEBHOOK_SECRET) return res.status(403).send('forbidden');

    const update = req.body || {};
    const msg = update.message || update.edited_message || null;
    if (!msg) return res.json({ ok: true });

    const chat_id = msg.chat?.id;
    const from_id = msg.from?.id && String(msg.from.id);

    // 1) /start → показываем кнопку "Поделиться номером"
    if (msg.text && /^\/start/i.test(msg.text)) {
      await api('sendMessage', {
        chat_id,
        text: 'Чтобы связать VK↔TG, поделитесь номером: ',
        reply_markup: {
          keyboard: [[{ text: 'Поделиться номером', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return res.json({ ok: true });
    }

    // 2) Любое упоминание "номер" → снова показать кнопку
    if (msg.text && /номер/i.test(msg.text)) {
      await api('sendMessage', {
        chat_id,
        text: 'Нажмите кнопку ниже, чтобы отправить номер:',
        reply_markup: {
          keyboard: [[{ text: 'Поделиться номером', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return res.json({ ok: true });
    }

    // 3) Пришёл контакт → тихо запускаем phone-match и подтверждаем
    if (msg.contact && from_id) {
      const phone = msg.contact.phone_number;

      const r = await db.query(
        `select user_id from auth_accounts where provider='tg' and provider_user_id=$1 limit 1`,
        [from_id],
      );
      const userId = r.rows?.[0]?.user_id;

      if (userId) {
        await setPhoneAndAutoMerge(userId, phone, {
          method: 'tg-contact',
          source: '/provider/telegram/webhook',
          ip: req.ip,
          ua: (req.headers['user-agent'] || '').slice(0, 256),
        });
        await api('sendMessage', { chat_id, text: 'Готово! Телефон подтверждён. Если был второй аккаунт с тем же номером — аккаунты объединены.' });
      } else {
        await api('sendMessage', { chat_id, text: 'Не нашёл вашу сессию. Зайдите на сайт через Telegram и повторите.' });
      }
      return res.json({ ok: true });
    }

    // 4) Фолбэк: /phone +7XXXXXXXXXX (десктоп, где кнопка не работает)
    if (msg.text && /^\/phone\s+/.test(msg.text) && from_id) {
      const phone = msg.text.trim().split(/\s+/)[1] || '';
      const r = await db.query(
        `select user_id from auth_accounts where provider='tg' and provider_user_id=$1 limit 1`,
        [from_id],
      );
      const userId = r.rows?.[0]?.user_id;
      if (!userId) {
        await api('sendMessage', { chat_id, text: 'Сначала войдите на сайте через Telegram.' });
        return res.json({ ok: true });
      }
      await setPhoneAndAutoMerge(userId, phone, {
        method: 'tg-text',
        source: '/provider/telegram/webhook',
        ip: req.ip,
        ua: (req.headers['user-agent'] || '').slice(0, 256),
      });
      await api('sendMessage', { chat_id, text: 'Принято. Если была пара — аккаунты связаны.' });
      return res.json({ ok: true });
    }

    // иначе — молча ок
    return res.json({ ok: true });
  } catch (e) {
    console.error('tg webhook error', e?.response?.data || e?.message || e);
    return res.json({ ok: false });
  }
});

export default router;
