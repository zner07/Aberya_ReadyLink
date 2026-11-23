'use strict';
/* Validation for POST /api/reports. Pure functions, easy to test.

   It collects ALL problems at once, so the form can show every message together:
     { type: 'Unknown hazard type.', location: 'That spot is outside Brgy. Alangilan.' }

   Only the fields below are read. Anything else the client sends (id, status, mine, client_id ...) is ignored,
   so a client can never choose a report's id or status. */
const { decodePhoto, PhotoError } = require('./photoService');

// The exact values the frontend uses. Do not rename or add to these without changing the frontend too.
const HAZARD_TYPES = Object.freeze(['tree', 'drain', 'road', 'pole', 'flood', 'slope', 'river', 'wall', 'other']);
const LEVELS = Object.freeze(['hi', 'mod', 'lo']);
const STATUSES = Object.freeze(['Pending', 'Verified', 'Under monitoring', 'Resolved']);

const MAX_DESC_LENGTH = 240; // same as the textarea in the report form
const roundDegrees = (n) => Math.round(n * 1e6) / 1e6; // 6 decimals is about 0.1 metre
const MAX_REMARK_LENGTH = 500; // admin remark
const DEFAULT_DESC = 'No description provided.'; // same text the frontend demo uses
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* body: parsed JSON. deps: { geo, maxPhotoBytes }. Returns { value, errors }. errors is {} when everything is fine. */
function validateNewReport(body, { geo, maxPhotoBytes }) {
  const errors = {};
  if (!isPlainObject(body)) return { value: null, errors: { _body: 'Send the report as a JSON object.' } };

  // type
  if (typeof body.type !== 'string' || !HAZARD_TYPES.includes(body.type)) {
    errors.type = `Choose one of: ${HAZARD_TYPES.join(', ')}.`;
  }

  // location: EITHER real coordinates (lat + lng: phone GPS, place search, photo GPS) OR map units (x + y: a tap on the map).
  // lat/lng win when both are sent. Whatever arrives is checked here, whatever the page already checked: the server never
  // trusts coordinates from the browser. The other pair is always calculated with the SAME GEO constants as the frontend.
  let lat = null;
  let lng = null;
  let mapX = body.x;
  let mapY = body.y;
  const given = (v) => v !== undefined && v !== null;
  if (given(body.lat) || given(body.lng)) {
    const latLngOk = typeof body.lat === 'number' && Number.isFinite(body.lat) && typeof body.lng === 'number' && Number.isFinite(body.lng);
    if (!latLngOk) {
      errors.location = 'lat and lng must both be numbers (degrees).';
    } else if (body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180) {
      errors.location = 'lat and lng are outside the valid range.';
    } else {
      const candidateLat = roundDegrees(body.lat);
      const candidateLng = roundDegrees(body.lng);
      ({ x: mapX, y: mapY } = geo.latLngToXy(candidateLat, candidateLng));
      if (!geo.isInsideMapBounds(mapX, mapY) || !geo.isInsideBoundary(candidateLat, candidateLng)) {
        errors.location = 'That spot is outside Brgy. Alangilan.';
      } else {
        lat = candidateLat;
        lng = candidateLng;
      }
    }
  } else {
    const xyOk = typeof body.x === 'number' && Number.isFinite(body.x) && typeof body.y === 'number' && Number.isFinite(body.y);
    if (!xyOk) {
      errors.location = 'x and y must be numbers (map coordinates), or send lat and lng (degrees).';
    } else if (!geo.isInsideMapBounds(body.x, body.y)) {
      errors.location = 'x and y are outside the map.';
    } else {
      ({ lat, lng } = geo.xyToLatLng(body.x, body.y));
      if (!geo.isInsideBoundary(lat, lng)) errors.location = 'That spot is outside Brgy. Alangilan.';
    }
  }

  // description (optional)
  let desc = DEFAULT_DESC;
  if (body.desc !== undefined && body.desc !== null) {
    if (typeof body.desc !== 'string') {
      errors.desc = 'The description must be text.';
    } else {
      const cleaned = body.desc.replace(CONTROL_CHARS, '').trim();
      if (cleaned.length > MAX_DESC_LENGTH) errors.desc = `Use ${MAX_DESC_LENGTH} characters or fewer.`;
      else if (cleaned) desc = cleaned;
    }
  }

  // level (optional). TODO(ai): in the AI phase the server decides this and ignores the client's value.
  let level = 'mod';
  if (body.level !== undefined && body.level !== null) {
    if (typeof body.level === 'string' && LEVELS.includes(body.level)) level = body.level;
    else errors.level = `Use one of: ${LEVELS.join(', ')}.`;
  }

  // photo (optional)
  let photo = null;
  if (body.photo !== undefined && body.photo !== null) {
    try {
      photo = decodePhoto(body.photo, { maxBytes: maxPhotoBytes });
    } catch (err) {
      if (err instanceof PhotoError) errors.photo = err.message;
      else throw err;
    }
  }

  if (Object.keys(errors).length) return { value: null, errors };
  return { value: { type: body.type, x: mapX, y: mapY, lat, lng, desc, level, photo }, errors: {} };
}

/* Status names are matched without caring about capital letters ("Under Monitoring" works), but the stored and returned
   name is always the exact one the frontend uses ("Under monitoring"). Returns the exact name, or null. */
function normalizeStatus(value) {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  return STATUSES.find((s) => s.toLowerCase() === wanted) || null;
}

/* PATCH /api/reports/:id  body: { status?, level?, remark? }. At least one useful field is needed.
   An empty remark is treated as "no remark" (the admin form sends '' when the box is empty).
   Anything else in the body (id, mine, client_id ...) is ignored. Returns { value, errors } like validateNewReport. */
function validateUpdate(body) {
  if (!isPlainObject(body)) return { value: null, errors: { _body: 'Send the change as a JSON object.' } };
  const errors = {};
  const value = {};

  if (body.status !== undefined && body.status !== null) {
    const status = normalizeStatus(body.status);
    if (status) value.status = status;
    else errors.status = `Use one of: ${STATUSES.join(', ')}.`;
  }
  if (body.level !== undefined && body.level !== null) {
    if (typeof body.level === 'string' && LEVELS.includes(body.level)) value.level = body.level;
    else errors.level = `Use one of: ${LEVELS.join(', ')}.`;
  }
  if (body.remark !== undefined && body.remark !== null) {
    if (typeof body.remark !== 'string') {
      errors.remark = 'The remark must be text.';
    } else {
      const cleaned = body.remark.replace(CONTROL_CHARS, '').trim();
      if (cleaned.length > MAX_REMARK_LENGTH) errors.remark = `Use ${MAX_REMARK_LENGTH} characters or fewer.`;
      else if (cleaned) value.remark = cleaned;
    }
  }

  if (Object.keys(errors).length) return { value: null, errors };
  if (!Object.keys(value).length) return { value: null, errors: { _body: 'Send a status, a level or a remark.' } };
  return { value, errors: {} };
}

/* X-Client-Id header. state: 'missing' | 'ok' | 'invalid'.
   This id only LABELS reports as "mine". It is not a password or a login. */
function parseClientId(value) {
  if (value === undefined) return { state: 'missing' };
  if (typeof value === 'string' && CLIENT_ID_PATTERN.test(value)) return { state: 'ok', id: value };
  return { state: 'invalid' };
}

module.exports = { validateNewReport, validateUpdate, normalizeStatus, parseClientId, HAZARD_TYPES, LEVELS, STATUSES, MAX_DESC_LENGTH, MAX_REMARK_LENGTH, DEFAULT_DESC };
