/* Admin pages: sign in, Overview, Reports, Report review. (Sign-in is a demo gate only.) */

/* =========================================================
   6. ADMIN PAGES  (sign-in is a demo gate only)
   ========================================================= */
function pageLogin(){
  const server=API.mode==='server',off=server&&API.adminInfo&&API.adminInfo.configured===false,lock=off?'disabled':'';
  const notice=off?`<div class="note" role="status">${ic('info',16)}<span><b>Admin login is not set up on this server yet.</b> Ask the person who runs the server to run <code>npm.cmd run admin:setup</code> in the server folder, then restart the server.</span></div>`
    :server?'':`<div class="note" role="status">${ic('info',16)}<span><b>Demo mode.</b> This copy of the app has no server, so sign-in is simulated, any details work, and nothing is protected. The real admin login only exists on the READYLINK server.</span></div>`;
  return `<div class="wrap"><div class="login"><form class="glass lcard" id="lf" novalidate><a class="logo" href="#/home">${LOGO}<span>READYLINK</span></a><div><h2 style="font-size:32px">Admin sign in</h2><p class="muted small" style="margin-top:8px">For barangay and LGU disaster risk staff.</p></div>
  ${notice}
  <div class="field"><label for="em">Username</label><input type="text" id="em" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="100" ${lock}></div>
  <div class="field"><label for="pw">Password</label><div class="pwwrap"><input type="password" id="pw" autocomplete="current-password" maxlength="200" ${lock}><button type="button" class="pwtoggle" data-act="togglepw" aria-label="Show password" aria-pressed="false" aria-controls="pw" ${lock}>${ic('eye',20)}</button></div></div>
  <p class="small" id="lerr" style="color:var(--hi)" role="alert" hidden></p>
  <button class="btn primary" style="justify-content:center" type="submit" id="lbtn" ${lock}>Sign in</button></form></div></div>`}
/* "Reports to prioritize": DEMO list from API.getPriorityQueue(). Not an AI result (see js/demo-insights.js). */
function priorityBox(){
  const rows=PRIORITY.map(p=>({p,r:R.find(x=>x.id===p.id)})).filter(x=>x.r&&x.r.st!=='Resolved').slice(0,4);
  return `<div class="glass box pq"><h3><span>Reports to prioritize<span class="demotag">Demo data</span></span><a class="btn ghost sm" href="#/admin/reports">All reports</a></h3>
  <p class="small muted pq-note">Sample ordering written by hand for this prototype. No AI model is connected yet, so this is not an AI result.</p>
  <div class="pq-list">${rows.map(({p,r},i)=>`<div class="pq-row" data-go="#/admin/report/${r.id}"><span class="pq-n">${i+1}</span><div class="pq-t"><b>${esc(title(r))}</b><small>${cat(r)}, ${r.brgy}</small></div><span class="pq-lv"><span class="lv ${p.level}">${LV[p.level]} priority</span></span><p class="pq-why">${esc(p.reason)}</p><a class="btn ghost sm pq-go" href="#/admin/report/${r.id}" aria-label="Review ${esc(title(r))}">Review</a></div>`).join('')||'<div class="hint">No sample items to show.</div>'}</div></div>`}
