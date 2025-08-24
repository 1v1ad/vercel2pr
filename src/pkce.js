// src/pkce.js
import crypto from 'crypto';

export function createCodeVerifier(length = 64) {
  // length 43..128
  const raw = crypto.randomBytes(length);
  return raw.toString('base64url').slice(0, length);
}

export function createCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return Buffer.from(hash).toString('base64url');
}
