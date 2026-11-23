'use strict';
/* The server checks every location itself. lat/lng (GPS, search, photo) and x/y (a tap on the map) both end as the same stored
   latitude and longitude, and x/y are always calculated with the project's GEO constants. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateNewReport } = require('../../src/services/reportValidation');
const { createReport, getReport } = require('../../src/services/reportService');
const { seedSamples } = require('../../src/services/seedService');
const { DRIVERS, geo, FRONTEND_DIR, CLIENT_A, memoryDb, tempDir, removeDir } = require('../helpers/env');

const ctx = { geo, maxPhotoBytes: 5e6 };
const base = { type: 'drain', desc: 'x', level: 'mod' };
const check = (extra) => validateNewReport({ ...base, ...extra }, ctx);
const INSIDE = { lat: 13.78285, lng: 121.06668 }; // inside Brgy. Alangilan (the same spot as x=500, y=300 on the map)

test('lat/lng inside the barangay are accepted and rounded to 6 decimals', () => {
  const { value, errors } = check({ lat: 13.7828512345678, lng: 121.0666812345678 });
  assert.deepEqual(errors, {});
  assert.equal(value.lat, 13.782851);
  assert.equal(value.lng, 121.066681);
});

test('x and y are calculated from lat/lng with the SAME constants the frontend uses', () => {
  const { value } = check(INSIDE);
  const p = geo.latLngToXy(INSIDE.lat, INSIDE.lng);
  assert.deepEqual([value.x, value.y], [p.x, p.y]);
  assert.ok(Math.abs(value.x - 500) < 1 && Math.abs(value.y - 300) < 1, `${value.x},${value.y}`);
});

test('the x/y way (a tap on the map) still works exactly as before', () => {
  const { value, errors } = check({ x: 500, y: 300 });
  assert.deepEqual(errors, {});
  const g = geo.xyToLatLng(500, 300);
  assert.deepEqual([value.lat, value.lng], [g.lat, g.lng]);
});

test('when both are sent, lat/lng win and x/y are ignored (even bad x/y cannot do harm)', () => {
  const { value, errors } = check({ ...INSIDE, x: 99999, y: -5 });
  assert.deepEqual(errors, {});
  assert.equal(value.lat, INSIDE.lat);
  assert.ok(value.x < 1000 && value.y < 611);
});

test('a spot outside Brgy. Alangilan is refused, from every source', () => {
  for (const spot of [{ lat: 13.9, lng: 121.2 }, { lat: 14.5995, lng: 120.9842 }, { lat: 13.78285, lng: 121.2 }, { lat: 0.001, lng: 0.001 }, { lat: -13.78285, lng: -121.06668 }, { lat: 13.7889, lng: 121.0557 }]) {
    const { value, errors } = check(spot);
    assert.equal(value, null, JSON.stringify(spot));
    assert.equal(errors.location, 'That spot is outside Brgy. Alangilan.');
  }
  assert.equal(check({ x: 5, y: 5 }).errors.location, 'That spot is outside Brgy. Alangilan.');
});

test('invalid lat/lng are refused with a message (not a crash)', () => {
  const cases = [
    [{ lat: 13.78 }, /both be numbers/], [{ lng: 121.06 }, /both be numbers/],
    [{ lat: '13.78', lng: '121.06' }, /numbers/], [{ lat: true, lng: false }, /numbers/], [{ lat: {}, lng: [] }, /numbers/],
    [{ lat: NaN, lng: 121 }, /numbers/], [{ lat: Infinity, lng: 121 }, /numbers/], [{ lat: 13, lng: -Infinity }, /numbers/],
    [{ lat: 91, lng: 121 }, /valid range/], [{ lat: -91, lng: 121 }, /valid range/], [{ lat: 13, lng: 181 }, /valid range/], [{ lat: 13, lng: -181 }, /valid range/],
    [{ lat: 1e308, lng: 1e308 }, /valid range/],
  ];
  for (const [extra, pattern] of cases) {
    const { value, errors } = check(extra);
    assert.equal(value, null, JSON.stringify(extra));
    assert.match(errors.location, pattern, JSON.stringify(extra));
  }
});

test('no location at all is refused and the message mentions both ways', () => {
  for (const extra of [{}, { x: 1 }, { y: 1 }, { lat: null, lng: null }, { x: 'a', y: 'b' }]) {
    const { value, errors } = check(extra);
    assert.equal(value, null, JSON.stringify(extra));
    assert.match(errors.location, /must be numbers \(map coordinates\), or send lat and lng/);
  }
});

test('null lat/lng with a valid x/y falls back to x/y (a form that leaves the fields empty still works)', () => {
  const { value, errors } = check({ lat: null, lng: null, x: 500, y: 300 });
  assert.deepEqual(errors, {});
  assert.ok(value.lat > 13 && value.lng > 121);
});

test('other fields are validated together with the location', () => {
  const { errors } = validateNewReport({ type: 'bridge', lat: 14, lng: 121, desc: 'x', level: 'zzz' }, ctx);
  assert.ok(errors.type && errors.level && errors.location);
});

test('the SAME point from a tap, from GPS and from a search is stored as the same latitude and longitude', () => {
  const tap = check({ x: 500, y: 300 }).value;
  const gps = check({ lat: tap.lat, lng: tap.lng }).value;
  // the tap path keeps full precision (as before), the lat/lng path rounds to 6 decimals (about 0.1 metre)
  assert.ok(Math.abs(gps.lat - tap.lat) < 1e-6 && Math.abs(gps.lng - tap.lng) < 1e-6);
  assert.ok(Math.abs(gps.x - 500) < 0.1 && Math.abs(gps.y - 300) < 0.1, 'and the map position comes back to the tapped point');
});

for (const driver of DRIVERS) {
  test(`[${driver}] a report made from lat/lng keeps those exact coordinates and shows on the map list with x/y inside the map`, () => {
    const db = memoryDb(driver);
    const dir = tempDir();
    try {
      seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
      const { value } = check({ lat: 13.782851, lng: 121.066681 });
      const made = createReport(db, { geo, uploadsDir: dir, now: () => new Date('2026-10-12T05:00:00.000Z') }, {
  ...value,
  assessment: {
    outcome: 'hazard_detected',
    level: value.level,
    hazardName: null,
    source: 'fallback',
    reason: 'Test rule-based assessment for location validation.',
    demo: false,
  },
}, CLIENT_A);
      const read = getReport(db, { geo }, made.id);
      assert.equal(read.lat, 13.782851);
      assert.equal(read.lng, 121.066681);
      assert.ok(read.x >= 0 && read.x <= 1000 && read.y >= 0 && read.y <= 611);
      assert.deepEqual([made.x, made.y], [read.x, read.y]);
      assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 13, 'the 12 samples are untouched');
    } finally {
      db.close();
      removeDir(dir);
    }
  });
}

