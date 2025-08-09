// src/pkce.js
import crypto from 'crypto';

export function genRandomString(len = 43) {
  return crypto.randomBytes(len).toString('hex').slice(0, 64);
}

export function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function createCodeVerifier() {
  // 43-128 chars per RFC 7636
  return base64url(crypto.randomBytes(64));
}

export function createCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}
