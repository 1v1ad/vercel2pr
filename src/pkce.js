// src/pkce.js
import crypto from 'crypto';

const toBase64Url = (buf) =>
  Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

export function makePkcePair() {
  const verifier = toBase64Url(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(verifier).digest();
  const challenge = toBase64Url(hash);
  return { verifier, challenge };
}
