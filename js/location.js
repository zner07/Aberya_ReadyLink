/* LOCATION (Phase 3.5): where is the hazard?

   Four ways to choose the place, all feeding ONE draft location (D.lat, D.lng, D.x, D.y):
     1. "Use my current location"  real GPS (navigator.geolocation), asked only when the person presses the button
     2. Tap or drag the pin on the map, or move it with the arrow keys
     3. Search a place or address  through THIS server (see server/README.md, "Place search")
     4. The GPS position inside the photo  read on the device. It is only a SUGGESTION that must be confirmed.

   Rules this file keeps:
   - The same coordinate system everywhere: the constants in GEO (js/map-data.js) are the only ones. xyToLL() is geo() in map.js
     without rounding, and llToXY() is the same formula run backwards. The server uses the same constants (server/src/services/geo.js).
   - Nothing is ever replaced silently. GPS and search change the pin only when the person presses or picks something.
     The photo's position never changes the pin until the person presses "Use this location".
   - A place outside Brgy. Alangilan is never accepted. The server checks again, whatever this page says.
   - Nothing is invented: no result means no result, and the person can always tap the map.
   Uses these globals from other files: D, wizRender, toast, API, GEO, inPoly, mapSVG, brgyAt, readPhotoGps (js/exif.js). */

/* ---- coordinates ------------------------------------------------------------------------------------------------------ */
const MAP_W = 1000;
const MAP_H = 611;
const locRound6 = (n) => Math.round(n * 1e6) / 1e6;

/* map units (SVG) -> degrees. The same formula as geo() in map.js, but as numbers and without rounding. */
const xyToLL = (x, y) => ({ lat: GEO.la1 - (y - GEO.oy) / GEO.s / GEO.ky, lng: GEO.lo0 + (x - GEO.ox) / GEO.s / GEO.kx });

/* degrees -> map units (SVG). The inverse of xyToLL. */
const llToXY = (lat, lng) => ({ x: GEO.ox + (lng - GEO.lo0) * GEO.kx * GEO.s, y: GEO.oy + (GEO.la1 - lat) * GEO.ky * GEO.s });

/* Is this point inside the supported area, Brgy. Alangilan? (valid numbers, on the map, inside the boundary shape) */
function insideBrgy(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  const p = llToXY(lat, lng);
  return p.x >= 0 && p.x <= MAP_W && p.y >= 0 && p.y <= MAP_H && inPoly(p.x, p.y);
}

const LOC_SOURCES = { gps: 'your current location', map: 'a spot you chose on the map', search: 'a place you searched for', photo: 'the location stored in your photo' };

/* ---- the draft location -------------------------------------------------------------------------------------------------- */

/* Sets the draft location from degrees. Returns false (and changes nothing) when the point is outside Brgy. Alangilan. */
function setLocation(lat, lng, source, label = '') {
  if (!insideBrgy(lat, lng)) return false;
  const p = llToXY(lat, lng);
  D.lat = locRound6(lat);
  D.lng = locRound6(lng);
  D.x = Math.round(p.x * 100) / 100;
  D.y = Math.round(p.y * 100) / 100;
  D.locSource = source;
  D.locLabel = label;
  return true;
}

/* Same, from a point on the map picture. */
function setLocationFromXY(x, y, source) {
  if (!(x >= 0 && x <= MAP_W && y >= 0 && y <= MAP_H) || !inPoly(x, y)) return false;
  const g = xyToLL(x, y);
  return setLocation(g.lat, g.lng, source);
}

function clearLocation() {
  D.x = null;
  D.y = null;
  D.lat = null;
  D.lng = null;
  D.locSource = '';
  D.locLabel = '';
}

/* ---- 1. current location (GPS) --------------------------------------------------------------------------------------------- */
const GPS_MESSAGES = {
  denied: 'Location permission was denied. You can allow it in your browser settings, or choose the spot on the map or search for it.',
  unavailable: 'Your device could not work out its location. Choose the spot on the map or search for it.',
  timeout: 'Finding your location took too long. Try again, or choose the spot on the map.',
  unsupported: 'This browser cannot share its location. Choose the spot on the map or search for it.',
  insecure: 'Your browser only shares its location on secure pages (https:// or http://localhost). Choose the spot on the map or search for it.',
  other: 'Something went wrong while finding your location. Choose the spot on the map or search for it.',
};

