const express=require('express');const axios=require('axios').default;const cookie=require('cookie');
const { prisma }=require('../lib/db');const { createPkcePair,randomString }=require('../lib/pkce');const { signSession }=require('../lib/jwt');
const router=express.Router();
function setCookie(res,name,val,opts={}){const str=cookie.serialize(name,val,{httpOnly:true,sameSite:'none',secure:true,path:'/',maxAge:60*60*2,...opts});res.setHeader('Set-Cookie',str);}
router.post('/vk/init',async(req,res)=>{try{
  const { VK_CLIENT_ID, VK_REDIRECT_URI }=process.env; if(!VK_CLIENT_ID||!VK_REDIRECT_URI) return res.status(500).json({error:'VK env not set'});
  const { codeVerifier,codeChallenge }=createPkcePair(); const state=randomString(24); const sid=randomString(24);
  await prisma.authSession.create({data:{id:sid,state,codeVerifier}}); setCookie(res,'sid',sid);
  const scope=encodeURIComponent('vkid.personal_info');
  const authUrl=`https://id.vk.com/auth?client_id=${encodeURIComponent(VK_CLIENT_ID)}&redirect_uri=${encodeURIComponent(VK_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
  return res.json({authUrl});
}catch(e){console.error(e);res.status(500).json({error:'init_failed'});}});
router.get('/vk/callback',async(req,res)=>{try{
  const { VK_CLIENT_ID,VK_CLIENT_SECRET,VK_REDIRECT_URI }=process.env; const { code,state,device_id }=req.query;
  const sid=(req.headers.cookie && cookie.parse(req.headers.cookie).sid) || null;
  if(!code||!state||!sid) return res.status(400).send('Missing parameters');
  const sess=await prisma.authSession.findUnique({where:{id:sid}}); if(!sess||sess.state!==state) return res.status(400).send('Invalid state/sid');
  const params={client_id:VK_CLIENT_ID,client_secret:VK_CLIENT_SECRET,redirect_uri:VK_REDIRECT_URI,code,code_verifier:sess.codeVerifier,device_id:device_id||''};
  const tokenResp=await axios.get('https://oauth.vk.com/access_token',{params}); const tok=tokenResp.data;
  const vkId=String(tok.user_id||tok.vk_user_id||tok.uid||''); const user=await prisma.user.upsert({where:{vk_id:vkId||`vk_${sid}`},update:{},create:{vk_id:vkId||`vk_${sid}`}});
  await prisma.transaction.create({data:{userId:user.id,type:'login',amount:0,meta:'vkid'}});
  const token=signSession({uid:user.id,vk_id:user.vk_id}); setCookie(res,'session',token,{maxAge:60*60*24*30});
  await prisma.authSession.delete({where:{id:sid}});
  const lobbyUrl=(process.env.FRONTEND_ORIGIN||'')+'/lobby.html'; return res.redirect(lobbyUrl);
}catch(e){console.error('VK callback err:',e?.response?.data||e.message||e);res.status(500).send('Auth failed');}});
module.exports=router;