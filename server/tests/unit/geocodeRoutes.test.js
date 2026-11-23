'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGeocodeHandlers } = require('../../src/routes/geocode');
const { AppError, errorBody } = require('../../src/middleware/errors');

const fakeRes = () => ({ statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, json(b) { this.body = b; return this; } });
async function call(fn, req) {
  const res = fakeRes();
  let error;
  await fn({ query: {}, socket: { remoteAddress: '10.2.2.2' }, ...req }, res, (e) => { error = e; });
  return { res, error };
}
const seen = [];
const geocoder = {
  search: async (q) => { seen.push(['search', q]); return { results: [{ label: q, lat: 13.78, lng: 121.06, inArea: true }] }; },
  reverse: async (lat, lng) => { seen.push(['reverse', lat, lng]); if (Number.isNaN(lat)) throw new AppError(400, 'VALIDATION', 'bad'); return { label: 'x', lat, lng, inArea: true }; },
};

test('search passes the text on and returns the answer', async () => {
  const { h } = { h: createGeocodeHandlers({ geocoder }) };
  const { res } = await call(h.search, { query: { q: 'alangilan' } });
  assert.equal(res.body.results[0].label, 'alangilan');
});

test('search: a missing, repeated or object q is treated as empty text (the service then refuses it)', async () => {
  const h = createGeocodeHandlers({ geocoder });
  seen.length = 0;
  for (const q of [undefined, ['a', 'b'], { x: 1 }]) await call(h.search, { query: { q } });
  assert.deepEqual(seen.map((s) => s[1]), ['', '', '']);
});

test('reverse reads lat and lng as plain numbers only', async () => {
  const h = createGeocodeHandlers({ geocoder });
  seen.length = 0;
  await call(h.reverse, { query: { lat: '13.78285', lng: '121.06668' } });
  await call(h.reverse, { query: { lat: '13.78e3', lng: '0x10' } });
  await call(h.reverse, { query: { lat: ['13'], lng: undefined } });
  assert.deepEqual(seen[0], ['reverse', 13.78285, 121.06668]);
  assert.ok(seen.slice(1).every((s) => Number.isNaN(s[1])), 'anything that is not a plain number becomes NaN and is refused');
});

test('errors from the service are passed on to the error handler', async () => {
  const h = createGeocodeHandlers({ geocoder });
  const { error } = await call(h.reverse, { query: { lat: 'abc', lng: 'def' } });
  assert.equal(errorBody(error).status, 400);
});

test('30 searches per minute per address, then 429 with Retry-After; another address is not affected', async () => {
  let t = 5000;
  const h = createGeocodeHandlers({ geocoder, now: () => t });
  for (let i = 0; i < 30; i += 1) assert.equal((await call(h.search, { query: { q: 'abc' } })).error, undefined);
  const blocked = await call(h.search, { query: { q: 'abc' } });
  assert.equal(errorBody(blocked.error).status, 429);
  assert.equal(errorBody(blocked.error).body.error.code, 'TOO_MANY_REQUESTS');
  assert.ok(Number(blocked.res.headers['retry-after']) >= 1);
  assert.equal((await call(h.search, { query: { q: 'abc' }, socket: { remoteAddress: '10.9.9.9' } })).error, undefined);
  t += 61000;
  assert.equal((await call(h.search, { query: { q: 'abc' } })).error, undefined, 'the minute is over');
});

test('search and reverse share the same limit', async () => {
  const h = createGeocodeHandlers({ geocoder, now: () => 1 });
  for (let i = 0; i < 15; i += 1) { await call(h.search, { query: { q: 'abc' } }); await call(h.reverse, { query: { lat: '13.7', lng: '121.0' } }); }
  assert.equal(errorBody((await call(h.reverse, { query: { lat: '13.7', lng: '121.0' } })).error).status, 429);
});