/* Called only from the button. nav is injectable for tests. */
function useMyLocation(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (D.locating) return;
  if (!nav || !nav.geolocation) {
    D.gps = { state: 'unsupported', msg: GPS_MESSAGES.unsupported };
    wizRender();
    return;
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    D.gps = { state: 'insecure', msg: GPS_MESSAGES.insecure };
    wizRender();
    return;
  }
  const run = ++D.gpsRun;
  D.locating = true;
  D.gps = { state: 'locating', msg: '' };
  wizRender();
  nav.geolocation.getCurrentPosition(
    (pos) => {
      if (run !== D.gpsRun) return; // the person left or cancelled meanwhile
      D.locating = false;
      const { latitude, longitude, accuracy } = pos.coords;
      if (!insideBrgy(latitude, longitude)) {
        // Do NOT touch the pin the person may already have chosen.
        D.gps = { state: 'outside', msg: `Your current location (${latitude.toFixed(5)}, ${longitude.toFixed(5)}) is outside Brgy. Alangilan. Reports must be inside the barangay. If the hazard is inside it, search for it or tap it on the map.` };
      } else {
        setLocation(latitude, longitude, 'gps');
        const rough = Number.isFinite(accuracy) && accuracy > 150;
        D.gps = { state: 'ok', msg: rough ? `Location found, but it is only accurate to about ${Math.round(accuracy)} m. Drag the pin if it is not exactly right.` : '' };
      }
      wizRender();
    },
    (err) => {
      if (run !== D.gpsRun) return;
      D.locating = false;
      const kind = err && err.code === 1 ? 'denied' : err && err.code === 2 ? 'unavailable' : err && err.code === 3 ? 'timeout' : 'other';
      D.gps = { state: kind, msg: GPS_MESSAGES[kind] };
      wizRender();
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

/* ---- 3. place search (through the server) ---------------------------------------------------------------------------------- */
const SEARCH_MIN = 3;
const SEARCH_DELAY_MS = 500;
let searchTimer = null;

function locSearchTyped(value) {
  D.search.q = value;
  D.search.open = true;
  clearTimeout(searchTimer);
  if (!API.geocoder.typeahead) return paintSuggestions(); // this provider does not allow search-as-you-type: wait for the Search button
  if (value.trim().length < SEARCH_MIN) {
    D.search.seq += 1;
    D.search.state = 'idle';
    D.search.results = [];
    return paintSuggestions();
  }
  searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
  return undefined;
}

async function runSearch() {
  clearTimeout(searchTimer);
  const q = D.search.q.trim();
  if (q.length < SEARCH_MIN) {
    D.search.state = 'short';
    return paintSuggestions();
  }
  const mine = ++D.search.seq;
  D.search.state = 'loading';
  D.search.open = true;
  D.search.active = -1;
  paintSuggestions();
  try {
    const results = await API.searchPlaces(q);
    if (mine !== D.search.seq) return undefined; // an older search finished late: ignore it
    D.search.results = results;
    D.search.state = results.length ? 'ok' : 'empty';
  } catch (err) {
    if (mine !== D.search.seq) return undefined;
    D.search.results = [];
    D.search.state = 'error';
    D.search.msg = (err && err.userMessage) || 'Place search is not available right now.';
  }
  return paintSuggestions();
}

function pickPlace(i) {
  const place = D.search.results[i];
  if (!place) return;
  if (!setLocation(place.lat, place.lng, 'search', place.label)) {
    D.search.state = 'outside';
    paintSuggestions();
    return;
  }
  D.search.open = false;
  D.gps = { state: 'idle', msg: '' };
  wizRender();
}

const sugOption = (r, i) =>
  `<li role="presentation"><button type="button" role="option" id="locopt-${i}" class="sug ${r.inArea ? '' : 'out'} ${D.search.active === i ? 'on' : ''}" aria-selected="${D.search.active === i}" data-act="locpick" data-i="${i}">${esc(r.label)}<small>${r.inArea ? 'Inside Brgy. Alangilan' : 'Outside Brgy. Alangilan, cannot be used'}</small></button></li>`;

function suggestionsHTML() {
  const s = D.search;
  if (!s.open) return '';
  if (s.state === 'loading') return '<p class="small muted" role="status">Searching…</p>';
  if (s.state === 'short') return `<p class="small muted">Type at least ${SEARCH_MIN} characters.</p>`;
  if (s.state === 'empty') return '<p class="small muted">No matching place found. Tap the map to choose the spot yourself.</p>';
  if (s.state === 'outside') return '<p class="small muted">That place is outside Brgy. Alangilan. Choose a spot inside the barangay on the map.</p>';
  if (s.state === 'error') return `<p class="small muted" role="alert">${esc(s.msg)}${/\bmap\b/i.test(s.msg) ? '' : ' You can tap the map instead.'}</p>`; // the server's own message may already say so
  if (s.state === 'ok') return `<ul class="sugg">${s.results.map(sugOption).join('')}</ul>`;
  return '';
}

/* Updates only the suggestion list, so the text box keeps its focus and what was typed. */
function paintSuggestions() {
  const box = $('#locsug');
  if (box) box.innerHTML = suggestionsHTML();
  const input = $('#locq');
  if (input) {
    input.setAttribute('aria-expanded', String(D.search.open && D.search.state === 'ok'));
    if (D.search.active >= 0) input.setAttribute('aria-activedescendant', `locopt-${D.search.active}`);
    else input.removeAttribute('aria-activedescendant');
  }
}

function onSearchKey(e) {
  const s = D.search;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (s.state !== 'ok' || !s.results.length) return;
    e.preventDefault();
    const n = s.results.length;
    s.active = e.key === 'ArrowDown' ? (s.active + 1) % n : (s.active - 1 + n) % n;
    paintSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (s.state === 'ok' && s.active >= 0) pickPlace(s.active);
    else runSearch();
  } else if (e.key === 'Escape') {
    s.open = false;
    s.active = -1;
    paintSuggestions();
  }
}

function searchBoxHTML() {
  if (API.mode !== 'server') {
    return `<div class="note">${ic('info', 16)}<span>Place search needs the READYLINK server. You can still use your location or tap the map.</span></div>`;
  }
  if (!API.geocoder.enabled) {
    return `<div class="note">${ic('info', 16)}<span>Place search is turned off on this server. Use your location or tap the map.</span></div>`;
  }
  return `<div class="field locsearch"><label for="locq">Search a place or address</label>
    <div class="locq-wrap"><input type="search" id="locq" role="combobox" aria-autocomplete="list" aria-controls="locsug" aria-expanded="false" autocomplete="off" maxlength="100" placeholder="Street, school or landmark" value="${esc(D.search.q)}"><button type="button" class="btn ghost sm" data-act="locsearch">Search</button></div>
    <div id="locsug" role="listbox" aria-label="Place suggestions">${suggestionsHTML()}</div></div>`;
}

/* ---- 4. the photo's GPS position: a suggestion, never an automatic choice ------------------------------------------------- */

/* Reads the ORIGINAL file (before the page shrinks it, which drops the metadata). Returns a suggestion or null. Never throws. */
async function readExifSuggestion(file) {
  try {
    const buffer = file.arrayBuffer
      ? await file.arrayBuffer()
      : await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsArrayBuffer(file);
        });
    const gps = readPhotoGps(buffer);
    if (!gps) return null;
    return { lat: gps.lat, lng: gps.lng, inArea: insideBrgy(gps.lat, gps.lng), state: 'pending', label: '' };
  } catch (err) {
    return null;
  }
}

