/* Hash router and render(). */

/* =========================================================
   7. ROUTER
   ========================================================= */
function render(keepScroll){
  const hash=location.hash,p=(hash.replace(/^#\/?/,'')||'home').split('/');let h;
  if(p[0]==='reports')p[0]='mine';   // the page is now called "Reports" (#/reports). #/mine still works for old links.
  if(p[0]==='report'&&S.prev!=='report'&&D.done)D=newDraft();     // start a fresh draft after a finished report
  if(p[0]==='admin'){
    if(p[1]==='login'){if(S.admin){goto('#/admin');return}h=pubShell(pageLogin(),'')}   // the dedicated Admin Login page
    else if(!S.admin){S.next=hash;goto('#/admin/login');return}                          // every other admin page needs a sign-in
    else{const k=p[1]?'admin/'+p[1]:'admin';
      if(p[1]==='reports')h=pageReports();else if(p[1]==='report')h=pageReview(p[2]);else if(p[1]==='map')h=pageMap(true);else h=pageOverview();
      h=admShell(adminStateBox()||h,p[1]==='report'?'admin/reports':k)}
  }else{
    const m={home:pageHome,report:pageReport,map:()=>pageMap(false),mine:pageMine};
    h=pubShell(p[0]==='track'?pageTrack(p[1]):(m[p[0]]||pageHome)(),p[0]==='track'?'reports':(m[p[0]]?(p[0]==='mine'?'reports':p[0]):'home'))}
  const prevRoute=S.prev;S.prev=p[0];
  $('#app').innerHTML=h;if(!keepScroll)scrollTo(0,0);
  document.querySelectorAll('[data-go]').forEach(e=>{e.tabIndex=0;e.setAttribute('role','link')});
  syncMenu();
  if(p[0]==='admin'&&S.admin&&API.mode==='server'&&prevRoute!=='admin')ensureAdminSession().then(ok=>{if(ok&&Date.now()-S.reports.loadedAt>3000)loadAdminReports()}); // entering the admin pages: check the login is still valid, then get fresh reports
  if(p[0]==='mine'&&API.mode==='server'&&prevRoute!=='mine')loadMyReports(); // server mode: load this device's reports from GET /api/reports?mine=1
  if($('#wizMain'))wizRender();
  const q=$('#q');if(q)q.oninput=()=>{F().q=q.value;const k=q.selectionStart;render(true);const n=$('#q');n.focus();n.setSelectionRange(k,k)};
  const lf=$('#lf');if(lf)lf.onsubmit=async e=>{e.preventDefault();const err=$('#lerr'),b=$('#lbtn');
    if(!$('#em').value.trim()||!$('#pw').value){err.textContent='Enter your username and password.';err.hidden=false;return}
    b.disabled=true;b.textContent='Signing in…';err.hidden=true;const res=await API.signIn($('#em').value.trim(),$('#pw').value);
    if(!res.ok){err.textContent=res.message||'Sign in failed.';err.hidden=false;b.disabled=false;b.textContent='Sign in';const pw=$('#pw');if(pw&&res.clearPassword)pw.value='';return}
    S.admin=true;const n=S.next;S.next=null;goto(n&&!n.startsWith('#/admin/login')&&n!=='#/admin'?n:'#/admin');if(API.mode==='server')loadAdminReports()} // just signed in: show fresh reports
}
addEventListener('hashchange',()=>{closeDlg();render()});
