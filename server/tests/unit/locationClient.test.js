'use strict';
/* js/location.js: choosing the hazard location. The REAL page code runs in a sandbox with stand-ins for the screen and the browser
   (navigator.geolocation, the server API). Nothing here needs a browser or a network. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFrontend, fakeFetch, reply, plain } = require('../helpers/frontend');
const { buildTiff, jpegWith } = require('../helpers/exif');
const fixtures = require('../helpers/exifFixtures');
const { geo, FRONTEND_DIR } = require('../helpers/env');

const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const INSIDE = { lat: 13.78285, lng: 121.06668 };
const OUTSIDE = { lat: 14.5995, lng: 120.9842 }; // Manila

/* A page with a fresh draft (D), and stand-ins for wizRender, toast, $, ic, document. */
function page({ geocoder } = {}) {
  const renders = [];
  const toasts = [];
  const fe = loadFrontend({
    config: { API_MODE: 'server' },
    fetch: fakeFetch(() => reply(200, {})),
    globals: { wizRender: () => renders.push(1), toast: (m) => toasts.push(m), $: () => null, ic: () => '', document: { activeElement: null, querySelector: () => null }, window: undefined },
  });
  const run = (code) => vm.runInContext(code, fe.sandbox);
  run(/const newDraft=[^\n]*\n/.exec(read('js/state.js'))[0]);
  run(/const esc=[^\n]*\n/.exec(read('js/utils.js'))[0]);
  run('var D = newDraft();');
  run("API.mode = 'server';"); // these tests are about the connected app; the demo case sets its own mode
  if (geocoder) run(`API.geocoder = ${JSON.stringify(geocoder)};`);
  return { fe, run, renders, toasts, D: () => plain(run('D')) };
}
const navigatorFor = (behaviour) => ({ geolocation: { getCurrentPosition: (ok, fail, options) => behaviour(ok, fail, options) } });

/* ---------------- coordinates: one system, everywhere ---------------- */

test('xyToLL is geo() from map.js without the rounding, and llToXY is its exact inverse', () => {
  const { run } = page();
  for (let x = 0; x <= 1000; x += 37) {
    for (let y = 0; y <= 611; y += 41) {
      const ll = plain(run(`xyToLL(${x}, ${y})`));
      const shown = plain(run(`geo(${x}, ${y})`));
      assert.equal(shown.lat, ll.lat.toFixed(5));
      assert.equal(shown.lng, ll.lng.toFixed(5));
      const back = plain(run(`llToXY(${ll.lat}, ${ll.lng})`));
      assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.y - y) < 1e-6, `${x},${y}`);
    }
  }
});

test('the page and the server convert with the SAME numbers (no second coordinate system)', () => {
  const { run } = page();
  for (let x = 0; x <= 1000; x += 53) {
    for (let y = 0; y <= 611; y += 47) {
      const page = plain(run(`xyToLL(${x}, ${y})`));
      const server = geo.xyToLatLng(x, y);
      assert.ok(Math.abs(page.lat - server.lat) < 1e-9 && Math.abs(page.lng - server.lng) < 1e-9, `${x},${y}`);
      const back = geo.latLngToXy(page.lat, page.lng);
      const pageXY = plain(run(`llToXY(${page.lat}, ${page.lng})`));
      assert.ok(Math.abs(back.x - pageXY.x) < 1e-6 && Math.abs(back.y - pageXY.y) < 1e-6);
    }
  }
});

test('"inside Brgy. Alangilan" is the same answer on the page and on the server (checked on a 4,000 point grid)', () => {
  const { run } = page();
  let same = 0;
  let total = 0;
  let insideCount = 0;
  for (let x = 0; x <= 1000; x += 10) {
    for (let y = 0; y <= 611; y += 10) {
      const ll = geo.xyToLatLng(x, y);
      const pageSays = run(`insideBrgy(${ll.lat}, ${ll.lng})`);
      const serverSays = geo.isInsideBoundary(ll.lat, ll.lng);
      total += 1;
      same += pageSays === serverSays ? 1 : 0;
      insideCount += serverSays ? 1 : 0;
    }
  }
  assert.ok(insideCount > 300, 'the grid really covers the barangay');
  assert.ok(same / total > 0.998, `${same}/${total}`);
});

