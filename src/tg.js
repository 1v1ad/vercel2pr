import crypto from 'crypto';

/* Валидация Telegram Login Widget */
export function verifyTelegramLogin(data, botToken) {
  const checkHash = data.hash;
  const secret    = crypto.createHash('sha256').update(botToken).digest();

  const dataCheckString = Object.keys(data)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('\n');

  const hmac = crypto.createHmac('sha256', secret)
    .update(dataCheckString)
    .digest('hex');

  return hmac === checkHash;
}
