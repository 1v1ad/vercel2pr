import crypto from 'crypto';
export function base64url(input){
  return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
export function createCodeVerifier(){ return base64url(crypto.randomBytes(64)); }
export function createCodeChallenge(verifier){
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64url(hash);
}
