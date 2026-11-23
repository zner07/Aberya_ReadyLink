'use strict';
/* The place-search proxy with a FAKE map service. No test here ever touches the internet. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGeocoder, MIN_GAP_MS, MAX_RESULTS } = require('../../src/services/geocoder');
const { errorBody } = require('../../src/middleware/errors');
const { geo } = require('../helpers/env');

const cfg = (extra = {}) => ({ geocoder: { provider: 'photon', url: null, contact: 'team@example.org', timeoutMs: 1000, ...extra } });
const okJson = (body) => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const photon = (...features) => ({ features: features.map(([lng, lat, props]) => ({ geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props })) });
const INSIDE = [121.06668, 13.78285];
const OUTSIDE = [121.2, 13.9];

function make({ provider = 'photon', handler, clock = { t: 1_000_000 }, extra } = {}) {
  const calls = [];
  const sleeps = [];
  const fetchFn = async (url, opts) => { calls.push({ url, headers: opts.headers }); return handler(url, opts, calls.length); };
  const geocoder = createGeocoder({ config: cfg({ provider, ...extra }), geo, fetchFn, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; } });
  return { geocoder, calls, sleeps, clock };
}
const code = (err) => errorBody(err).body.error.code;

test('photon: asks for places near Alangilan and answers { label, lat, lng, inArea }', async () => {
  const { geocoder, calls } = make({ handler: () => okJson(photon([...INSIDE, { name: 'Alangilan Elementary School', street: 'Main St', housenumber: '5', city: 'Batangas City' }], [...OUTSIDE, { name: 'Far Away Place' }])) });
  const { results } = await geocoder.search('alangilan school');
  assert.deepEqual(results.map((r) => r.inArea), [true, false], 'each result says whether it is inside the barangay');
  assert.equal(results[0].label, 'Alangilan Elementary School, Main St 5, Batangas City');
  assert.deepEqual(Object.keys(results[0]).sort(), ['inArea', 'label', 'lat', 'lng']);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://photon.komoot.io');
  assert.equal(url.searchParams.get('q'), 'alangilan school');
  assert.equal(url.searchParams.get('limit'), String(MAX_RESULTS));
  const [minLng, minLat, maxLng, maxLat] = url.searchParams.get('bbox').split(',').map(Number);
  assert.ok(minLng < 121.06 && maxLng > 121.07 && minLat < 13.78 && maxLat > 13.78, 'the search is limited to the area around Alangilan');
  assert.ok(maxLng - minLng < 0.1 && maxLat - minLat < 0.1, 'and it is a small area');
});

test('the request identifies the app and asks for English, and sends nothing about the user', async () => {
  const { geocoder, calls } = make({ handler: () => okJson(photon()) });
  await geocoder.search('anything here');
  assert.match(calls[0].headers['User-Agent'], /^READYLINK\/3\.5 .*team@example\.org/);
  assert.equal(calls[0].headers['Accept-Language'], 'en');
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Accept', 'Accept-Language', 'User-Agent'], 'no cookies, no client id, no user data');
});

test('nominatim: bounded to the area and the Philippines, and typeahead is NOT offered', async () => {
  const { geocoder, calls } = make({ provider: 'nominatim', handler: () => okJson([{ lat: '13.78285', lon: '121.06668', display_name: 'Alangilan, Batangas City, Calabarzon, Philippines' }]) });
  assert.equal(geocoder.typeahead, false);
  const { results } = await geocoder.search('alangilan');
  assert.equal(results[0].label, 'Alangilan, Batangas City, Calabarzon, Philippines');
  assert.equal(results[0].inArea, true);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://nominatim.openstreetmap.org');
  assert.equal(url.searchParams.get('bounded'), '1');
  assert.equal(url.searchParams.get('countrycodes'), 'ph');
  assert.ok(url.searchParams.get('viewbox'));
});

test('typeahead is only offered for photon, and a custom address can be used', async () => {
  assert.equal(make({ handler: () => okJson(photon()) }).geocoder.typeahead, true);
  const { geocoder, calls } = make({ extra: { url: 'http://localhost:2322' }, handler: () => okJson(photon()) });
  await geocoder.search('abc');
  assert.ok(calls[0].url.startsWith('http://localhost:2322/api/?'));
});

test('no match is an EMPTY list. Nothing is invented', async () => {
  const { geocoder } = make({ handler: () => okJson(photon()) });
  assert.deepEqual(await geocoder.search('zzzzqqq nowhere'), { results: [] });
  const nom = make({ provider: 'nominatim', handler: () => okJson([]) });
  assert.deepEqual(await nom.geocoder.search('zzzzqqq nowhere'), { results: [] });
});

test('bad provider data is dropped, not passed on: missing or impossible coordinates, odd labels', async () => {
  const features = photon([...INSIDE, { name: 'Good place' }], [500, 500, { name: 'Impossible' }], [NaN, 13.78, { name: 'NaN' }], [121.06, 'x', { name: 'Text' }]);
  features.features.push({ properties: { name: 'No geometry' } }, null, { geometry: { coordinates: 'nope' } }, { geometry: { coordinates: [121.066, 13.782] }, properties: { name: `Long\nname ${'x'.repeat(500)}\u0007` } });
  const { geocoder } = make({ handler: () => okJson(features) });
  const { results } = await geocoder.search('place');
  assert.equal(results.length, 2);
  assert.equal(results[0].label, 'Good place');
  assert.ok(results[1].label.length <= 160 && !/[\n\u0007]/.test(results[1].label));
});

test('at most 6 results are returned', async () => {
  const many = photon(...Array.from({ length: 20 }, (_, i) => [121.0666 + i * 0.00001, 13.7828, { name: `P${i}` }]));
  const { geocoder } = make({ handler: () => okJson(many) });
  assert.equal((await geocoder.search('place')).results.length, MAX_RESULTS);
});

test('the typed text is cleaned and checked: 3 to 100 characters, text only', async () => {
  const { geocoder, calls } = make({ handler: () => okJson(photon()) });
  for (const bad of ['', 'ab', '  a  ', 'x'.repeat(101), undefined, null, 5, {}, ['abc']]) {
    await assert.rejects(() => geocoder.search(bad), (e) => errorBody(e).status === 400 && code(e) === 'VALIDATION', String(bad).slice(0, 10));
  }
  assert.equal(calls.length, 0, 'bad input never reaches the map service');
  await geocoder.search('  alangilan \u0000 school\n ');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'alangilan school');
});

test('the same search twice asks the map service once (cache), and the cache expires', async () => {
  const { geocoder, calls, clock } = make({ handler: () => okJson(photon([...INSIDE, { name: 'X' }])) });
  await geocoder.search('Alangilan');
  await geocoder.search('alangilan');
  assert.equal(calls.length, 1);
  clock.t += 11 * 60 * 1000;
  await geocoder.search('alangilan');
  assert.equal(calls.length, 2);
});

test('requests are spaced at least 1.1 seconds apart (the public services ask for one per second)', async () => {
  const { geocoder, calls, sleeps } = make({ handler: () => okJson(photon()) });
  await Promise.all([geocoder.search('aaa one'), geocoder.search('bbb two'), geocoder.search('ccc three')]);
  assert.equal(calls.length, 3);
  assert.ok(sleeps.length >= 2 && sleeps.every((ms) => ms >= MIN_GAP_MS - 5), JSON.stringify(sleeps));
});

test('too many waiting searches get "busy" (429) instead of piling up', async () => {
  const release = [];
  const { geocoder } = make({ handler: () => new Promise((resolve) => release.push(() => resolve(okJson(photon())))) });
  const first = Array.from({ length: 3 }, (_, i) => geocoder.search(`query ${i}`).catch((e) => e));
  await new Promise((r) => setImmediate(r));
  const overflow = await geocoder.search('one too many').catch((e) => e);
  assert.equal(errorBody(overflow).status, 429);
  assert.equal(code(overflow), 'GEOCODER_BUSY');
  while (release.length) { release.shift()(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(first);
});

test('when the map service fails, the answer is one clean message that points to the map', async () => {
  const handlers = [
    () => { throw new Error('ECONNREFUSED secret-internal-detail'); },
    () => ({ ok: false, status: 503, text: async () => 'down' }),
    () => okJson('<html>not json</html>'),
    () => okJson('x'.repeat(600000)),
    () => ({ ok: true, status: 200, text: async () => { throw new Error('boom'); } }),
  ];
  for (const handler of handlers) {
    const { geocoder } = make({ handler });
    await assert.rejects(() => geocoder.search('alangilan'), (e) => {
      assert.equal(errorBody(e).status, 502);
      assert.equal(code(e), 'GEOCODER_UNAVAILABLE');
      assert.match(errorBody(e).body.error.message, /choose the location on the map/);
      assert.doesNotMatch(errorBody(e).body.error.message, /ECONNREFUSED|secret-internal-detail|html/);
      return true;
    });
  }
});

test('a map service that never answers is given up on after the timeout', async () => {
  const { geocoder } = make({ extra: { timeoutMs: 40 }, handler: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const started = Date.now();
  await assert.rejects(() => geocoder.search('alangilan'), (e) => code(e) === 'GEOCODER_UNAVAILABLE');
  assert.ok(Date.now() - started < 1500);
});

test('turned off: nothing is sent anywhere and the answer says so', async () => {
  const { geocoder, calls } = make({ provider: 'off', handler: () => okJson(photon()) });
  assert.equal(geocoder.enabled, false);
  await assert.rejects(() => geocoder.search('alangilan'), (e) => errorBody(e).status === 503 && code(e) === 'GEOCODER_OFF');
  await assert.rejects(() => geocoder.reverse(13.78, 121.06), (e) => code(e) === 'GEOCODER_OFF');
  assert.equal(calls.length, 0);
});

test('reverse: a name for a position near Alangilan, with inArea', async () => {
  const { geocoder, calls } = make({ handler: () => okJson(photon([...INSIDE, { name: 'Alangilan Barangay Hall', city: 'Batangas City' }])) });
  const out = await geocoder.reverse(13.78285, 121.06668);
  assert.deepEqual(out, { label: 'Alangilan Barangay Hall, Batangas City', lat: 13.78285, lng: 121.06668, inArea: true });
  assert.ok(calls[0].url.includes('/reverse?'));
});

test('reverse: far from Alangilan the map service is NOT asked at all (this is not a general geocoder)', async () => {
  const { geocoder, calls } = make({ handler: () => okJson(photon([...INSIDE, { name: 'X' }])) });
  assert.deepEqual(await geocoder.reverse(14.5995, 120.9842), { label: null, lat: 14.5995, lng: 120.9842, inArea: false });
  assert.deepEqual(await geocoder.reverse(13.9, 121.2), { label: null, lat: 13.9, lng: 121.2, inArea: false });
  assert.equal(calls.length, 0);
});

test('reverse: invalid numbers are refused; an unnamed place gives a null label', async () => {
  const { geocoder } = make({ handler: () => okJson(photon([...INSIDE, {}])) });
  for (const [lat, lng] of [[NaN, 121], ['13', '121'], [91, 121], [13, 181], [undefined, undefined], [null, null]]) {
    await assert.rejects(() => geocoder.reverse(lat, lng), (e) => errorBody(e).status === 400, `${lat},${lng}`);
  }
  assert.equal((await geocoder.reverse(13.78285, 121.06668)).label, null);
});