function pageOverview(){
  const c=x=>R.filter(x).length,pend=R.filter(r=>r.st==='Pending').sort(byLevel).slice(0,5);
  const cc=CATS.map(k=>[k,R.filter(r=>cat(r)===k).length]),mx=Math.max(1,...cc.map(x=>x[1]));
  const bg=Object.entries(LV).map(([k,v])=>[v,R.filter(r=>r.lv===k&&r.st!=='Resolved')]);
  return `<div class="ph-head" style="padding-top:8px"><div><h1 style="font-size:clamp(32px,4vw,48px)">Overview</h1><p class="muted">Reports waiting for review and where risks are concentrated.</p></div><a class="btn primary" href="#/admin/reports">${ic('list',16)} Open all reports</a></div>
  <div class="glass stats"><div><b>${c(r=>r.st==='Pending')}</b><span>Waiting for review</span></div><div><b style="color:var(--hi)">${c(r=>r.lv==='hi'&&r.st!=='Resolved')}</b><span>High-risk and open</span></div><div><b>${c(r=>r.st==='Under monitoring')}</b><span>Under monitoring</span></div><div><b>${c(r=>r.st==='Resolved')}</b><span>Resolved</span></div></div>
  ${priorityBox()}
  <div class="agrid"><div class="glass box"><h3>Review queue<a class="btn ghost sm" href="#/admin/reports">See all</a></h3><div class="tbl">${pend.map(r=>`<div class="tr q" data-go="#/admin/report/${r.id}"><span class="id">${r.id}</span><div class="t">${photo(r)}<span>${esc(title(r))}</span></div><span class="hm muted">${r.brgy}</span>${lvB(r.lv)}${ic('chev',16)}</div>`).join('')||'<div class="hint">Nothing waiting for review.</div>'}</div></div>
  <div class="stack"><div class="glass box"><h3>Reports by category</h3><div class="hbar">${cc.map(([k,n])=>`<div><span><b>${k}</b><span class="muted">${n}</span></span><i><b style="width:${n/mx*100}%"></b></i></div>`).join('')}</div></div>
  <div class="glass box"><h3>Open risks by level</h3><div class="hbar">${bg.map(([b,l])=>`<div><span><b>${b}</b><span class="muted">${l.length} open</span></span><span style="justify-content:flex-start;gap:6px">${l.map(r=>`<a href="#/admin/report/${r.id}" class="lv ${r.lv}" style="padding:0;width:10px;height:10px;border-radius:50%;background:var(--${r.lv})" title="${esc(title(r))} (${r.id})" aria-label="${esc(title(r))}"></a>`).join('')||'<span class="faint small">None</span>'}</span></div>`).join('')}</div></div></div></div>`}
function pageReports(){const f=F(),L=filtered().sort(byLevel);
  return `<div class="ph-head" style="padding-top:8px"><div><h1 style="font-size:clamp(32px,4vw,48px)">Reports</h1><p class="muted">Review, verify, monitor and resolve.</p></div>${API.mode==='server'?`<button class="btn ghost sm" data-act="refresh-admin">Refresh</button>`:''}</div>
  <div class="mapbar"><div style="position:relative;flex:1;min-width:200px;max-width:320px"><input type="search" id="q" placeholder="Search reports" value="${esc(f.q)}" style="padding-left:38px;border-radius:999px"><span style="position:absolute;left:13px;top:11px;color:var(--ink3)">${ic('search',16)}</span></div>
  <select data-f="lv" aria-label="Level"><option value="all">Level: all</option>${Object.entries(LV).map(([k,v])=>`<option value="${k}" ${f.lv===k?'selected':''}>${v}</option>`).join('')}</select>
  <select data-f="cat" aria-label="Category"><option value="all">Category: all</option>${CATS.map(o=>`<option ${f.cat===o?'selected':''}>${o}</option>`).join('')}</select>
  <select data-f="st" aria-label="Status"><option value="all">Status: all</option>${STS.map(o=>`<option ${f.st===o?'selected':''}>${o}</option>`).join('')}</select>${isFiltered()?`<button class="linkbtn" style="padding:6px 8px" data-act="clear">Clear filters</button>`:''}<span class="muted small" style="margin-left:auto">${L.length} of ${R.length}</span></div>
  <div class="glass box" style="padding:12px 18px"><div class="tbl" id="tb"><div class="tr th"><span>ID</span><span>Report</span><span class="hm">Category</span><span class="hm">Location</span><span>AI risk</span><span class="hm">Status</span><span></span></div>${L.map(r=>`<div class="tr" data-go="#/admin/report/${r.id}"><span class="id">${r.id}</span><div class="t">${photo(r)}<span>${esc(title(r))}</span></div><span class="hm">${cat(r)}</span><span class="hm muted">${r.brgy}</span>${lvB(r.lv)}<span class="hm">${stB(r.st)}</span>${ic('chev',16)}</div>`).join('')||(R.length?`<div class="hint">No reports match these filters.<button class="btn ghost sm" data-act="clear">Clear filters</button></div>`:`<div class="hint"><b>No reports yet</b><span>Reports sent from the public site will appear here.</span></div>`)}</div></div>`}
/* Server mode only: shown only when the server has switched admin changes off (ADMIN_WRITES). Signing in is already required. */
function adminNote(){
  if(API.mode!=='server'||API.adminWrites!==false)return '';
  return `<div class="note" style="margin-bottom:14px">${ic('info',16)}<span>Admin changes are turned off on this server.</span></div>`}

