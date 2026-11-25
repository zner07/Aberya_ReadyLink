/* Click/change/keyboard handlers and app boot for the ADMIN site. Mobile menu logic is in ../js/menu.js. */

const hashId=()=>location.hash.split('/')[2];                      // #/report/RL-001 -> RL-001
document.addEventListener('click',async e=>{
  const t=e.target;
  if(t.id==='dlg'){closeDlg();return}
  const pin=t.closest('[data-pin]');
  if(pin){if(pin.closest('[data-ctx]')?.dataset.ctx==='map'){S.sel=pin.dataset.pin;refreshMap()}return}
  const th=t.closest('[data-f]');
  if(th&&th.tagName==='BUTTON'){F()[th.dataset.f]=th.dataset.v;if($('#mstage'))refreshMap();return}
  const go=t.closest('[data-go]');
  if(go){if(go.dataset.sel)S.sel=go.dataset.sel;goto(go.dataset.go);return}
  if(t.closest('.mmenu a'))closeMenu();                          // navigating from the mobile menu closes it
  const a=t.closest('[data-act]');if(!a)return;const k=a.dataset.act;
  if(k==='menu')setMenu(!document.body.classList.contains('menu-open'));
  if(k==='menu-close')closeMenu();
  if(k==='theme'){document.documentElement.dataset.theme=theme()==='dark'?'light':'dark';render(true)}
  if(k==='logout'){const out=await API.signOut();S.admin=false;goto('#/login');if(out&&out.ok===false)toast(out.message)}
  if(k==='togglepw'){const pw=$('#pw');if(pw){const show=pw.type==='password',pos=pw.selectionStart;pw.type=show?'text':'password';   // the typed text is never touched
    a.innerHTML=ic(show?'eyeoff':'eye',20);a.setAttribute('aria-pressed',String(show));a.setAttribute('aria-label',show?'Hide password':'Show password');pw.focus();try{pw.setSelectionRange(pos,pos)}catch(e){}}}
  if(k==='dlg-no')closeDlg();
  if(k==='dlg-yes'){const f=S.dlg?.onYes;closeDlg();if(f)f()}
  /* --- map view and filters --- */
  if(k==='view'){S.mapView=a.dataset.v;S.hot=null;if($('#mstage'))refreshMap()}
  if(k==='hot'){const i=+a.dataset.i;S.hot=S.hot===i?null:i;if($('#mstage'))refreshMap()}
  if(k==='clear'){Object.assign(F(),blankFilter());render(true)}
  if(k==='retry-admin'||k==='refresh-admin')loadAdminReports();
  if(k==='retry-boot')location.reload();
  /* --- Admin review (adminUpdate lives in js/admin-actions.js) --- */
  if(k==='advance'){const r=R.find(x=>x.id===a.dataset.id),n=si(r)+1;if(n>3)return;await adminUpdate(r.id,{status:STS[n],remark:$('#nt').value.trim()},['','Report verified','Monitoring started','Marked as resolved'][n])}
  if(k==='remark'){const nt=$('#nt').value.trim();if(!nt){toast('Write a remark first');return}await adminUpdate(a.dataset.id,{remark:nt},'Remark saved')}
});
document.addEventListener('change',async e=>{const t=e.target;
  if(t.dataset.f){F()[t.dataset.f]=t.value;if($('#mstage'))refreshMap();else render(true)}
  if(t.dataset.act==='level')await adminUpdate(hashId(),{level:t.value},'Risk level updated');
  if(t.dataset.act==='status')await adminUpdate(hashId(),{status:t.value,remark:$('#nt')?.value.trim()},'Status updated to '+t.value)});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.body.classList.contains('menu-open')){closeMenu();$('.menubtn')?.focus();return}
  if(e.key==='Escape'&&S.dlg){closeDlg();return}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('[data-pin],[data-go],g[data-act]')){e.preventDefault();e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}))}});

/* boot. Server mode: ask the server whether the admin cookie is valid. Not signed in -> the sign-in page right away (no reports are loaded for a visitor).
   Signed in -> a loading message, then the reports from the database, or an error with a retry button. */
const bootBox=(inner)=>loginShell(`<div class="wrap"><div class="glass" style="margin-top:46px">${inner}</div></div>`);
async function boot(){
  await API.init();                                    // 'demo' or 'server' (see ../js/config.js)
  S.admin=API.mode==='server'?await API.refreshAdminSession():API.hasSession();
  if(API.mode==='server'&&!S.admin){S.reports.loadedAt=0;render();return}   // reports are loaded right after sign-in (see admin-router.js)
  if(API.mode==='server')$('#app').innerHTML=bootBox(`<div class="hint" role="status" aria-live="polite" aria-busy="true"><b>Loading reports…</b><span>Getting the latest reports from the server.</span></div>`);
  try{await Promise.all([loadReports(),loadInsights(),applyConnectivity()])}
  catch(err){
    $('#app').innerHTML=bootBox(`<div class="hint" role="alert"><b>Couldn't load the reports</b><span>${esc((err&&err.userMessage)||'Something went wrong while loading. Please try again.')}</span><button class="btn primary" data-act="retry-boot">Try again</button></div>`);
    return}
  S.reports.loadedAt=Date.now();
  render()}
boot();