/* Asks the server for a readable name for the photo's position. Optional: without it the coordinates are shown. */
async function labelExifSuggestion() {
  const e = D.exif;
  if (!e || API.mode !== 'server' || !API.geocoder.enabled || !e.inArea) return;
  try {
    const place = await API.reversePlace(e.lat, e.lng);
    if (D.exif === e && place && place.label) {
      e.label = place.label;
      const typing = document.activeElement && document.activeElement.id === 'locq';
      if (!typing) wizRender();
    }
  } catch (err) {
    /* no name: the coordinates are enough */
  }
}

function acceptExif() {
  const e = D.exif;
  if (!e || e.state !== 'pending' || !e.inArea) return;
  if (setLocation(e.lat, e.lng, 'photo', e.label)) {
    e.state = 'accepted';
    D.gps = { state: 'idle', msg: '' };
    wizRender();
  }
}

function rejectExif() {
  if (D.exif && D.exif.state === 'pending') D.exif.state = 'dismissed';
  wizRender();
}

/* Step 1: a short, non-blocking note under the photo. */
function exifNoteHTML() {
  const e = D.exif;
  if (!e || e.state !== 'pending') return '';
  return `<div class="note" role="status">${ic('pin', 16)}<span><b>Photo location detected.</b> Please confirm this location in the next step. It is not used until you do.</span></div>`;
}

/* Step 2: the card where the person confirms or rejects it. */
function exifCardHTML() {
  const e = D.exif;
  if (!e || e.state !== 'pending') return '';
  const where = e.label ? `${esc(e.label)} <span class="faint">(${e.lat.toFixed(5)}, ${e.lng.toFixed(5)})</span>` : `${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}`;
  if (!e.inArea) {
    return `<div class="exifcard"><div class="note" role="status">${ic('pin', 16)}<span><b>Photo location detected, but it is outside Brgy. Alangilan</b> (${where}). It cannot be used for this report. Choose the location below.</span></div><div class="act"><button class="btn ghost sm" data-act="exif-reject">OK, choose another location</button></div></div>`;
  }
  return `<div class="exifcard"><div class="note" role="status">${ic('pin', 16)}<span><b>Photo location detected.</b> Please confirm this location: ${where}. The blue pin on the map shows it. It was read on your device. It is not used unless you confirm it, and the photo that is sent has this data removed.</span></div><div class="act"><button class="btn primary sm" data-act="exif-accept">Use this location</button><button class="btn ghost sm" data-act="exif-reject">Choose another location</button></div></div>`;
}