test('insideBrgy refuses anything that is not a real point', () => {
  const { run } = page();
  assert.equal(run(`insideBrgy(${INSIDE.lat}, ${INSIDE.lng})`), true);
  for (const code of ['insideBrgy(NaN, 121)', 'insideBrgy(13, Infinity)', "insideBrgy('13.78', '121.06')", 'insideBrgy(null, null)', 'insideBrgy(undefined, 1)', 'insideBrgy(91, 121)', 'insideBrgy(13, 181)', `insideBrgy(${OUTSIDE.lat}, ${OUTSIDE.lng})`, 'insideBrgy({}, [])']) assert.equal(run(code), false, code);
});

/* ---------------- the draft location ---------------- */

test('setLocation fills lat, lng, x, y and the source; outside the barangay it changes nothing', () => {
  const { run, D } = page();
  assert.equal(run(`setLocation(${INSIDE.lat}, ${INSIDE.lng}, 'search', 'A school')`), true);
  const d = D();
  assert.deepEqual([d.lat, d.lng, d.locSource, d.locLabel], [INSIDE.lat, INSIDE.lng, 'search', 'A school']);
  assert.ok(Math.abs(d.x - 500) < 0.5 && Math.abs(d.y - 300) < 0.5);
  assert.equal(run(`setLocation(${OUTSIDE.lat}, ${OUTSIDE.lng}, 'gps')`), false);
  assert.deepEqual([D().lat, D().lng, D().locSource], [INSIDE.lat, INSIDE.lng, 'search'], 'the earlier choice is still there');
});

test('a tap on the map becomes real coordinates too (lat/lng are always filled)', () => {
  const { run, D } = page();
  assert.equal(run("setLocationFromXY(500, 300, 'map')"), true);
  assert.ok(D().lat > 13.7 && D().lng > 121.0 && D().locSource === 'map');
  assert.equal(run("setLocationFromXY(5, 5, 'map')"), false, 'a tap outside the barangay is refused');
  assert.equal(run("setLocationFromXY(NaN, 5, 'map')"), false);
  assert.equal(run("setLocationFromXY(1500, 300, 'map')"), false);
});

test('clearLocation forgets everything about the chosen place', () => {
  const { run, D } = page();
  run(`setLocation(${INSIDE.lat}, ${INSIDE.lng}, 'gps')`);
  run('clearLocation()');
  assert.deepEqual([D().x, D().y, D().lat, D().lng, D().locSource], [null, null, null, null, '']);
});

/* ---------------- 1. current location (GPS) ---------------- */

test('GPS is never asked for by itself: loading the page does not call it, and only ONE place in the page code can', () => {
  let asked = 0;
  loadFrontend({ config: { API_MODE: 'demo' }, fetch: fakeFetch(() => reply(200, {})), globals: { navigator: { geolocation: { getCurrentPosition: () => { asked += 1; }, watchPosition: () => { asked += 1; } } } } });
  assert.equal(asked, 0);
  const all = fs.readdirSync(path.join(FRONTEND_DIR, 'js')).map((f) => [f, read(`js/${f}`)]);
  const uses = all.filter(([, text]) => /getCurrentPosition|watchPosition/.test(text)).map(([f]) => f);
  assert.deepEqual(uses, ['location.js'], 'only location.js uses the device location');
  assert.equal((read('js/location.js').match(/getCurrentPosition/g) || []).length, 1, 'and only inside useMyLocation');
  assert.doesNotMatch(read('js/location.js'), /watchPosition/, 'the position is read once, never followed');
  assert.match(read('js/events.js'), /if\(k==='locate'\)useMyLocation\(\)/, 'it is called only from the button');
});

test('GPS inside Alangilan: the pin is set from the device position', () => {
  const { fe, run, D, renders } = page();
  fe.sandbox.nav = navigatorFor((ok) => ok({ coords: { latitude: INSIDE.lat, longitude: INSIDE.lng, accuracy: 12 } }));
  run('useMyLocation(nav)');
  assert.deepEqual([D().lat, D().lng, D().locSource, D().locating], [INSIDE.lat, INSIDE.lng, 'gps', false]);
  assert.equal(D().gps.msg, '', 'no warning for a good fix');
  assert.ok(renders.length >= 2, 'the screen was redrawn (finding... then done)');
});

