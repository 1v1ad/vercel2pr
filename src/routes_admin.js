// src/routes_admin.js  (ESM)
import express from 'express';
import { db } from './db.js';

const router = express.Router();

// --- простая админ-авторизация ---
router.use((req,res,next)=>{
  const need=(process.env.ADMIN_PASSWORD||'').toString();
  const got =(req.get('X-Admin-Password')||'').toString();
  if(!need || got!==need) return res.status(401).json({ok:false,error:'unauthorized'});
  next();
});

// ---------- USERS ----------
router.get('/users', async (req,res)=>{
  try{
    const take=Math.max(1,Math.min(500,parseInt(req.query.take||'50',10)));
    const skip=Math.max(0,parseInt(req.query.skip||'0',10));
    const search=(req.query.search||'').trim();

    const params=[]; let where='where 1=1';
    if(search){
      params.push(`%${search}%`,`%${search}%`,search,`%${search}%`);
      where+=` and (coalesce(u.first_name,'') ilike $${params.length-3}
                 or coalesce(u.last_name,'')  ilike $${params.length}
                 or u.id::text               =     $${params.length-1}
                 or coalesce(u.vk_id::text,'') ilike $${params.length-2})`;
    }
    params.push(take,skip);

    const sql=`
      select
        coalesce(u.hum_id,u.id)      as hum_id,
        u.id                          as user_id,
        u.vk_id                       as vk_id,
        coalesce(u.first_name,'')     as first_name,
        coalesce(u.last_name,'')      as last_name,
        coalesce(u.balance,0)         as balance,
        coalesce(u.country_code,'')   as country_code,
        coalesce(u.country_name,'')   as country_name,
        coalesce(u.created_at,now())  as created_at,
        array_remove(array[
          case when u.vk_id is not null and u.vk_id::text !~ '^tg:' then 'vk' end,
          case when u.vk_id::text ilike 'tg:%' then 'tg' end
        ], null)                      as providers
      from users u
      ${where}
      order by hum_id asc, user_id asc
      limit $${params.length-1} offset $${
