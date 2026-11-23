'use strict';
/* Photo handling. Pure Node, no packages.

   The frontend already holds the photo as a data URL ("data:image/jpeg;base64,..."), so the API accepts exactly that
   inside the JSON body. We never trust what the client says about the file:
     1. The text must be a base64 data URL for jpeg, png or webp, and the size is checked BEFORE decoding.
     2. The decoded bytes must really start like a JPEG, PNG or WEBP file (magic bytes) and look complete.
     3. The type found in the bytes must match the type the client declared.
     4. The stored file name is a random UUID made here, and the extension comes from the DETECTED type.
        The client's file name and extension are never used.
   Files are later served with a fixed content type, "nosniff" and a restrictive CSP (see routes/uploads.js).

   Not checked in Phase 1: image dimensions and deep image decoding. The size limit is the protection against huge files. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME_TO_TYPE = Object.freeze({
  'image/jpeg': { type: 'jpeg', ext: 'jpg' },
  'image/png': { type: 'png', ext: 'png' },
  'image/webp': { type: 'webp', ext: 'webp' },
});
const MIME_BY_EXT = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* The message is safe to show to the user (it ends up in the "photo" field error). */
class PhotoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhotoError';
  }
}

/* Looks at the first bytes only. Returns 'jpeg', 'png', 'webp' or null. */
function detectImageType(buf) {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* Cheap check that the file is not cut off. */
function looksComplete(type, buf) {
  if (type === 'jpeg') return buf.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 4; // end-of-image marker
  if (type === 'png') return buf.length >= 33 && buf.toString('latin1', buf.length - 8, buf.length - 4) === 'IEND';
  if (type === 'webp') return buf.length >= 20 && buf.readUInt32LE(4) + 8 <= buf.length;
  return false;
}

/* ---- Removing metadata (EXIF / GPS / comments) WITHOUT re-encoding the picture --------------------------------------
   A photo can carry the photographer's exact position and device details. Uploads are served publicly, so the server
   removes that metadata from every photo before it is saved. The page already does this (it re-draws the photo on a canvas),
   but the API can also be called by other programs, so the server does it too.
   Only the metadata blocks are cut out. The picture data is copied byte for byte, so quality never changes.
   A photo whose structure cannot be read with confidence is rejected, because we could not promise it is clean. */
const bad = () => new PhotoError('The photo file looks damaged or incomplete.');

/* JPEG: keep JFIF (APP0), Adobe colour info (APP14), a real ICC colour profile (APP2). Remove EXIF/XMP (APP1), IPTC (APP13),
   every other APPn block, and comments. */
function keepJpegSegment(marker, data) {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return data.length >= 12 && data.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
  if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) return false;
  return true;
}

function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)]; // SOI
  let i = 2;
  for (;;) {
    if (i >= buf.length || buf[i] !== 0xff) throw bad();
    let j = i;
    while (j < buf.length && buf[j] === 0xff) j += 1;
    if (j >= buf.length) throw bad();
    const marker = buf[j];
    const start = j - 1;
    if (marker === 0x00) throw bad();
    if (marker === 0xd9) {
      out.push(buf.subarray(start)); // end of image
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(buf.subarray(start, j + 1)); // markers without a length
      i = j + 1;
      continue;
    }
    if (j + 2 >= buf.length) throw bad();
    const length = buf.readUInt16BE(j + 1);
    const end = j + 1 + length;
    if (length < 2 || end > buf.length) throw bad();
    if (marker === 0xda) {
      out.push(buf.subarray(start)); // start of scan: all that follows is picture data, copied as it is
      break;
    }
    if (keepJpegSegment(marker, buf.subarray(j + 3, end))) out.push(buf.subarray(start, end));
    i = end;
  }
  return Buffer.concat(out);
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let sawEnd = false;
  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > buf.length) throw bad();
    if (!PNG_METADATA_CHUNKS.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw bad();
  return Buffer.concat(out);
}

function stripWebp(buf) {
  const total = buf.readUInt32LE(4) + 8;
  if (total > buf.length || total < 20) throw bad();
  const chunks = [];
  let i = 12;
  while (i + 8 <= total) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1); // chunks are padded to an even length
    if (end > total) throw bad();
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(i, end));
      if (fourcc === 'VP8X' && size >= 1) chunk[8] &= ~0x0c; // clear the "has EXIF" and "has XMP" flags
      chunks.push(chunk);
    }
    i = end;
  }
  if (i !== total) throw bad();
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/* Returns a copy of the photo without EXIF/GPS/XMP/IPTC/comment metadata. Throws PhotoError when it cannot be read. */
function stripMetadata(type, buf) {
  if (type === 'jpeg') return stripJpeg(buf);
  if (type === 'png') return stripPng(buf);
  if (type === 'webp') return stripWebp(buf);
  throw bad();
}

/* dataUrl -> { buffer, type, ext, mime }. Throws PhotoError with a readable message. */
function decodePhoto(dataUrl, { maxBytes }) {
  if (typeof dataUrl !== 'string') throw new PhotoError('The photo must be sent as a data URL string.');
  const match = DATA_URL.exec(dataUrl);
  if (!match) throw new PhotoError('The photo must be a JPEG, PNG or WEBP image sent as a base64 data URL.');
  const [, declaredMime, base64] = match;
  if (base64.length === 0 || base64.length % 4 !== 0) throw new PhotoError('The photo data is not valid.');

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const size = (base64.length / 4) * 3 - padding;
  if (size > maxBytes) {
    throw new PhotoError(`The photo is too large. The limit is ${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB.`);
  }

  const buffer = Buffer.from(base64, 'base64');
  const type = detectImageType(buffer);
  if (!type) throw new PhotoError('The file is not a JPEG, PNG or WEBP image.');
  if (type !== MIME_TO_TYPE[declaredMime].type) throw new PhotoError('The photo content does not match its declared type.');
  if (!looksComplete(type, buffer)) throw new PhotoError('The photo file looks damaged or incomplete.');
  const { ext } = MIME_TO_TYPE[declaredMime];
  return { buffer: stripMetadata(type, buffer), type, ext, mime: declaredMime }; // saved without EXIF/GPS metadata
}

/* Writes the file with a new random name. Returns the file name (not a path). */
function savePhoto(uploadsDir, photo) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const name = `${crypto.randomUUID()}.${photo.ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), photo.buffer, { flag: 'wx', mode: 0o644 });
  return name;
}

/* Deletes an uploaded file. Only accepts names that this server could have generated. */
function removePhoto(uploadsDir, name) {
  if (typeof name === 'string' && UPLOAD_NAME.test(name)) fs.rmSync(path.join(uploadsDir, name), { force: true });
}

const photoUrl = (name) => (name ? `/uploads/${name}` : null);

module.exports = { decodePhoto, savePhoto, removePhoto, detectImageType, looksComplete, stripMetadata, photoUrl, PhotoError, UPLOAD_NAME, MIME_BY_EXT };
