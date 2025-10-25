// admin/merge-suggest.js — ensure headers + JSON
(function(){
  function getApi(){ return (window.API || localStorage.getItem('ADMIN_API') || '').replace(/\/+$/,''); }
  function headersJSON(){
    return Object.assign({ 'Content-Type':'application/json' }, (window.adminHeaders ? window.adminHeaders() : {}));
  }

  window.adminMergeSuggestions = async function adminMergeSuggestions(limit){
    const API = getApi();
    if(!API) return { ok:false, error:'no_api' };
    try{
      const r = await fetch(API + '/api/admin/users/merge/suggestions' + (limit?('?limit='+encodeURIComponent(limit)):'') , {
        method: 'GET',
        headers: (window.adminHeaders ? window.adminHeaders() : {}),
        cache: 'no-store'
      });
      return await r.json();
    }catch(e){
      return { ok:false, error:String(e && e.message || e) };
    }
  };

  window.adminMergeUsers = async function adminMergeUsers(primary_id, secondary_id){
    const API = getApi();
    if(!API) return { ok:false, error:'no_api' };
    try{
      const r = await fetch(API + '/api/admin/users/merge', {
        method: 'POST',
        headers: headersJSON(),
        body: JSON.stringify({ primary_id, secondary_id }),
        cache: 'no-store'
      });
      return await r.json();
    }catch(e){
      return { ok:false, error:String(e && e.message || e) };
    }
  };
})();
