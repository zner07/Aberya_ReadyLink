'use strict';
/* Builds EXIF blocks (and puts them inside JPEG / PNG / WebP files) so tests can make exact, odd and hostile cases:
   other byte order, missing parts, bad numbers, huge counts, pointers to nowhere. The real-world photos live in exifFixtures.js. */
const images = require('./images');

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

const dms = (value) => {
  const v = Math.abs(value);
  const d = Math.floor(v);
  const m = Math.floor((v - d) * 60);
  const s = ((v - d) * 60 - m) * 60;
  return [d, m, s];
};

/* options: lat, lng (numbers) | latRef, lngRef (override the letters) | little (byte order) | camera (adds Make/Model text)
            noGpsPointer | badPointer | zeroDenominator | minutes (override) | extraIfd0Entries (a number, for "huge" tests) */
function buildTiff(o = {}) {
  const little = o.little !== false;
  const u16 = (n) => { const b = Buffer.alloc(2); little ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); little ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0); return b; };
  const entry = (tag, type, count, value) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const pad4 = (b) => (b.length >= 4 ? b : Buffer.concat([b, Buffer.alloc(4 - b.length)]));
  const rationals = (parts, den = 1000) => Buffer.concat(parts.flatMap((p) => [u32(Math.round(p * den)), u32(o.zeroDenominator ? 0 : den)]));

  const hasGps = o.lat !== undefined && o.lng !== undefined;
  const ifd0Entries = o.extraIfd0Entries || 0;
  const camera = o.camera ? [Buffer.from('TestCam\0', 'latin1'), Buffer.from('Model Z\0', 'latin1')] : [];
  const ifd0Count = camera.length + (hasGps && !o.noGpsPointer ? 1 : 0) + ifd0Entries;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const gpsOffset = 8 + ifd0Size;

  let data = Buffer.alloc(0); // values that do not fit in 4 bytes
  let gpsIfd = Buffer.alloc(0);
  if (hasGps) {
    const latParts = o.minutes !== undefined ? [Math.floor(Math.abs(o.lat)), o.minutes, 0] : dms(o.lat);
    const lngParts = dms(o.lng);
    const gpsEntries = 4;
    const gpsSize = 2 + gpsEntries * 12 + 4;
    const dataStart = gpsOffset + gpsSize + (o.camera ? 0 : 0);
    const latData = rationals(latParts);
    const lngData = rationals(lngParts);
    const latRef = o.latRef !== undefined ? o.latRef : o.lat >= 0 ? 'N' : 'S';
    const lngRef = o.lngRef !== undefined ? o.lngRef : o.lng >= 0 ? 'E' : 'W';
    gpsIfd = Buffer.concat([
      u16(gpsEntries),
      entry(1, 2, 2, pad4(Buffer.from(`${latRef}\0`, 'latin1'))),
      entry(2, 5, 3, u32(dataStart)),
      entry(3, 2, 2, pad4(Buffer.from(`${lngRef}\0`, 'latin1'))),
      entry(4, 5, 3, u32(dataStart + latData.length)),
      u32(0),
    ]);
    data = Buffer.concat([latData, lngData]);
  }
  const cameraDataStart = gpsOffset + gpsIfd.length + data.length;
  let cameraOffset = cameraDataStart;
  const cameraEntries = camera.map((text, i) => {
    const e = entry(i === 0 ? 0x010f : 0x0110, 2, text.length, u32(cameraOffset));
    cameraOffset += text.length;
    return e;
  });
  const pointer = hasGps && !o.noGpsPointer ? [entry(0x8825, 4, 1, u32(o.badPointer ? 0x7fffff00 : gpsOffset))] : [];
  const fillers = Array.from({ length: ifd0Entries }, (_, i) => entry(0x9000 + i, 3, 1, pad4(u16(i))));
  const ifd0 = Buffer.concat([u16(ifd0Count), ...cameraEntries, ...pointer, ...fillers, u32(0)]);
  return Buffer.concat([Buffer.from(little ? 'II' : 'MM', 'latin1'), u16(42), u32(8), ifd0, gpsIfd, data, ...camera]);
}

const jpegWith = (tiff, jpeg = images.buffer('jpeg')) => {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
};

const pngWith = (tiff, png = images.buffer('png')) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(tiff.length, 0);
  head.write('eXIf', 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('eXIf'), tiff])));
  const chunk = Buffer.concat([head, tiff, crc]);
  const afterIhdr = 8 + 12 + png.readUInt32BE(8); // signature + IHDR chunk
  return Buffer.concat([png.subarray(0, afterIhdr), chunk, png.subarray(afterIhdr)]);
};

const webpWith = (tiff, webp = images.buffer('webp'), { prefix = false } = {}) => {
  const exif = prefix ? Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]) : tiff;
  const exifChunk = Buffer.concat([Buffer.from('EXIF'), Buffer.from([exif.length & 255, (exif.length >> 8) & 255, 0, 0]), exif, exif.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const vp8 = webp.subarray(12); // the original picture chunk
  const vp8x = Buffer.concat([Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), Buffer.from([0x08, 0, 0, 0]), Buffer.from([11, 0, 0]), Buffer.from([8, 0, 0])]); // flags: has EXIF; canvas 12 x 9
  const body = Buffer.concat([Buffer.from('WEBP'), vp8x, vp8, exifChunk]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
};

module.exports = { buildTiff, jpegWith, pngWith, webpWith, crc32 };