/* The suggested point for the map (a second, different pin), or null. */
function exifSuggestPoint() {
  const e = D.exif;
  if (!e || e.state !== 'pending' || !e.inArea) return null;
  return llToXY(e.lat, e.lng);
}

/* ---- step 2 of the report form --------------------------------------------------------------------------------------------- */
function locationStepHTML(cancel) {
  const has = D.x != null;
  const source = has && D.locSource ? `<p class="small muted" style="margin-top:-6px">Location set from ${LOC_SOURCES[D.locSource] || 'your choice'}${D.locLabel ? `: ${esc(D.locLabel)}` : ''}. Drag the pin, press the arrow keys, or tap the map to change it.</p>` : '';
  const gps = D.gps && D.gps.msg ? `<div class="note" role="status" aria-live="polite">${ic('info', 16)}<span>${esc(D.gps.msg)}</span></div>` : '';
  return `<div><h2 style="font-size:30px">Where is the hazard?</h2><p class="muted" style="margin-top:8px">Choose where you photographed it, even if you are somewhere else now. Use your location, search for a place, or tap the map.</p></div>
   ${exifCardHTML()}
   ${searchBoxHTML()}
   <div style="border-radius:18px;overflow:hidden;border:1px solid var(--line)">${mapSVG({ click: true, draft: has ? { x: D.x, y: D.y } : null, suggest: exifSuggestPoint() })}</div>
   <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="btn ghost sm" data-act="locate" ${D.locating ? 'disabled' : ''}>${ic('locate', 16)} ${D.locating ? 'Finding your location…' : 'Use my current location'}</button><span class="small ${has ? '' : 'faint'}">${has ? `${ic('pin', 14)} ${brgyAt(D.x, D.y)} · ${D.lat.toFixed(5)}, ${D.lng.toFixed(5)}` : 'No location selected'}</span>${has ? `<button class="linkbtn" style="padding:4px 6px;font-size:13px" data-act="clearpin">Clear pin</button>` : ''}</div>
   ${gps}${source}
   <div class="bar"><div style="display:flex;gap:4px;align-items:center"><button class="btn ghost" data-act="back">Back</button>${cancel}</div><button class="btn primary" data-act="next" ${has ? '' : 'disabled'}>Continue to details</button></div>`;
}

/* One line for the review step and anywhere else the chosen place is shown. */
function locationSummary() {
  if (D.x == null) return 'Not set';
  const text = `${brgyAt(D.x, D.y)} · ${D.lat.toFixed(5)}, ${D.lng.toFixed(5)}`;
  return D.locSource ? `${text} (from ${LOC_SOURCES[D.locSource] || 'your choice'})` : text;
}

/* ---- the map picture: drag the pin, move it with the keyboard ---------------------------------------------------------------- */
let justDragged = 0;
const locJustDragged = () => Date.now() - justDragged < 350; // the click that follows a drag must not place a second pin

function bindLocation() {
  const input = $('#locq');
  if (input) {
    input.oninput = () => locSearchTyped(input.value);
    input.onkeydown = onSearchKey;
    input.onfocus = () => {
      if (D.search.state !== 'idle') {
        D.search.open = true;
        paintSuggestions();
      }
    };
  }
  const svg = document.querySelector('#wizMain svg.pickable');
  if (!svg) return;
  const toXY = (e) => {
    const b = svg.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * MAP_W, y: ((e.clientY - b.top) / b.height) * MAP_H };
  };
  let drag = null;
  svg.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false }); // while dragging the pin, the page must not scroll
  svg.addEventListener('pointerdown', (e) => {
    const pin = e.target.closest && e.target.closest('.dpin');
    if (!pin) return;
    drag = { pin, last: null };
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toXY(e);
    if (!inPoly(p.x, p.y)) return; // the pin cannot leave Brgy. Alangilan
    drag.last = p;
    drag.pin.setAttribute('transform', `translate(${p.x} ${p.y})`);
  });
  const finish = () => {
    if (!drag) return;
    const last = drag.last;
    drag = null;
    justDragged = Date.now();
    if (last && setLocationFromXY(last.x, last.y, 'map')) {
      D.gps = { state: 'idle', msg: '' };
      wizRender();
    } else {
      wizRender(); // put the pin back where it was
    }
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
  svg.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 16 : 4;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!move) return;
    e.preventDefault();
    const from = D.x != null ? { x: D.x, y: D.y } : { x: 500, y: 300 }; // the first key press starts in the middle of the barangay
    const nx = D.x != null ? from.x + move[0] : from.x;
    const ny = D.x != null ? from.y + move[1] : from.y;
    if (setLocationFromXY(nx, ny, 'map')) {
      D.gps = { state: 'idle', msg: '' };
      wizRender();
      const again = document.querySelector('#wizMain svg.pickable');
      if (again) again.focus();
    }
  });
}
