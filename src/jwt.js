import crypto from 'crypto';
function base64url(obj){return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export function signSession(payload){
  const secret = process.env.JWT_SECRET || 'change-me';
  const header={alg:'HS256',typ:'JWT'}; const now=Math.floor(Date.now()/1000);
  const body={...payload,iat:now}; const h=base64url(header); const b=base64url(body);
  const data=h+'.'+b;
  const sig=crypto.createHmac('sha256',secret).update(data).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return data+'.'+sig;
}
