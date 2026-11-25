/* Page shells for the ADMIN site: the sign-in page frame and the signed-in sidebar layout.
   There is no link to the admin site anywhere on the public site, and no public navigation in here either. */

/* Frame around the Admin sign in page (and the start-up loading message): logo and theme button only. */
function loginShell(inner){
  return `<header class="nav glass"><a class="logo" href="#/login">${LOGO}<span>READYLINK</span></a>
  <div class="tail" style="margin-left:auto">${themeBtn()}</div></header>
  <main>${inner}</main>`}

function admShell(inner,on){
  const open=R.filter(r=>r.st==='Pending').length;
  const L=[['overview','Overview','grid'],['reports','Reports','list'],['map','Risk map','map']];
  return `<div class="adm"><aside class="side glass"><a class="logo" href="#/overview">${LOGO}<span>READYLINK</span></a>
  ${L.map(([k,t,i])=>`<a class="it ${on===k?'on':''}" href="#/${k}">${ic(i,18)}${t}${k==='reports'&&open?`<b>${open}</b>`:''}</a>`).join('')}
  <div class="sp"></div><a class="it" href="../index.html">${ic('globe',18)}Public site</a>
  <div class="it" style="padding:6px 12px;display:flex">${themeBtn()}</div>
  <div class="me"><div class="av">LG</div><div style="line-height:1.3"><b>LGU Admin</b><div class="faint small">Disaster risk office</div></div><button class="iconbtn" style="margin-left:auto;width:32px;height:32px" data-act="logout" aria-label="Sign out">${ic('out',15)}</button></div>
  <button class="iconbtn menubtn" data-act="menu" aria-label="Menu" aria-expanded="false" aria-controls="mmenu"><span class="ic-open">${ic('menu',19)}</span><span class="ic-close">${ic('x',19)}</span></button></aside>
  <main class="amain">${inner}</main></div>
  <div class="nav-scrim" data-act="menu-close"></div>
  <nav class="mmenu glass" id="mmenu" aria-label="Admin menu">${L.map(([k,t,i])=>`<a href="#/${k}" class="mi ${on===k?'on':''}">${ic(i,18)}<span style="flex:1">${t}</span>${k==='reports'&&open?`<b class="mbadge">${open}</b>`:''}</a>`).join('')}
   <a href="../index.html" class="mi sep">${ic('globe',18)}<span>Public site</span></a>
   <button class="mi" data-act="theme">${ic(theme()==='dark'?'sun':'moon',18)}<span>${theme()==='dark'?'Switch to light theme':'Switch to dark theme'}</span></button>
   <button class="mi" data-act="logout">${ic('out',18)}<span>Sign out</span></button></nav>`}
