const jwt=require('jsonwebtoken');const JWT_SECRET=process.env.JWT_SECRET;
function signSession(payload){return jwt.sign(payload,JWT_SECRET,{expiresIn:'30d'});}
function verifySession(token){try{return jwt.verify(token,JWT_SECRET);}catch{return null;}}
module.exports={signSession,verifySession};