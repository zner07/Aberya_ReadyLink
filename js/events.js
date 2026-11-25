/* Click/change/input/keyboard handlers and app boot for the PUBLIC site. Mobile menu logic is in js/menu.js.
   The admin site has its own handlers and boot in admin/js/admin-events.js. */

/* =========================================================
   8. EVENTS
   ========================================================= */
document.addEventListener('click',async e=>{
  const t=e.target;
  if(t.id==='dlg'){closeDlg();return}
  if(D.search&&D.search.open&&$('#locsug')&&!t.closest('.locsearch')){D.search.open=false;paintSuggestions()}
  const pin=t.closest('[data-pin]');
  if(pin){const id=pin.dataset.pin,ctx=pin.closest('[data-ctx]')?.dataset.ctx;
    if(ctx==='hero'){S.heroSel=id;const hc=$('#heroCard');hc.innerHTML=heroCard(R.find(r=>r.id===id));hc.dataset.sel=id;document.querySelectorAll('.hero-map .pin').forEach(p=>p.classList.toggle('sel',p.dataset.pin===id))}
    else if(ctx==='map'){S.sel=id;refreshMap()}
    return}
  const pk=t.closest('svg.pickable');
  if(pk){const b=pk.getBoundingClientRect();const px=Math.round((e.clientX-b.left)/b.width*1000),py=Math.round((e.clientY-b.top)/b.height*611);
    if(locJustDragged())return;
    if(!setLocationFromXY(px,py,'map')){toast('That spot is outside Brgy. Alangilan');return}D.gps={state:'idle',msg:''};wizRender();return}
  const th=t.closest('[data-f]');
  if(th&&th.tagName==='BUTTON'){F()[th.dataset.f]=th.dataset.v;if($('#mstage'))refreshMap();return}
  const go=t.closest('[data-go]');
  if(go){if(go.dataset.sel)S.sel=go.dataset.sel;goto(go.dataset.go);return}
  if(t.closest('.mmenu a'))closeMenu();                          // navigating from the mobile menu closes it
  const a=t.closest('[data-act]');if(!a)return;const k=a.dataset.act;
  if(k==='menu')setMenu(!document.body.classList.contains('menu-open'));
  if(k==='menu-close')closeMenu();
  if(k==='theme'){document.documentElement.dataset.theme=theme()==='dark'?'light':'dark';render(true)}
  if(k==='dlg-no')closeDlg();
  /* --- map view, offline-first demo --- */
  if(k==='view'){S.mapView=a.dataset.v;S.hot=null;if($('#mstage'))refreshMap()}
  if(k==='hot'){const i=+a.dataset.i;S.hot=S.hot===i?null:i;if($('#mstage'))refreshMap()}
  if(k==='simoffline'){NET.sim=!NET.sim;await onConnectionChange();toast(NET.sim?'Simulating offline (demo)':'Offline simulation off')}
  if(k==='syncnow')syncNow(a.dataset.id);
  if(k==='retry-mine')loadMyReports();
  if(k==='retry-boot')location.reload();
  if(k==='dlg-yes'){const f=S.dlg?.onYes;closeDlg();if(f)f()}
  if(k==='clear'){Object.assign(F(),blankFilter());render(true)}
  if(k==='reset')openDlg({title:'Reset demo data?',body:'This removes reports you submitted and restores the sample reports. It only affects this browser.',yes:'Reset',onYes:async()=>{await API.resetDemo();await Promise.all([loadReports(),loadQueue(),loadInsights()]);NET.sim=false;S.mapView='markers';S.hot=null;D=newDraft();S.sel=null;S.heroSel='RL-029';S.pf=blankFilter();S.af=blankFilter();toast('Demo data reset');goto('#/home')}});
  /* --- Report a risk wizard --- */
  if(k==='sample'){D.type=a.dataset.k;D.img=null;D.fname='';D.exif=null;D.photoRun++;wizRender()}
  if(k==='rmphoto'){D.type=null;D.img=null;D.fname='';D.exif=null;D.photoRun++;wizRender()}
  if(k==='goto'){D.run++;D.scan=false;D.step=+a.dataset.s;wizRender()}
  if(k==='next'){D.step++;if(D.step===4)runAnalysis();else wizRender()}
  if(k==='back'){D.run++;D.scan=false;D.step=Math.max(1,D.step-1);wizRender()}
  if(k==='locate')useMyLocation();                       // real GPS (js/location.js), only when the person presses the button
  if(k==='clearpin'){clearLocation();wizRender()}
  if(k==='locsearch')runSearch();
  if(k==='locpick')pickPlace(+a.dataset.i);
  if(k==='exif-accept')acceptExif();
  if(k==='exif-reject')rejectExif();
  if(k==='tag'){const ta=$('#desc'),p=a.dataset.t+'.';let v=ta.value;v=v.includes(p)?v.replace(p,'').replace(/\s{2,}/g,' ').trim():(v.trim()?v.trim()+' ':'')+p;if(v.length>240)return;ta.value=v;D.desc=v;wizRender()}
  if(k==='cancel'){const leave=()=>{D.run++;D=newDraft();goto('#/home')};dirty()?openDlg({title:'Discard this report?',body:'What you entered so far will be removed.',no:'Keep editing',yes:'Discard',onYes:leave}):leave()}
  if(k==='submit')sendReport();
  if(k==='again'){D=newDraft();render()}
});
document.addEventListener('change',async e=>{const t=e.target;
  if(t.dataset.f){F()[t.dataset.f]=t.value;if($('#mstage'))refreshMap();else render(true)}
});
document.addEventListener('input',e=>{if(e.target.id==='desc'){D.desc=e.target.value;$('#wizSide').innerHTML=wizSide();const c=$('#cnt');if(c)c.textContent=D.desc.length+'/240';document.querySelectorAll('[data-act=tag]').forEach(b=>{const on=D.desc.includes(b.dataset.t+'.');b.classList.toggle('on',on);b.setAttribute('aria-pressed',on)})}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.body.classList.contains('menu-open')){closeMenu();$('.menubtn')?.focus();return}
  if(e.key==='Escape'&&S.dlg){closeDlg();return}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('[data-pin],[data-go],g[data-act]')){e.preventDefault();e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}))}});

/* boot. In server mode the page shows a loading message, then the reports from the database, or an error with a retry button. */
const bootBox=(inner)=>pubShell(`<div class="wrap"><div class="glass" style="margin-top:46px">${inner}</div></div>`,'');
async function boot(){
  await API.init();                                    // 'demo' or 'server' (see js/config.js)
  if(API.mode==='server')$('#app').innerHTML=bootBox(`<div class="hint" role="status" aria-live="polite" aria-busy="true"><b>Loading reports…</b><span>Getting the latest reports from the server.</span></div>`);
  try{await Promise.all([loadReports(),loadInsights(),applyConnectivity()])}
  catch(err){
    $('#app').innerHTML=bootBox(`<div class="hint" role="alert"><b>Couldn't load the reports</b><span>${esc((err&&err.userMessage)||'Something went wrong while loading. Please try again.')}</span><button class="btn primary" data-act="retry-boot">Try again</button></div>`);
    return}
  S.reports.loadedAt=Date.now();
  render()}
boot();
