/* Hash router and render() for the PUBLIC site. The admin site has its own router in admin/js/admin-router.js. */

/* =========================================================
   7. ROUTER
   ========================================================= */
function render(keepScroll){
  const hash=location.hash,p=(hash.replace(/^#\/?/,'')||'home').split('/');let h;
  if(p[0]==='reports')p[0]='mine';   // the page is now called "Reports" (#/reports). #/mine still works for old links.
  if(p[0]==='report'&&S.prev!=='report'&&D.done)D=newDraft();     // start a fresh draft after a finished report
  const m={home:pageHome,report:pageReport,map:()=>pageMap(false),mine:pageMine};
  h=pubShell(p[0]==='track'?pageTrack(p[1]):(m[p[0]]||pageHome)(),p[0]==='track'?'reports':(m[p[0]]?(p[0]==='mine'?'reports':p[0]):'home'));
  const prevRoute=S.prev;S.prev=p[0];
  $('#app').innerHTML=h;if(!keepScroll)scrollTo(0,0);
  document.querySelectorAll('[data-go]').forEach(e=>{e.tabIndex=0;e.setAttribute('role','link')});
  syncMenu();
  if(p[0]==='mine'&&API.mode==='server'&&prevRoute!=='mine')loadMyReports(); // server mode: load this device's reports from GET /api/reports?mine=1
  if($('#wizMain'))wizRender();
  const q=$('#q');if(q)q.oninput=()=>{F().q=q.value;const k=q.selectionStart;render(true);const n=$('#q');n.focus();n.setSelectionRange(k,k)};
}
addEventListener('hashchange',()=>{closeDlg();render()});
