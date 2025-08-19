// Вспомогательная функция проверки подписи Telegram (ESM)
import crypto from 'crypto';

/**
 * verifyTelegramLogin(data, botToken)
 * data — объект из query (или body) от Telegram Login Widget
 * botToken — токен бота от BotFather (тот же, что в @GGR00m_bot)
 */
export function verifyTelegramLogin(data, botToken) {
  if (!data || !data.hash) return false;

  const { hash, ...rest } = data;

  // Строка проверки в алфавитном порядке по ключам
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');

  // secret = SHA256(botToken)
  const secret = crypto.createHash('sha256').update(botToken).digest();

  // Подпись по алгоритму HMAC-SHA256(secret, checkString)
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return hmac === hash;
}