test('GPS asks for a good fix, with a time limit', () => {
  const { fe, run } = page();
  let options;
  fe.sandbox.nav = navigatorFor((ok, fail, o) => { options = o; });
  run('useMyLocation(nav)');
  assert.equal(options.enableHighAccuracy, true);
  assert.ok(options.timeout >= 5000 && options.timeout <= 20000);
});

test('a rough GPS fix still works but the person is told to check the pin', () => {
  const { fe, run, D } = page();
  fe.sandbox.nav = navigatorFor((ok) => ok({ coords: { latitude: INSIDE.lat, longitude: INSIDE.lng, accuracy: 480 } }));
  run('useMyLocation(nav)');
  assert.equal(D().locSource, 'gps');
  assert.match(D().gps.msg, /accurate to about 480 m/);
});

test('GPS outside Alangilan: a clear message and the existing pin is NOT touched', () => {
  const { fe, run, D } = page();
  run("setLocationFromXY(500, 300, 'map')");
  const before = { lat: D().lat, lng: D().lng, x: D().x };
  fe.sandbox.nav = navigatorFor((ok) => ok({ coords: { latitude: OUTSIDE.lat, longitude: OUTSIDE.lng, accuracy: 20 } }));
  run('useMyLocation(nav)');
  assert.deepEqual([D().lat, D().lng, D().x], [before.lat, before.lng, before.x]);
  assert.equal(D().locSource, 'map');
  assert.match(D().gps.msg, /outside Brgy\. Alangilan/);
  assert.equal(D().gps.state, 'outside');
});

test('GPS errors each get their own plain message, and the pin is untouched', () => {
  for (const [code, state, pattern] of [[1, 'denied', /permission was denied/], [2, 'unavailable', /could not work out/], [3, 'timeout', /too long/], [99, 'other', /Something went wrong/]]) {
    const { fe, run, D } = page();
    fe.sandbox.nav = navigatorFor((ok, fail) => fail({ code }));
    run('useMyLocation(nav)');
    assert.equal(D().gps.state, state);
    assert.match(D().gps.msg, pattern);
    assert.equal(D().locating, false, 'the button is usable again');
    assert.equal(D().x, null);
  }
});

test('GPS on a browser without it, or on an insecure page: a message, no crash', () => {
  let { run, D } = page();
  run('useMyLocation({})');
  assert.equal(D().gps.state, 'unsupported');
  run('useMyLocation(null)');
  assert.equal(D().gps.state, 'unsupported');
  ({ run, D } = page());
  run('var window = { isSecureContext: false };');
  run('useMyLocation({ geolocation: { getCurrentPosition: () => { throw new Error("must not be called"); } } })');
  assert.equal(D().gps.state, 'insecure');
});

test('pressing the button twice while it is working does nothing extra', () => {
  const { fe, run } = page();
  let calls = 0;
  fe.sandbox.nav = navigatorFor(() => { calls += 1; });
  run('useMyLocation(nav)');
  run('useMyLocation(nav)');
  assert.equal(calls, 1);
});

test('an answer that arrives after the person left or cancelled is ignored', () => {
  const { fe, run, D } = page();
  let deliver;
  fe.sandbox.nav = navigatorFor((ok) => { deliver = ok; });
  run('useMyLocation(nav)');
  run('D.gpsRun += 1; D.locating = false;'); // the person left the step
  deliver({ coords: { latitude: INSIDE.lat, longitude: INSIDE.lng, accuracy: 5 } });
  assert.equal(D().x, null);
});

/* ---------------- 3. place search ---------------- */

const fakePlaces = (results) => { const calls = []; return { calls, searchPlaces: async (q) => { calls.push(q); return typeof results === 'function' ? results(q) : results; } }; };
const spot = (label, ll = INSIDE, inArea = true) => ({ label, lat: ll.lat, lng: ll.lng, inArea });

