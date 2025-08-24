// src/tg.js
import crypto from 'crypto';

/**
 * Validates Telegram Login Widget payload.
 * See: https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyTelegramLogin(data, botToken) {
  if (!data || !botToken) return false;
  const { hash, ...fields } = data;

  // Build data-check-string
  const pairs = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(pairs).digest('hex');

  return hmac === String(hash);
}
