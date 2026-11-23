/* Safety net: show a helpful message if index.html is opened without its css/ and js/ folders. */
(function(){
  var cssOk = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== '';
  var jsOk = typeof render === 'function';
  if (cssOk && jsOk) return;

  document.body.innerHTML =
    '<div class="load-error">' +
      '<h1>READYLINK could not load its files</h1>' +
      '<p>index.html needs the <b>css</b> and <b>js</b> folders next to it.</p>' +
      '<p>If you opened it from inside the .zip: close this tab, right-click the zip, choose <b>Extract All</b>, then open <b>index.html</b> from the extracted folder.</p>' +
      '<p class="load-error-local">Kung galing sa loob ng zip ang pagbukas: i-right-click ang zip, piliin ang <b>Extract All</b>, tapos buksan ang index.html sa bagong folder.</p>' +
    '</div>';
})();
