/* EXIF GPS READER (Phase 3.5).

   Looks inside a photo for the GPS position stored by the camera, so the report form can SUGGEST it as the hazard location.
   - Reads JPEG (EXIF block), PNG (eXIf chunk) and WebP (EXIF chunk). Other formats (for example HEIC) simply give no result.
   - Returns ONLY { lat, lng } or null. Nothing else in the metadata (camera model, time, device, serial number) is read or kept.
   - Never throws. A screenshot, an edited or compressed photo, a damaged file or a file without GPS gives null.
   - Treats the file as untrusted: every read is bounds-checked and the number of entries is limited.
   - No libraries and no DOM, so it can be tested without a browser (server/tests/unit/exif.test.js).

   The position is only a suggestion. The page never uses it before the person confirms it (see js/location.js). */

const EXIF_MAX_ENTRIES = 300;
const EXIF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function exifAscii(bytes, start, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[start + i]);
  return text;
}

/* JPEG: walk the header blocks until the picture data starts; return the TIFF part of the EXIF block (APP1). */
function exifFromJpeg(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    let j = i;
    while (j < bytes.length && bytes[j] === 0xff) j += 1;
    const marker = bytes[j];
    if (marker === 0xda || marker === 0xd9) return null; // picture data starts: no EXIF before it
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i = j + 1;
      continue;
    }
    const length = (bytes[j + 1] << 8) | bytes[j + 2];
    const end = j + 1 + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker === 0xe1 && length >= 8 && exifAscii(bytes, j + 3, 6) === 'Exif\0\0') return bytes.subarray(j + 9, end);
    i = end;
  }
  return null;
}

/* PNG: chunks are [length][type][data][crc]. The EXIF data is in the "eXIf" chunk, before the picture data. */
function exifFromPng(bytes) {
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const type = exifAscii(bytes, i + 4, 4);
    const end = i + 8 + length;
    if (end + 4 > bytes.length) return null;
    if (type === 'eXIf') return bytes.subarray(i + 8, end);
    if (type === 'IDAT' || type === 'IEND') return null;
    i = end + 4;
  }
  return null;
}

/* WebP: RIFF chunks [fourcc][size, little endian][data]. The EXIF data is in the "EXIF" chunk. */
function exifFromWebp(bytes) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    const end = i + 8 + size;
    if (end > bytes.length) return null;
    if (exifAscii(bytes, i, 4) === 'EXIF') {
      const start = size >= 6 && exifAscii(bytes, i + 8, 6) === 'Exif\0\0' ? i + 14 : i + 8; // some writers keep the "Exif" prefix
      return bytes.subarray(start, end);
    }
    i = end + (size & 1);
  }
  return null;
}

/* TIFF structure inside EXIF: a header, then lists of 12-byte entries. We follow ONE pointer (IFD0 -> GPS) and read 4 entries. */
function exifGpsFromTiff(t) {
  if (t.length < 8) return null;
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  if (view.getUint16(2, little) !== 42) return null;

  const entries = (ifdOffset) => {
    const map = new Map();
    if (!Number.isInteger(ifdOffset) || ifdOffset < 8 || ifdOffset + 2 > t.length) return map;
    const count = Math.min(view.getUint16(ifdOffset, little), EXIF_MAX_ENTRIES);
    for (let n = 0; n < count; n += 1) {
      const at = ifdOffset + 2 + n * 12;
      if (at + 12 > t.length) break;
      map.set(view.getUint16(at, little), { at, type: view.getUint16(at + 2, little), count: view.getUint32(at + 4, little) });
    }
    return map;
  };
  /* Where the entry's values are stored (inside the entry when 4 bytes or fewer, otherwise at an offset), or -1 if unsafe. */
  const valueAt = (e) => {
    const size = (EXIF_TYPE_SIZE[e.type] || 0) * e.count;
    if (!size || e.count > 1000) return -1;
    const start = size <= 4 ? e.at + 8 : view.getUint32(e.at + 8, little);
    return start >= 0 && start + size <= t.length ? start : -1;
  };
  const letter = (e) => {
    if (!e || e.type !== 2 || e.count < 1) return '';
    const start = valueAt(e);
    return start < 0 ? '' : String.fromCharCode(t[start]).toUpperCase();
  };
  const degrees = (e) => {
    if (!e || e.type !== 5 || e.count !== 3) return NaN;
    const start = valueAt(e);
    if (start < 0) return NaN;
    const parts = [];
    for (let n = 0; n < 3; n += 1) {
      const num = view.getUint32(start + n * 8, little);
      const den = view.getUint32(start + n * 8 + 4, little);
      if (den === 0) return NaN;
      parts.push(num / den);
    }
    if (parts[1] >= 60 || parts[2] >= 60) return NaN;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  };

  const gpsPointer = entries(view.getUint32(4, little)).get(0x8825); // GPSInfo
  if (!gpsPointer || gpsPointer.type !== 4 || gpsPointer.count !== 1) return null;
  const gps = entries(view.getUint32(gpsPointer.at + 8, little));
  const latRef = letter(gps.get(1));
  const lngRef = letter(gps.get(3));
  let lat = degrees(gps.get(2));
  let lng = degrees(gps.get(4));
  if (!(latRef === 'N' || latRef === 'S') || !(lngRef === 'E' || lngRef === 'W')) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (latRef === 'S') lat = -lat;
  if (lngRef === 'W') lng = -lng;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null; // 0,0 is what many cameras write when they have no fix: not a real place
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/* The one function the page uses. buffer = ArrayBuffer or Uint8Array of the ORIGINAL photo file.
   Returns { lat, lng } or null. Never throws. */
function readPhotoGps(buffer) {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let tiff = null;
    if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8) tiff = exifFromJpeg(bytes);
    else if (bytes.length > 20 && exifAscii(bytes, 1, 3) === 'PNG') tiff = exifFromPng(bytes);
    else if (bytes.length > 20 && exifAscii(bytes, 0, 4) === 'RIFF' && exifAscii(bytes, 8, 4) === 'WEBP') tiff = exifFromWebp(bytes);
    return tiff ? exifGpsFromTiff(tiff) : null;
  } catch (err) {
    return null;
  }
}
