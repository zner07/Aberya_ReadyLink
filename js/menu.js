/* Mobile menu (<= 620px): CSS shows it only on small screens. Shared by the public site and the admin site. */
function syncMenu(){const open=document.body.classList.contains('menu-open'),b=$('.menubtn'),m=$('#mmenu'),n=$('.nav')||$('.side');
  if(b)b.setAttribute('aria-expanded',open);if(open&&m&&n)m.style.top=(n.getBoundingClientRect().bottom+8)+'px'}
function setMenu(open){document.body.classList.toggle('menu-open',open);syncMenu();if(open){const f=$('#mmenu .mi');if(f)f.focus({preventScroll:true})}}
function closeMenu(){if(document.body.classList.contains('menu-open'))setMenu(false)}
addEventListener('hashchange',closeMenu);
addEventListener('resize',()=>{if(innerWidth>620)closeMenu();else syncMenu()});
addEventListener('scroll',()=>{if(document.body.classList.contains('menu-open'))syncMenu()},{passive:true});