test('search: results are listed, and picking one inside the barangay sets the pin (source "search")', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  const places = fakePlaces([spot('Alangilan Barangay Hall')]);
  fe.API.searchPlaces = places.searchPlaces;
  run("D.search.q = 'alangilan'");
  await run('runSearch()');
  assert.equal(D().search.state, 'ok');
  assert.equal(D().search.results.length, 1);
  run('pickPlace(0)');
  assert.deepEqual([D().lat, D().lng, D().locSource, D().locLabel], [INSIDE.lat, INSIDE.lng, 'search', 'Alangilan Barangay Hall']);
  assert.equal(D().search.open, false);
});

test('search: no match says so and invents nothing; the map stays the fallback', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.API.searchPlaces = fakePlaces([]).searchPlaces;
  run("D.search.q = 'qqqqzzzz'");
  await run('runSearch()');
  assert.equal(D().search.state, 'empty');
  assert.equal(D().x, null, 'no pin was invented');
  assert.match(run('suggestionsHTML()'), /No matching place found\. Tap the map/);
});

test('search: a result outside the barangay can be seen but not used, and the pin is untouched', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  run("setLocationFromXY(500, 300, 'map')");
  fe.API.searchPlaces = fakePlaces([spot('Manila', OUTSIDE, false)]).searchPlaces;
  run("D.search.q = 'manila'");
  await run('runSearch()');
  assert.match(run('suggestionsHTML()'), /Outside Brgy\. Alangilan, cannot be used/);
  run('pickPlace(0)');
  assert.equal(D().locSource, 'map', 'still the earlier pin');
  assert.equal(D().search.state, 'outside');
  assert.match(run('suggestionsHTML()'), /outside Brgy\. Alangilan\. Choose a spot inside the barangay/);
});

test('search: even if the server wrongly says a far place is inside, the page checks again', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.API.searchPlaces = fakePlaces([spot('Liar', OUTSIDE, true)]).searchPlaces;
  run("D.search.q = 'liar'");
  await run('runSearch()');
  run('pickPlace(0)');
  assert.equal(D().x, null);
});

test('search: a failure is one readable message and does not break the form', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.API.searchPlaces = async () => { const e = new Error('x'); e.userMessage = 'Place search is not available right now.'; throw e; };
  run("D.search.q = 'alangilan'");
  await run('runSearch()');
  assert.equal(D().search.state, 'error');
  assert.match(run('suggestionsHTML()'), /Place search is not available right now\. You can tap the map instead\./);
});

test('search: an error message that already points to the map is not repeated', async () => {
  const { fe, run } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.API.searchPlaces = async () => { const e = new Error('x'); e.userMessage = 'Place search is not available right now. You can choose the location on the map instead.'; throw e; };
  run("D.search.q = 'alangilan'");
  await run('runSearch()');
  const html = run('suggestionsHTML()');
  assert.equal((html.match(/map instead/g) || []).length, 1, html);
});

test('search: too-short text is not sent', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  const places = fakePlaces([spot('x')]);
  fe.API.searchPlaces = places.searchPlaces;
  run("D.search.q = 'ab '");
  await run('runSearch()');
  assert.equal(places.calls.length, 0);
  assert.equal(D().search.state, 'short');
});

test('search: an older search that finishes late cannot replace a newer one', async () => {
  const { fe, run, D } = page({ geocoder: { enabled: true, typeahead: true } });
  const gates = [];
  fe.API.searchPlaces = (q) => new Promise((resolve) => gates.push(() => resolve([spot(`result for ${q}`)])));
  run("D.search.q = 'first query'");
  const first = run('runSearch()');
  run("D.search.q = 'second query'");
  const second = run('runSearch()');
  gates[1](); await second;
  gates[0](); await first;
  assert.equal(D().search.results[0].label, 'result for second query');
});

test('search: names from the map service are escaped, so a hostile name cannot add HTML to the page', async () => {
  const { fe, run } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.API.searchPlaces = fakePlaces([spot('<img src=x onerror=alert(1)> & "quotes"')]).searchPlaces;
  run("D.search.q = 'hostile'");
  await run('runSearch()');
  const html = run('suggestionsHTML()');
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'));
});