/* Server mode: a loading or error box that replaces the admin page while the reports are (re)loading. Empty when all is fine. */
function adminStateBox(){
  if(API.mode!=='server')return '';
  if(S.reports.state==='loading')return `<div class="glass" style="margin-top:30px"><div class="hint" role="status" aria-live="polite" aria-busy="true"><b>Loading reports…</b><span>Getting the latest reports from the server.</span></div></div>`;
  if(S.reports.state==='error')return `<div class="glass" style="margin-top:30px"><div class="hint" role="alert"><b>Couldn't load the reports</b><span>${esc(S.reports.message)}</span><button class="btn primary" data-act="retry-admin">Try again</button></div></div>`;
  return ''}

function pageReview(id){const r=R.find(x=>x.id===id);
  if(!r)return `<div class="glass" style="margin-top:30px"><div class="hint"><b>Report not found</b><a class="btn primary" href="#/admin/reports">Back to reports</a></div></div>`;
  const nx=['Verify report','Start monitoring','Mark as resolved','Resolved'][si(r)];
  const busy=S.adminBusy,off=API.mode==='server'&&API.adminWrites===false,lock=busy||off?'disabled':'',draft=S.remarkDraft&&S.remarkDraft.id===r.id?S.remarkDraft.text:'';
  return `<div class="ph-head" style="padding-top:8px"><div><div class="crumb"><a href="#/admin/reports">Reports</a>${ic('chev',12)}<span>${r.id}</span></div><h1 style="font-size:clamp(30px,3.8vw,44px)">${esc(title(r))}</h1><p class="muted" style="margin-top:8px">${r.brgy}, submitted ${r.date}</p></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${lvB(r.lv)}${stB(r.st)}<a class="btn ghost sm" href="#/admin/reports">Back to reports</a></div></div>
  <div class="review"><div class="stack"><div class="glass" style="padding:14px;display:grid;gap:16px">${photo(r)}<p style="padding:0 6px"><span class="faint small" style="display:block;margin-bottom:4px">Resident’s note</span>${esc(r.desc)||'<span class="faint">No description.</span>'}</p></div>
  <div class="glass" style="padding:10px"><div style="border-radius:16px;overflow:hidden;border:1px solid var(--line)">${mapSVG({list:R.filter(x=>x.id!==r.id&&plottable(x)&&plottable(r)&&Math.hypot(x.x-r.x,x.y-r.y)<260).concat(r).filter(plottable),sel:r.id})}</div><p class="small muted" style="padding:10px 6px 2px">${coords(r)}</p></div></div>
  <div class="stack"><div class="glass box"><h3>${esc(assessmentLabel(r))}</h3><dl class="kv">
<div><dt>Category</dt><dd>${esc(cat(r))}</dd></div>
${r.type==='other'?`<div><dt>Hazard name</dt><dd>${esc(title(r))}</dd></div>`:''}
<div><dt>Suggested level</dt><dd>${lvB(r.lv||r.ai)}</dd></div>
<div><dt>Reason</dt><dd>${esc(aiReason(r))}</dd></div>
</dl><div class="note" style="margin-top:14px">${ic('spark',16)}<span>Preliminary assessment only. Admin review is required; this is not a verified finding.</span></div></div>
  <div class="glass box"><h3>Your decision</h3>${adminNote()}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="field"><label for="fs">Status</label><select id="fs" data-act="status" ${lock}>${STS.map(s=>`<option ${r.st===s?'selected':''}>${s}</option>`).join('')}</select></div>
  <div class="field"><label for="fl">Final risk level</label><select id="fl" data-act="level" ${lock}>${Object.entries(LV).map(([k,v])=>`<option value="${k}" ${r.lv===k?'selected':''}>${v}</option>`).join('')}</select></div></div>
  <div class="field" style="margin:14px 0"><label for="nt">Admin remarks</label><textarea id="nt" style="min-height:84px" placeholder="Optional. Visible to the reporter." ${lock}>${esc(draft)}</textarea></div>
  <div class="act"><button class="btn primary" data-act="advance" data-id="${r.id}" ${si(r)===3||lock?'disabled':''}>${busy?'Saving…':nx}</button><button class="btn ghost" data-act="remark" data-id="${r.id}" ${lock}>Save remark</button></div></div>
  <div class="glass box"><h3>Activity</h3>${tlHTML(r)}</div></div></div>`}
