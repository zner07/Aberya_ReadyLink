'use strict';
/* Report locations, photo GPS and place search over real HTTP. The map service is a FAKE: no test touches the internet.
   Needs the dependencies installed first:   cd server   then   npm.cmd install   */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

try {
  require('express');
} catch (err) {
  throw new Error('Express is not installed. Open a terminal in the "server" folder and run:  npm.cmd install');
}

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db');
const { seedSamples } = require('../../src/services/seedService');
const { createGeocoder } = require('../../src/services/geocoder');
const { loadExifReader } = require('../helpers/frontend');
const { buildTiff, jpegWith, pngWith, webpWith } = require('../helpers/exif');
const fixtures = require('../helpers/exifFixtures');
const images = require('../helpers/images');
const { geo, FRONTEND_DIR, CLIENT_A, CLIENT_B, testConfig, removeDir } = require('../helpers/env');

const readGps = loadExifReader();
const JSON_HEADERS = { 'content-type': 'application/json' };
const INSIDE = { lat: 13.78285, lng: 121.06668 };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hasText = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

async function startApp(env = {}, { fetchFn } = {}) {
  const { dir, config } = testConfig(env);
  const db = openDatabase(config.dbFile, { driver: config.dbDriver });
  seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
  const calls = [];
  const geocoder = createGeocoder({ config, geo, fetchFn: fetchFn && (async (url, o) => { calls.push(url); return fetchFn(url, o); }), now: Date.now, sleep: async () => {} });
  const server = createApp(config, { db, geo, geocoder }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const request = (method, rawPath, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const h = { ...headers };
      if (payload) h['content-length'] = payload.length;
      const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString(), json: /application\/json/.test(res.headers['content-type'] || '') ? JSON.parse(bytes.toString()) : undefined });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  const post = (body, clientId = CLIENT_A) => request('POST', '/api/reports', { headers: { ...JSON_HEADERS, 'x-client-id': clientId }, body });
  const close = async () => {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    removeDir(dir);
  };
  return { request, post, close, calls, config, dir };
}
const report = (extra = {}) => ({ type: 'drain', desc: 'Blocked drain.', level: 'hi', ...extra });
const photoUrl = (buf, mime) => images.dataUrlFromBuffer(buf, mime);

/* ---------------- locations ---------------- */

test('a report with real coordinates (GPS, search or photo) is saved with exactly those coordinates', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.post(report({ lat: 13.7828512345, lng: 121.0666812345 }));
  assert.equal(r.status, 201);
  const saved = r.json.report;
  assert.equal(saved.lat, 13.782851);
  assert.equal(saved.lng, 121.066681);
  assert.ok(Math.abs(saved.x - 500) < 1 && Math.abs(saved.y - 300) < 1, 'x and y are calculated by the server with the shared constants');
  const again = (await app.request('GET', `/api/reports/${saved.id}`)).json.report;
  assert.deepEqual([again.lat, again.lng, again.x, again.y], [saved.lat, saved.lng, saved.x, saved.y]);
  const listed = (await app.request('GET', '/api/reports')).json.reports.find((x) => x.id === saved.id);
  assert.deepEqual([listed.x, listed.y], [saved.x, saved.y], 'the Community Risk Map list carries the same map position');
});

test('the old way (a tap on the map, x and y) still works exactly as before', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.post(report({ x: 500, y: 300 }));
  assert.equal(r.status, 201);
  assert.ok(Math.abs(r.json.report.x - 500) < 0.5 && Math.abs(r.json.report.y - 300) < 0.5);
});

test('the same spot sent three ways (tap, GPS, search) lands on the same place on the map', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const tap = (await app.post(report({ x: 500, y: 300 }))).json.report;
  const gps = (await app.post(report({ lat: tap.lat, lng: tap.lng }))).json.report;
  assert.ok(Math.abs(tap.x - gps.x) < 0.1 && Math.abs(tap.y - gps.y) < 0.1);
});

test('a place outside Brgy. Alangilan is refused with a clear message, and nothing is saved', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const spot of [{ lat: 14.5995, lng: 120.9842 }, { lat: 13.9, lng: 121.2 }, { x: 5, y: 5 }, { lat: 0.5, lng: 0.5 }]) {
    const r = await app.post(report(spot));
    assert.equal(r.status, 400, JSON.stringify(spot));
    assert.equal(r.json.error.fields.location, 'That spot is outside Brgy. Alangilan.');
  }
  assert.equal((await app.request('GET', '/api/reports')).json.reports.length, 12);
});

test('bad or half-sent coordinates are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const spot of [{ lat: 13.78 }, { lng: 121.06 }, { lat: '13.78', lng: '121.06' }, { lat: 91, lng: 121 }, { lat: 13, lng: 181 }, { lat: null, lng: null }, {}, { lat: [13], lng: [121] }]) {
    const r = await app.post(report(spot));
    assert.equal(r.status, 400, JSON.stringify(spot));
    assert.ok(r.json.error.fields.location, JSON.stringify(spot));
  }
});

