/* Page shell for the PUBLIC site: navbar + mobile menu + footer. The admin site has its own shell in admin/js/admin-shell.js. */

/* =========================================================
   4. SHELLS
   ========================================================= */
function pubShell(inner,on){
  const L=[['home','Home'],['report','Report a risk'],['map','Risk map'],['reports','Reports']];
  return `<header class="nav glass"><a class="logo" href="#/home">${LOGO}<span>READYLINK</span></a>
  <nav class="links" aria-label="Main">${L.map(([k,t])=>`<a href="#/${k}" class="${on===k?'on':''}">${t}</a>`).join('')}</nav>
  <div class="tail">${themeBtn()}</div>
  <button class="iconbtn menubtn" data-act="menu" aria-label="Menu" aria-expanded="false" aria-controls="mmenu"><span class="ic-open">${ic('menu',19)}</span><span class="ic-close">${ic('x',19)}</span></button></header>
  <div class="nav-scrim" data-act="menu-close"></div>
  <nav class="mmenu glass" id="mmenu" aria-label="Menu">${L.map(([k,t])=>`<a href="#/${k}" class="mi ${on===k?'on':''}">${t==='Report a risk'?'Report a Risk':t==='Risk map'?'Risk Map':t}</a>`).join('')}
   <button class="mi sep" data-act="theme">${ic(theme()==='dark'?'sun':'moon',18)}<span>${theme()==='dark'?'Switch to light theme':'Switch to dark theme'}</span></button></nav>
  <main>${inner}</main>
  <div class="wrap"><footer><span>READYLINK. Prototype area: Brgy. Alangilan, Batangas City. ${API.mode==='server'?'Reports are saved in the READYLINK database on this computer. AI results, admin actions and offline sync are still demo.':'Demo data is saved in this browser only.'}</span><span style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">· AI suggests. Admins verify.<button class="linkbtn" style="padding:0;font-size:13px" data-act="simoffline" aria-pressed="${NET.sim}">Simulate offline: ${NET.sim?'on':'off'} (demo)</button>${API.mode==='server'?'':'<button class="linkbtn" style="padding:0;font-size:13px" data-act="reset">Reset demo data</button>'}</span></footer></div>`}
