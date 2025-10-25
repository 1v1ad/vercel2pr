// admin/topup.js — ensure JSON headers
(function(){
  function getApi(){ return (window.API || localStorage.getItem('ADMIN_API') || '').replace(/\/+$/,''); }
  function headersJSON(){
    return Object.assign({ 'Content-Type':'application/json' }, (window.adminHeaders ? window.adminHeaders() : {}));
  }
  window.adminTopup = async function adminTopup(userId, amount){
    const API = getApi();
    if(!API || !userId) return { ok:false, error:'no_api_or_user' };
    try{
      const r = await fetch(API + '/api/admin/users/' + String(userId) + '/topup', {
        method: 'POST',
        headers: headersJSON(),
        body: JSON.stringify({ amount: Number(amount)||0 }),
        cache: 'no-store'
      });
      return await r.json();
    }catch(e){
      return { ok:false, error: String(e && e.message || e) };
    }
  };
})();