test('the server does not trust the page: lat/lng win over x/y, so bad x/y cannot move a report', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.post(report({ ...INSIDE, x: 5, y: 5 }));
  assert.equal(r.status, 201);
  assert.ok(Math.abs(r.json.report.x - 500) < 1);
});

test('the 12 existing sample reports are untouched by all of this', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.post(report({ lat: INSIDE.lat, lng: INSIDE.lng }));
  const samples = (await app.request('GET', '/api/reports')).json.reports.filter((r) => /^RL-0(2[3-9]|3[0-4])$/.test(r.id));
  assert.equal(samples.length, 12);
  const flood = samples.find((r) => r.id === 'RL-023');
  assert.deepEqual([flood.x, flood.y, flood.st], [355, 81, 'Verified']);
});

/* ---------------- photos and their hidden GPS ---------------- */

test('a photo WITH GPS metadata uploads fine, and the public photo has NO GPS or camera data left', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const [name, mime] of [['jpegGps', 'image/jpeg'], ['pngGps', 'image/png'], ['webpGps', 'image/webp']]) {
    const original = fixtures.buffer(name);
    assert.ok(readGps(original), `${name} really has GPS`);
    const r = await app.post(report({ ...INSIDE, photo: photoUrl(original, mime) }));
    assert.equal(r.status, 201, name);
    const served = await app.request('GET', r.json.report.img);
    assert.equal(served.status, 200);
    assert.equal(readGps(served.bytes), null, `${name}: no GPS in the served photo`);
    for (const text of ['TestCam', 'Model X', '2026:10:12', 'Exif']) assert.ok(!hasText(served.bytes, text), `${name}: "${text}"`);
    assert.ok(served.bytes.length > 100, 'and it is still a picture');
  }
});

test('the API answers never carry EXIF, camera or GPS-from-the-photo fields', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.post(report({ ...INSIDE, photo: photoUrl(fixtures.buffer('jpegGps'), 'image/jpeg') }));
  const all = JSON.stringify([r.json, (await app.request('GET', '/api/reports')).json, (await app.request('GET', `/api/reports/${r.json.report.id}`)).json]);
  for (const word of ['exif', 'Exif', 'EXIF', 'camera', 'TestCam', 'make', 'model', 'GPSLatitude', 'altitude', 'orientation']) assert.ok(!all.includes(word), word);
});

test('the photo GPS never decides the report location: the confirmed coordinates are what is saved', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.post(report({ lat: 13.7803, lng: 121.0615, photo: photoUrl(fixtures.buffer('jpegGps'), 'image/jpeg') })); // a different spot than the photo's
  assert.equal(r.status, 201);
  assert.equal(r.json.report.lat, 13.7803);
  assert.equal(r.json.report.lng, 121.0615);
});

test('photos without GPS still upload: no EXIF at all, EXIF without GPS, a plain PNG, a plain WebP', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const [buf, mime] of [[fixtures.buffer('jpegNoExif'), 'image/jpeg'], [fixtures.buffer('jpegNoGps'), 'image/jpeg'], [images.buffer('png'), 'image/png'], [images.buffer('webp'), 'image/webp'], [images.buffer('jpeg'), 'image/jpeg']]) {
    const r = await app.post(report({ ...INSIDE, photo: photoUrl(buf, mime) }));
    assert.equal(r.status, 201, mime);
    assert.equal((await app.request('GET', r.json.report.img)).status, 200);
  }
});

test('a photo that is already clean is stored byte for byte as it was sent', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const [kind, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const r = await app.post(report({ ...INSIDE, photo: photoUrl(images.buffer(kind), mime) }));
    assert.equal(sha256((await app.request('GET', r.json.report.img)).bytes), sha256(images.buffer(kind)), kind);
  }
});

test('hand-built photos with hidden data are cleaned too: odd byte order, extra blocks, XMP, comments', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const tiff = buildTiff({ ...INSIDE, camera: true, little: false });
  for (const [buf, mime] of [[jpegWith(tiff), 'image/jpeg'], [pngWith(tiff), 'image/png'], [webpWith(tiff), 'image/webp']]) {
    const r = await app.post(report({ ...INSIDE, photo: photoUrl(buf, mime) }));
    assert.equal(r.status, 201, mime);
    const served = (await app.request('GET', r.json.report.img)).bytes;
    assert.equal(readGps(served), null, mime);
    assert.ok(!hasText(served, 'TestCam'), mime);
  }
});

test('damaged, fake or oversized photos are still refused, and nothing is saved', async (t) => {
  const app = await startApp({ MAX_PHOTO_BYTES: '20000' });
  t.after(() => app.close());
  const jpeg = images.buffer('jpeg');
  const bad = [
    [Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(30)]), 'image/jpeg', /damaged or incomplete/],
    [Buffer.from('<script>alert(1)</script>'), 'image/jpeg', /Photo|photo|image/],
    [fixtures.buffer('pngGps'), 'image/jpeg', /Photo|photo|match|type/],
    [Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x75, 0x30]), Buffer.alloc(30000, 1), jpeg.subarray(2)]), 'image/jpeg', /too large/],
  ];
  for (const [buf, mime, pattern] of bad) {
    const r = await app.post(report({ ...INSIDE, photo: photoUrl(buf, mime) }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.fields.photo, pattern);
  }
  assert.equal((await app.request('GET', '/api/reports')).json.reports.length, 12);
});

