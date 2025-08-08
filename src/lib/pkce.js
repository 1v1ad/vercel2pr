const crypto = require('crypto');
function base64url(buffer){return buffer.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');}
function randomString(len=64){return base64url(crypto.randomBytes(len));}
function createPkcePair(){const codeVerifier=base64url(crypto.randomBytes(48));const hash=crypto.createHash('sha256').update(codeVerifier).digest();const codeChallenge=base64url(hash);return {codeVerifier,codeChallenge};}
module.exports={createPkcePair,randomString};