test('search: typing starts a search after a pause when the provider allows it, and never when it does not', async () => {
  let page1 = page({ geocoder: { enabled: true, typeahead: true } });
  const places = fakePlaces([spot('x')]);
  page1.fe.API.searchPlaces = places.searchPlaces;
  page1.run("locSearchTyped('alang')");
  assert.equal(places.calls.length, 0, 'not at once');
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(places.calls, ['alang'], 'after the pause');

  const page2 = page({ geocoder: { enabled: true, typeahead: false } });
  const places2 = fakePlaces([spot('x')]);
  page2.fe.API.searchPlaces = places2.searchPlaces;
  page2.run("locSearchTyped('alangilan')");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(places2.calls.length, 0, 'typeahead is off: only the Search button searches');
});

test('the search box tells the truth in demo mode and when search is turned off', () => {
  const demo = page();
  demo.run("API.mode = 'demo'");
  assert.match(demo.run('searchBoxHTML()'), /needs the READYLINK server/);
  const off = page({ geocoder: { enabled: false, typeahead: false } });
  assert.match(off.run('searchBoxHTML()'), /turned off on this server/);
  const on = page({ geocoder: { enabled: true, typeahead: true } });
  assert.match(on.run('searchBoxHTML()'), /id="locq"/);
});

/* ---------------- 4. photo GPS (EXIF): a suggestion, never an automatic choice ---------------- */

const fileOf = (buf) => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });

test('a photo with GPS inside Alangilan gives a PENDING suggestion with the position', async () => {
  const { run, fe } = page();
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  const sug = plain(await run('readExifSuggestion(file)'));
  assert.equal(sug.state, 'pending');
  assert.equal(sug.inArea, true);
  assert.ok(Math.abs(sug.lat - fixtures.LAT) < 1e-5 && Math.abs(sug.lng - fixtures.LNG) < 1e-5);
});

test('a photo without GPS, an unreadable file and a file that throws all give null', async () => {
  const { run, fe } = page();
  for (const file of [fileOf(fixtures.buffer('jpegNoGps')), fileOf(fixtures.buffer('jpegNoExif')), fileOf(Buffer.from('not an image')), { arrayBuffer: async () => { throw new Error('disk error'); } }]) {
    fe.sandbox.file = file;
    assert.equal(await run('readExifSuggestion(file)'), null);
  }
});

test('a photo taken outside Alangilan is detected but marked as unusable', async () => {
  const { run, fe, D } = page();
  fe.sandbox.file = fileOf(jpegWith(buildTiff(OUTSIDE)));
  run('D.exif = null');
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  assert.equal(fe.sandbox.sug.inArea, false);
  run('D.exif = sug');
  assert.match(run('exifCardHTML()'), /outside Brgy\. Alangilan/);
  assert.ok(!run('exifCardHTML()').includes('data-act="exif-accept"'), 'there is no way to accept it');
  run('acceptExif()');
  assert.equal(D().x, null);
  assert.equal(run('exifSuggestPoint()'), null, 'and no marker is drawn');
});

test('NEVER silent: when a photo suggestion arrives, the person\'s existing location is not changed', async () => {
  const { run, fe, D } = page();
  run("setLocationFromXY(300, 200, 'map')");
  const before = { lat: D().lat, lng: D().lng, x: D().x, y: D().y, source: D().locSource };
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  run('D.exif = sug');
  assert.deepEqual([D().lat, D().lng, D().x, D().y, D().locSource], [before.lat, before.lng, before.x, before.y, before.source]);
  assert.equal(D().exif.state, 'pending');
});

test('NEVER silent: with no location chosen yet, a photo suggestion still does not set one', async () => {
  const { run, fe, D } = page();
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  run('D.exif = sug');
  assert.equal(D().x, null);
  assert.equal(D().lat, null);
});

test('"Use this location" applies the photo position (source "photo"); "Choose another location" dismisses it and changes nothing', async () => {
  for (const choice of ['accept', 'reject']) {
    const { run, fe, D } = page();
    run("setLocationFromXY(300, 200, 'map')");
    const before = { lat: D().lat, lng: D().lng };
    fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
    fe.sandbox.sug = await run('readExifSuggestion(file)');
    run('D.exif = sug');
    run(choice === 'accept' ? 'acceptExif()' : 'rejectExif()');
    if (choice === 'accept') {
      assert.deepEqual([D().lat, D().lng, D().locSource, D().exif.state], [fixtures.LAT, fixtures.LNG, 'photo', 'accepted']);
    } else {
      assert.deepEqual([D().lat, D().lng, D().locSource, D().exif.state], [before.lat, before.lng, 'map', 'dismissed']);
      assert.equal(run('exifSuggestPoint()'), null);
      assert.equal(run('exifCardHTML()'), '', 'the card goes away');
    }
  }
});

