// src/pkce.js  — ESM-версия генератора PKCE (S256)
import { randomBytes, createHash } from 'crypto';

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Генерирует пару {verifier, challenge} для PKCE S256.
 * @param {number} bytesLength длина случайных байт для верифаера (по умолчанию 64)
 */
export function makePkcePair(bytesLength = 64) {
  const verifier = base64url(randomBytes(bytesLength));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

// На всякий случай — дефолт-экспорт тем же именем:
export default makePkcePair;
