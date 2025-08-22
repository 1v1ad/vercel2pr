import crypto from 'crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createCodeVerifier(length = 64) {
  return b64url(crypto.randomBytes(length));
}

export function createCodeChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return b64url(hash);
}
