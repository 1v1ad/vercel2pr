import crypto from 'crypto';
function base64url(buf){return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function createCodeVerifier(){return base64url(crypto.randomBytes(32));}
export function createCodeChallenge(verifier){const hash=crypto.createHash('sha256').update(verifier).digest();return base64url(hash);}