test('the person can still change the location after accepting the photo position', async () => {
  const { run, fe, D } = page();
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  run('D.exif = sug; acceptExif()');
  run("setLocationFromXY(600, 350, 'map')");
  assert.equal(D().locSource, 'map');
});

test('the confirm card says what it found, that it is not used until confirmed, and the marker is drawn at the photo position', async () => {
  const { run, fe } = page();
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  run('D.exif = sug');
  const card = run('exifCardHTML()');
  assert.match(card, /Photo location detected\. <\/b>|Photo location detected\./);
  assert.match(card, /Please confirm this location/);
  assert.match(card, /not used unless you confirm it/);
  assert.match(card, /13\.78285, 121\.06668/);
  assert.ok(card.includes('data-act="exif-accept"') && card.includes('data-act="exif-reject"'));
  assert.match(run('exifNoteHTML()'), /Photo location detected\..*not used until you do/);
  const point = plain(run('exifSuggestPoint()'));
  assert.ok(Math.abs(point.x - 500) < 1 && Math.abs(point.y - 300) < 1);
  assert.match(run('mapSVG({ click: true, suggest: exifSuggestPoint() })'), /class="spin"/);
});

test('a readable name for the photo position is asked from the server only when search is available, and a failure is harmless', async () => {
  const { run, fe, D } = page({ geocoder: { enabled: true, typeahead: true } });
  fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  fe.sandbox.sug = await run('readExifSuggestion(file)');
  run('D.exif = sug');
  fe.API.reversePlace = async () => ({ label: 'Alangilan Barangay Hall', inArea: true });
  await run('labelExifSuggestion()');
  assert.equal(D().exif.label, 'Alangilan Barangay Hall');
  const second = page({ geocoder: { enabled: true, typeahead: true } });
  second.fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  second.fe.sandbox.sug = await second.run('readExifSuggestion(file)');
  second.run('D.exif = sug');
  second.fe.API.reversePlace = async () => { throw new Error('offline'); };
  await second.run('labelExifSuggestion()');
  assert.equal(second.D().exif.label, '');
  const off = page({ geocoder: { enabled: false, typeahead: false } });
  off.fe.sandbox.file = fileOf(fixtures.buffer('jpegGps'));
  off.fe.sandbox.sug = await off.run('readExifSuggestion(file)');
  off.run('D.exif = sug');
  let asked = 0;
  off.fe.API.reversePlace = async () => { asked += 1; return { label: 'x' }; };
  await off.run('labelExifSuggestion()');
  assert.equal(asked, 0);
});

/* ---------------- the step and the summary ---------------- */

test('the location step offers all the ways to choose, and Continue only works once a place is chosen', () => {
  const { run } = page({ geocoder: { enabled: true, typeahead: true } });
  run("API.mode = 'server'");
  let html = run("locationStepHTML('')");
  for (const text of ['Where is the hazard?', 'Use my current location', 'Search a place or address', 'No location selected', 'tap the map']) assert.ok(html.includes(text), text);
  assert.match(html, /data-act="next" disabled/);
  run("setLocationFromXY(500, 300, 'map')");
  html = run("locationStepHTML('')");
  assert.doesNotMatch(html, /data-act="next" disabled/);
  assert.match(html, /13\.78\d{3}, 121\.06\d{3}/);
  assert.match(html, /Location set from a spot you chose on the map/);
});

test('locationSummary shows the place, the coordinates and where they came from', () => {
  const { run } = page();
  assert.equal(run('locationSummary()'), 'Not set');
  run(`setLocation(${INSIDE.lat}, ${INSIDE.lng}, 'photo')`);
  assert.equal(run('locationSummary()'), 'Brgy. Alangilan · 13.78285, 121.06668 (from the location stored in your photo)');
});
