// src/pkce.js — PKCE utils для VK OAuth (ESM)

//
// URL-safe base64
//
export function base64url(input) {
  // input может быть: ArrayBuffer | Uint8Array | string
  const buf =
    input instanceof Uint8Array
      ? Buffer.from(input)
      : typeof input === 'string'
      ? Buffer.from(input, 'utf8')
      : Buffer.from(new Uint8Array(input)); // ArrayBuffer -> Uint8Array -> Buffer

  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

//
// Генерация verifier (43..128 символов по PKCE). Делаем 64 — с запасом.
//
export function createCodeVerifier(len = 64) {
  const bytes = new Uint8Array(len);
  // В Node 18+ доступен WebCrypto: crypto.getRandomValues
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

//
// SHA-256(verifier) -> Uint8Array
//
export async function sha256(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

//
// Удобная обёртка: сразу PKCE code_challenge=S256
//
export async function createCodeChallenge(verifier) {
  const hash = await sha256(verifier);
  return base64url(hash);
}
