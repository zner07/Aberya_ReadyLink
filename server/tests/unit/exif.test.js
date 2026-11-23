'use strict';
/* The page's EXIF GPS reader (js/exif.js) run in a sandbox: real photos from an independent writer, built edge cases, and hostile files. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExifReader } = require('../helpers/frontend');
const { buildTiff, jpegWith, pngWith, webpWith } = require('../helpers/exif');
const fixtures = require('../helpers/exifFixtures');
const images = require('../helpers/images');

const read = loadExifReader();
const near = (got, lat, lng) => got && Math.abs(got.lat - lat) < 1e-5 && Math.abs(got.lng - lng) < 1e-5;
const SPOT = { lat: 13.78285, lng: 121.06668 };

test('real photos made by Pillow: GPS is found in JPEG, PNG and WebP', () => {
  for (const name of ['jpegGps', 'pngGps', 'webpGps']) assert.ok(near(read(fixtures.buffer(name)), fixtures.LAT, fixtures.LNG), name);
});

test('photos without GPS (a screenshot, an edited photo, one with EXIF but no GPS, one with no EXIF) give null, not an error', () => {
  for (const name of ['jpegNoGps', 'jpegNoExif']) assert.equal(read(fixtures.buffer(name)), null, name);
  for (const kind of ['jpeg', 'png', 'webp']) assert.equal(read(images.buffer(kind)), null, `the plain ${kind} fixture`);
});

test('only { lat, lng } comes out. The camera name and the date in the same EXIF are never returned', () => {
  const got = read(fixtures.buffer('jpegGps'));
  assert.deepEqual(Object.keys(got).sort(), ['lat', 'lng']);
  assert.ok(!JSON.stringify(got).includes('TestCam') && !JSON.stringify(got).includes('2026'));
});

test('both byte orders (Intel and Motorola) are read', () => {
  assert.ok(near(read(jpegWith(buildTiff({ ...SPOT, little: true }))), SPOT.lat, SPOT.lng));
  assert.ok(near(read(jpegWith(buildTiff({ ...SPOT, little: false }))), SPOT.lat, SPOT.lng));
});

test('south and west are negative', () => {
  assert.ok(near(read(jpegWith(buildTiff({ lat: -33.8688, lng: -70.6693 }))), -33.8688, -70.6693));
  assert.ok(near(read(jpegWith(buildTiff({ lat: 13.78, lng: -121.06 }))), 13.78, -121.06));
});

test('the same GPS is found in a PNG (eXIf chunk) and a WebP (EXIF chunk, with or without the Exif prefix)', () => {
  const tiff = buildTiff({ ...SPOT, camera: true });
  assert.ok(near(read(pngWith(tiff)), SPOT.lat, SPOT.lng));
  assert.ok(near(read(webpWith(tiff)), SPOT.lat, SPOT.lng));
  assert.ok(near(read(webpWith(tiff, undefined, { prefix: true })), SPOT.lat, SPOT.lng));
});

test('input can be an ArrayBuffer, a Uint8Array or a Node Buffer', () => {
  const buf = jpegWith(buildTiff(SPOT));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  for (const input of [buf, new Uint8Array(ab), ab]) assert.ok(near(read(input), SPOT.lat, SPOT.lng));
});

test('a camera that wrote no real position gives null: 0,0, missing letters, wrong letters, no GPS block, no pointer', () => {
  assert.equal(read(jpegWith(buildTiff({ lat: 0, lng: 0, latRef: 'N', lngRef: 'E' }))), null, '"null island" is a no-fix marker');
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, latRef: '' }))), null);
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, lngRef: 'X' }))), null);
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, latRef: 'E', lngRef: 'N' }))), null, 'the letters must belong to the right axis');
  assert.equal(read(jpegWith(buildTiff({ camera: true }))), null, 'EXIF without a GPS block');
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, noGpsPointer: true }))), null);
});

test('impossible numbers give null: degrees out of range, minutes 60 or more, division by zero', () => {
  assert.equal(read(jpegWith(buildTiff({ lat: 95, lng: 121 }))), null);
  assert.equal(read(jpegWith(buildTiff({ lat: 13, lng: 190 }))), null);
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, minutes: 75 }))), null);
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, zeroDenominator: true }))), null);
});

test('a pointer to nowhere, or an enormous entry count, does not crash or hang', () => {
  assert.equal(read(jpegWith(buildTiff({ ...SPOT, badPointer: true }))), null);
  const started = Date.now();
  const huge = read(jpegWith(buildTiff({ ...SPOT, extraIfd0Entries: 5000 })));
  assert.ok(huge === null || near(huge, SPOT.lat, SPOT.lng));
  assert.ok(Date.now() - started < 1000);
});

test('EXIF behind other blocks (XMP first) is still found', () => {
  const jpeg = jpegWith(buildTiff(SPOT));
  const xmp = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1');
  const xmpSegment = Buffer.concat([Buffer.from([0xff, 0xe1, (xmp.length + 2) >> 8, (xmp.length + 2) & 0xff]), xmp]);
  assert.ok(near(read(Buffer.concat([jpeg.subarray(0, 2), xmpSegment, jpeg.subarray(2)])), SPOT.lat, SPOT.lng));
});

test('a damaged file at ANY cut-off point never throws', () => {
  for (const full of [jpegWith(buildTiff({ ...SPOT, camera: true })), pngWith(buildTiff(SPOT)), webpWith(buildTiff(SPOT)), fixtures.buffer('jpegGps')]) {
    for (let n = 0; n <= full.length; n += 1) {
      const out = read(full.subarray(0, n));
      assert.ok(out === null || (typeof out.lat === 'number' && typeof out.lng === 'number'));
    }
  }
});

test('random junk, empty input and other file types never throw and give null', () => {
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 7919 + 13) & 255;
  junk[0] = 0xff; junk[1] = 0xd8; // looks like a JPEG at the start
  const inputs = [junk, Buffer.alloc(0), Buffer.from('GIF89a....'), Buffer.from('%PDF-1.4'), Buffer.from('<?xml?>'), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), new Uint8Array(3), new ArrayBuffer(0)];
  for (const input of inputs) assert.equal(read(input), null);
  for (const input of [undefined, null, 'text', 42, {}]) assert.equal(read(input), null, String(input));
});

test('a large file with no EXIF is checked quickly (the page may be given 10 MB photos)', () => {
  const big = Buffer.concat([images.buffer('jpeg').subarray(0, 20), Buffer.alloc(10 * 1024 * 1024, 7)]);
  const started = Date.now();
  assert.equal(read(big), null);
  assert.ok(Date.now() - started < 1000);
});
