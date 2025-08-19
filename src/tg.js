import crypto from 'crypto';

/**
 * Проверка подписи Telegram Login Widget.
 * data — объект из query/body (содержит hash, id, first_name, auth_date и т.д.)
 * botToken — токен бота @BotFather (тот же, что у TELEGRAM_BOT_TOKEN)
 */
export function verifyTelegramLogin(data, botToken) {
  if (!data || !data.hash) return false;

  const { hash, ...rest } = data;

  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return hmac === hash;
}
