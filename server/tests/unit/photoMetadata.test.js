'use strict';
/* The server removes EXIF/GPS and other metadata from every photo before saving it, without re-encoding the picture. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripMetadata, decodePhoto, savePhoto, PhotoError } = require('../../src/services/photoService');
const { loadExifReader } = require('../helpers/frontend');
const { buildTiff, jpegWith, pngWith, webpWith, crc32 } = require('../helpers/exif');
const fixtures = require('../helpers/exifFixtures');
const images = require('../helpers/images');
const { tempDir, removeDir } = require('../helpers/env');

const readGps = loadExifReader();
const SPOT = { lat: 13.78285, lng: 121.06668 };
const MARKERS = ['Exif', 'TestCam', 'Model X', 'Model Z', '2026:10:12', 'GPSLatitude'];
const hasText = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

test('real photos with GPS: after stripping there is no GPS and no camera or date text left (JPEG, PNG, WebP)', () => {
  for (const [name, type] of [['jpegGps', 'jpeg'], ['pngGps', 'png'], ['webpGps', 'webp']]) {
    const before = fixtures.buffer(name);
    assert.ok(readGps(before), `${name} had GPS before`);
    const after = stripMetadata(type, before);
    assert.equal(readGps(after), null, `${name} has no GPS after`);
    for (const marker of MARKERS) assert.ok(!hasText(after, marker), `${name} still contains "${marker}"`);
    assert.ok(after.length < before.length, `${name} got smaller`);
  }
});

test('built files: JPEG, PNG and WebP with camera data and GPS are cleaned', () => {
  const tiff = buildTiff({ ...SPOT, camera: true });
  for (const [type, file] of [['jpeg', jpegWith(tiff)], ['png', pngWith(tiff)], ['webp', webpWith(tiff)], ['webp', webpWith(tiff, undefined, { prefix: true })]]) {
    const after = stripMetadata(type, file);
    assert.equal(readGps(after), null, type);
    for (const marker of MARKERS) assert.ok(!hasText(after, marker), `${type}: ${marker}`);
  }
});

test('a photo without metadata comes out BYTE FOR BYTE the same (nothing is re-encoded or changed)', () => {
  for (const type of ['jpeg', 'png', 'webp']) assert.ok(stripMetadata(type, images.buffer(type)).equals(images.buffer(type)), type);
});

test('stripping twice changes nothing more', () => {
  const once = stripMetadata('jpeg', fixtures.buffer('jpegGps'));
  assert.ok(stripMetadata('jpeg', once).equals(once));
});

test('JPEG: the picture data is untouched, a colour profile is kept, everything else that can hold metadata goes', () => {
  const jpeg = images.buffer('jpeg');
  const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  const icc = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(10, 5)]));
  const mpf = seg(0xe2, Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.alloc(10, 6)]));
  const iptc = seg(0xed, Buffer.from('Photoshop 3.0\0author-name-here', 'latin1'));
  const comment = seg(0xfe, Buffer.from('written by John Smith on his phone', 'latin1'));
  const adobe = seg(0xee, Buffer.from('Adobe\0\x64\x80\0\0\0\0\0', 'latin1'));
  const app5 = seg(0xe5, Buffer.from('some vendor data', 'latin1'));
  const dirty = Buffer.concat([jpeg.subarray(0, 2), icc, mpf, iptc, comment, adobe, app5, jpegWith(buildTiff(SPOT)).subarray(2)]);
  const clean = stripMetadata('jpeg', dirty);
  assert.ok(hasText(clean, 'ICC_PROFILE'), 'the colour profile stays');
  assert.ok(hasText(clean, 'Adobe'), 'the colour transform block stays (needed to show some JPEGs correctly)');
  for (const gone of ['MPF', 'Photoshop', 'John Smith', 'vendor data', 'Exif']) assert.ok(!hasText(clean, gone), gone);
  assert.ok(clean.subarray(clean.indexOf(Buffer.from([0xff, 0xda]))).equals(jpeg.subarray(sos)), 'from the start of the scan to the end, identical to the original');
});

test('PNG: text, EXIF and time chunks go, the picture chunks stay identical', () => {
  const png = images.buffer('png');
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, data, crc]);
  };
  const afterIhdr = 8 + 12 + png.readUInt32BE(8);
  const dirty = Buffer.concat([png.subarray(0, afterIhdr), chunk('tEXt', Buffer.from('Author\0Jane Doe')), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>')), chunk('tIME', Buffer.alloc(7, 1)), chunk('zTXt', Buffer.from('k\0\0abc')), chunk('pHYs', Buffer.alloc(9, 2)), png.subarray(afterIhdr)]);
  const clean = stripMetadata('png', dirty);
  for (const gone of ['tEXt', 'iTXt', 'tIME', 'zTXt', 'Jane Doe']) assert.ok(!hasText(clean, gone), gone);
  assert.ok(hasText(clean, 'pHYs') && hasText(clean, 'IDAT') && hasText(clean, 'IEND'));
  assert.ok(clean.equals(Buffer.concat([png.subarray(0, afterIhdr), chunk('pHYs', Buffer.alloc(9, 2)), png.subarray(afterIhdr)])));
});

test('WebP: the EXIF and XMP chunks go, the "has EXIF" flag is cleared and the size field is right', () => {
  const tiff = buildTiff({ ...SPOT, camera: true });
  const clean = stripMetadata('webp', webpWith(tiff));
  assert.equal(clean.toString('latin1', 0, 4), 'RIFF');
  assert.equal(clean.readUInt32LE(4) + 8, clean.length, 'the RIFF size matches the file');
  assert.ok(!hasText(clean, 'EXIF') && !hasText(clean, 'XMP '));
  assert.equal(clean[20] & 0x0c, 0, 'the EXIF and XMP flags in VP8X are cleared');
  assert.ok(hasText(clean, 'VP8 '), 'the picture chunk stays');
});

test('a structure that cannot be read with confidence is REJECTED, because it could not be promised clean', () => {
  const jpeg = images.buffer('jpeg');
  const cases = [
    ['jpeg', Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(20)])], // a block longer than the file
    ['jpeg', Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0x00, 0x01, 0x02, 0x03])])], // junk where a block should start
    ['jpeg', jpeg.subarray(0, 30)],
    ['png', images.buffer('png').subarray(0, 40)],
    ['png', Buffer.concat([images.buffer('png').subarray(0, 8), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(30)])],
    ['webp', Buffer.concat([images.buffer('webp').subarray(0, 4), Buffer.from([0xff, 0xff, 0, 0]), images.buffer('webp').subarray(8)])],
    ['webp', images.buffer('webp').subarray(0, 24)],
  ];
  for (const [type, buf] of cases) assert.throws(() => stripMetadata(type, buf), (e) => e instanceof PhotoError && /damaged or incomplete/.test(e.message), `${type} ${buf.length}`);
});

test('decodePhoto returns the CLEAN bytes, so nothing else in the system ever sees the metadata', () => {
  const dataUrl = images.dataUrlFromBuffer(fixtures.buffer('jpegGps'), 'image/jpeg');
  const out = decodePhoto(dataUrl, { maxBytes: 5e6 });
  assert.equal(readGps(out.buffer), null);
  assert.ok(!hasText(out.buffer, 'TestCam'));
  assert.equal(out.type, 'jpeg');
});

test('savePhoto writes the clean file: no GPS on disk', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const decoded = decodePhoto(images.dataUrlFromBuffer(fixtures.buffer('webpGps'), 'image/webp'), { maxBytes: 5e6 });
  const saved = savePhoto(dir, decoded);
  const onDisk = fs.readFileSync(path.join(dir, saved.file || saved.fileName || fs.readdirSync(dir)[0]));
  assert.equal(readGps(onDisk), null);
  assert.ok(!hasText(onDisk, 'EXIF'));
});

test('a photo that declares one type and is another is still refused, as before', () => {
  assert.throws(() => decodePhoto(images.dataUrlFromBuffer(fixtures.buffer('pngGps'), 'image/jpeg'), { maxBytes: 5e6 }), /doesn't match|does not match|type/i);
});
