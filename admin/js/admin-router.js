/* Hash router and render() for the ADMIN site.

   Addresses (after /admin/):  #/login   #/overview   #/reports   #/report/RL-001   #/map
   Every page except #/login needs a signed-in admin. The SERVER is what really protects the data (HttpOnly session
   cookie checked on every request); this router only decides which screen to show. */
function render(keepScroll){
  const hash=location.hash,p=(hash.replace(/^#\/?/,'')||'overview').split('/');let h;
  if(p[0]==='login'){
    if(S.admin){goto('#/overview');return}
    h=loginShell(pageLogin());                                              // the Admin sign in page
  }else if(!S.admin){S.next=hash;goto('#/login');return}                    // every other page needs a sign-in
  else{
    const k=['overview','reports','report','map'].includes(p[0])?p[0]:'overview';
    if(k==='reports')h=pageReports();else if(k==='report')h=pageReview(p[1]);else if(k==='map')h=pageMap(true);else h=pageOverview();
    h=admShell(adminStateBox()||h,k==='report'?'reports':k)}
  const prevRoute=S.prev;S.prev=p[0];
  $('#app').innerHTML=h;if(!keepScroll)scrollTo(0,0);
  document.querySelectorAll('[data-go]').forEach(e=>{e.tabIndex=0;e.setAttribute('role','link')});
  syncMenu();
  if(p[0]!=='login'&&S.admin&&API.mode==='server'&&prevRoute===null)ensureAdminSession().then(ok=>{if(ok&&Date.now()-S.reports.loadedAt>3000)loadAdminReports()}); // first admin page after opening /admin/: check the login is still valid, then get fresh reports
  const q=$('#q');if(q)q.oninput=()=>{F().q=q.value;const k=q.selectionStart;render(true);const n=$('#q');n.focus();n.setSelectionRange(k,k)};
  const lf=$('#lf');if(lf)lf.onsubmit=async e=>{e.preventDefault();const err=$('#lerr'),b=$('#lbtn');
    if(!$('#em').value.trim()||!$('#pw').value){err.textContent='Enter your username and password.';err.hidden=false;return}
    b.disabled=true;b.textContent='Signing in…';err.hidden=true;const res=await API.signIn($('#em').value.trim(),$('#pw').value);
    if(!res.ok){err.textContent=res.message||'Sign in failed.';err.hidden=false;b.disabled=false;b.textContent='Sign in';const pw=$('#pw');if(pw&&res.clearPassword)pw.value='';return}
    S.admin=true;const n=S.next;S.next=null;goto(n&&!n.startsWith('#/login')&&n!=='#/overview'?n:'#/overview');if(API.mode==='server')loadAdminReports()} // just signed in: show fresh reports
}
addEventListener('hashchange',()=>{closeDlg();render()});