/* ---------------- place search (fake map service) ---------------- */

const photonAnswer = (...features) => ({ ok: true, status: 200, text: async () => JSON.stringify({ features: features.map(([lng, lat, props]) => ({ geometry: { coordinates: [lng, lat] }, properties: props })) }) });
const GEO_ON = { GEOCODER: 'photon' };

test('health says whether place search is available', async (t) => {
  const off = await startApp();
  t.after(() => off.close());
  assert.deepEqual((await off.request('GET', '/api/health')).json.geocoder, { enabled: false, typeahead: false });
  const on = await startApp(GEO_ON, { fetchFn: () => photonAnswer() });
  t.after(() => on.close());
  assert.deepEqual((await on.request('GET', '/api/health')).json.geocoder, { enabled: true, typeahead: true });
});

test('search: results come back marked inside or outside the barangay, with no login needed', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => photonAnswer([121.06668, 13.78285, { name: 'Alangilan Barangay Hall', city: 'Batangas City' }], [121.2, 13.9, { name: 'Faraway' }]) });
  t.after(() => app.close());
  const r = await app.request('GET', '/api/geocode/search?q=alangilan');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => [x.label, x.inArea]), [['Alangilan Barangay Hall, Batangas City', true], ['Faraway', false]]);
  assert.match(r.headers['cache-control'], /no-store/);
});

test('search: no match is an empty list (nothing invented), a short or odd question is refused', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => photonAnswer() });
  t.after(() => app.close());
  assert.deepEqual((await app.request('GET', '/api/geocode/search?q=zzzzqqqq')).json, { results: [] });
  for (const q of ['', 'ab', 'x'.repeat(101)]) assert.equal((await app.request('GET', `/api/geocode/search?q=${q}`)).status, 400, q);
  assert.equal((await app.request('GET', '/api/geocode/search')).status, 400);
  assert.equal((await app.request('GET', '/api/geocode/search?q=abc&q=def')).status, 400, 'a repeated q is not accepted');
  assert.equal(app.calls.length, 1, 'only the one good question reached the map service');
});

test('search: when the map service is down the answer is one clean message, and reporting still works', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => { throw new Error('ECONNREFUSED 10.0.0.5:443 secret detail'); } });
  t.after(() => app.close());
  const r = await app.request('GET', '/api/geocode/search?q=alangilan');
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'GEOCODER_UNAVAILABLE');
  assert.match(r.json.error.message, /choose the location on the map/);
  assert.doesNotMatch(r.text, /ECONNREFUSED|10\.0\.0\.5|secret detail/);
  assert.equal((await app.post(report({ x: 500, y: 300 }))).status, 201);
});

test('search turned off (GEOCODER=off): 503 and nothing is ever sent out', async (t) => {
  const app = await startApp({ GEOCODER: 'off' }, { fetchFn: () => photonAnswer() });
  t.after(() => app.close());
  const r = await app.request('GET', '/api/geocode/search?q=alangilan');
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'GEOCODER_OFF');
  assert.equal(app.calls.length, 0);
});

test('reverse: a name for the photo position, and no question to the map service for places far away', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => photonAnswer([121.06668, 13.78285, { name: 'Alangilan Barangay Hall', city: 'Batangas City' }]) });
  t.after(() => app.close());
  const near = await app.request('GET', '/api/geocode/reverse?lat=13.78285&lng=121.06668');
  assert.deepEqual(near.json, { label: 'Alangilan Barangay Hall, Batangas City', lat: 13.78285, lng: 121.06668, inArea: true });
  const far = await app.request('GET', '/api/geocode/reverse?lat=14.5995&lng=120.9842');
  assert.deepEqual(far.json, { label: null, lat: 14.5995, lng: 120.9842, inArea: false });
  assert.equal(app.calls.length, 1);
  for (const q of ['lat=abc&lng=121', 'lat=13', 'lat=91&lng=121', '']) assert.equal((await app.request('GET', `/api/geocode/reverse?${q}`)).status, 400, q);
});

test('search is limited to 30 requests a minute per address', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => photonAnswer() });
  t.after(() => app.close());
  let last;
  for (let i = 0; i < 31; i += 1) last = await app.request('GET', '/api/geocode/search?q=alangilan');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers['retry-after']) >= 1);
});

test('search results never reach the report by themselves: only the coordinates the page sends are saved and checked', async (t) => {
  const app = await startApp(GEO_ON, { fetchFn: () => photonAnswer([121.06668, 13.78285, { name: 'Pretend spot' }]) });
  t.after(() => app.close());
  const outside = await app.post(report({ lat: 14.5995, lng: 120.9842 }));
  assert.equal(outside.status, 400, 'even a "search result" outside the barangay is refused when it is sent as a report');
});
