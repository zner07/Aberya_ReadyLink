
'use strict';
/* Report business logic: create, list, get. Works with the small db interface from src/db.js. No Express in here.

   Report JSON returned by the API (the same field names the frontend already uses):
     { id, type, x, y, lat, lng, ai, lv, st, date, createdAt, desc, brgy, mine, img, log: [{ t, d, at, n? }] }
   - id         'RL-036'
   - x, y       SVG map units (what the frontend draws), calculated from the stored lat/lng
   - ai / lv    suggested level / current level: 'hi' | 'mod' | 'lo'
   - st         'Pending' | 'Verified' | 'Under monitoring' | 'Resolved'
   - date, d    display text like 'Sep 25' and 'Sep 25, 12:00 PM' (Manila time), for the existing UI
   - createdAt, at   the same moments as ISO 8601 (UTC)
   - mine       true when the X-Client-Id of the request matches the report's anonymous client id
   - img        '/uploads/<uuid>.jpg' or null
   The client id itself is never returned. */

const { savePhoto, removePhoto, photoUrl } = require('./photoService');
const { STATUSES } = require('./reportValidation');

const BRGY = 'Brgy. Alangilan';
const DISPLAY_TIMEZONE = 'Asia/Manila';
const MAX_LIST = 500;
const PUBLIC_ID = /^RL-\d{3,}$/;

const cleanSpaces = (s) => s.replace(/[\u202f\u00a0]/g, ' ');
const formatDate = (iso) => cleanSpaces(new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: DISPLAY_TIMEZONE }));
const formatStamp = (iso) =>
  cleanSpaces(new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: DISPLAY_TIMEZONE }));

const round2 = (n) => Math.round(n * 100) / 100;

function toApiReport(row, events, clientId, geo) {
  const { x, y } = geo.latLngToXy(row.lat, row.lng);
  return {
    id: row.public_id,
    type: row.type,
    x: round2(x),
    y: round2(y),
    lat: row.lat,
    lng: row.lng,
    ai: row.ai_level,
    lv: row.level,
    st: row.status,
    date: formatDate(row.created_at),
    createdAt: row.created_at,
    desc: row.description,
    brgy: BRGY,
    mine: Boolean(clientId) && row.client_id === clientId,
    img: photoUrl(row.photo_file),
    log: events.map((e) => ({ t: e.text, d: formatStamp(e.created_at), at: e.created_at, ...(e.note ? { n: e.note } : {}) })),
  };
}

function eventsByReport(db, reportIds) {
  const map = new Map(reportIds.map((id) => [id, []]));
  if (!reportIds.length) return map;
  const rows = db.all(`SELECT report_id, text, note, created_at FROM report_events WHERE report_id IN (${reportIds.join(',')}) ORDER BY id`);
  for (const r of rows) map.get(r.report_id).push(r);
  return map;
}

function nextPublicId(db) {
  const row = db.get("SELECT MAX(CAST(SUBSTR(public_id, 4) AS INTEGER)) AS n FROM reports");
  return 'RL-' + String((row.n || 0) + 1).padStart(3, '0');
}

/* value comes from validateNewReport(). Returns the report in API format. */

function createReport(db, { geo, uploadsDir, now = () => new Date() }, value, clientId) {
  const assessment = value.assessment;

  const validHazardName = typeof assessment?.hazardName === 'string'
    && assessment.hazardName.trim().length >= 3
    && assessment.hazardName.trim().length <= 60;

  if (
    !assessment ||
    assessment.outcome !== 'hazard_detected' ||
    !['tree', 'drain', 'road', 'pole', 'flood', 'slope', 'river', 'wall', 'other'].includes(value.type) ||
    !['hi', 'mod', 'lo'].includes(assessment.level) ||
    !['gemini', 'fallback'].includes(assessment.source) ||
    typeof assessment.reason !== 'string' ||
    assessment.reason.trim().length < 10 ||
    assessment.reason.trim().length > 200 ||
    (value.type === 'other' && !validHazardName) ||
    (value.type !== 'other' && assessment.hazardName !== null)
  ) {
    throw new Error('A valid server-generated AI hazard assessment is required.');
  }

  const stamp = now().toISOString();
  const photoFile = value.photo ? savePhoto(uploadsDir, value.photo) : null;
  let publicId;

  const baseAssessmentText = assessment.source === 'gemini'
    ? 'AI-assisted assessment generated (Gemini)'
    : 'Rule-based assessment generated';

  const assessmentText = value.type === 'other'
    ? `${baseAssessmentText}: ${assessment.hazardName.trim()}`
    : baseAssessmentText;

  try {
    publicId = db.transaction(() => {
      const id = nextPublicId(db);
      const { lastInsertRowid } = db.run(
        `INSERT INTO reports (public_id, type, lat, lng, ai_level, level, status, description, photo_file, client_id, is_sample, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, 0, ?, ?)`,
        [id, value.type, value.lat, value.lng, assessment.level, assessment.level, value.desc, photoFile, clientId, stamp, stamp]
      );

      db.run(
        'INSERT INTO report_events (report_id, text, created_at) VALUES (?, ?, ?)',
        [lastInsertRowid, 'Report submitted', stamp]
      );

      db.run(
        'INSERT INTO report_events (report_id, text, note, created_at) VALUES (?, ?, ?, ?)',
        [lastInsertRowid, assessmentText, assessment.reason || null, stamp]
      );

      return id;
    });
  } catch (err) {
    removePhoto(uploadsDir, photoFile);
    throw err;
  }

  return getReport(db, { geo }, publicId, clientId);
}

/* options: { clientId, mineOnly }. Newest first. */
function listReports(db, { geo }, { clientId = null, mineOnly = false } = {}) {
  const rows = mineOnly
    ? db.all('SELECT * FROM reports WHERE client_id = ? ORDER BY id DESC LIMIT ?', [clientId, MAX_LIST])
    : db.all('SELECT * FROM reports ORDER BY id DESC LIMIT ?', [MAX_LIST]);
  const events = eventsByReport(db, rows.map((r) => r.id));
  return rows.map((r) => toApiReport(r, events.get(r.id), clientId, geo));
}

/* Returns the report or null. A malformed id simply returns null (never reaches SQL). */
function getReport(db, { geo }, publicId, clientId = null) {
  if (typeof publicId !== 'string' || !PUBLIC_ID.test(publicId)) return null;
  const row = db.get('SELECT * FROM reports WHERE public_id = ?', [publicId]);
  if (!row) return null;
  return toApiReport(row, eventsByReport(db, [row.id]).get(row.id), clientId, geo);
}

/* ---- admin review: change the status / level and add remarks -------------------------------------------------------
   Timeline texts are the SAME ones the frontend demo writes (js/api.js), so the timeline looks the same in both modes.
   Moving exactly one step forward in the project's order (Pending, Verified, Under monitoring, Resolved) gets a
   milestone text. Any other change (going back, skipping a step) reads "Status changed to <status>". */

const LEVEL_NAMES = Object.freeze({ hi: 'High', mod: 'Moderate', lo: 'Low' });
const MILESTONE_TEXT = Object.freeze(['', 'Verified by barangay admin', 'Placed under monitoring', 'Marked as resolved']);
const DUPLICATE_REMARK_WINDOW_MS = 30 * 1000;

function statusEventText(from, to) {
  const a = STATUSES.indexOf(from);
  const b = STATUSES.indexOf(to);
  return b === a + 1 ? MILESTONE_TEXT[b] : `Status changed to ${to}`;
}

function isDuplicateRemark(db, reportRowId, note, stamp) {
  const last = db.get('SELECT note, created_at FROM report_events WHERE report_id = ? ORDER BY id DESC LIMIT 1', [reportRowId]);
  return Boolean(last && last.note === note && Date.parse(stamp) - Date.parse(last.created_at) < DUPLICATE_REMARK_WINDOW_MS);
}

function updateReport(db, { geo, now = () => new Date() }, publicId, patch, clientId = null) {
  if (typeof publicId !== 'string' || !PUBLIC_ID.test(publicId)) return null;
  const stamp = now().toISOString();

  const changed = db.transaction(() => {
    const row = db.get('SELECT * FROM reports WHERE public_id = ?', [publicId]);
    if (!row) return null;
    const done = { status: false, level: false, remark: false };
    const events = [];
    const note = patch.remark || null;

    if (patch.status && patch.status !== row.status) {
      events.push({ text: statusEventText(row.status, patch.status), note });
      done.status = true;
      done.remark = Boolean(note);
    } else if (note && !isDuplicateRemark(db, row.id, note, stamp)) {
      events.push({ text: 'Admin remark added', note });
      done.remark = true;
    }
    if (patch.level && patch.level !== row.level) {
      events.push({ text: `Risk level set to ${LEVEL_NAMES[patch.level]} by admin`, note: null });
      done.level = true;
    }

    if (events.length) {
      db.run('UPDATE reports SET status = ?, level = ?, updated_at = ? WHERE id = ?', [patch.status || row.status, patch.level || row.level, stamp, row.id]);
      for (const e of events) {
        db.run('INSERT INTO report_events (report_id, text, note, created_at) VALUES (?, ?, ?, ?)', [row.id, e.text, e.note, stamp]);
      }
    }
    return done;
  });

  if (!changed) return null;
  return { report: getReport(db, { geo }, publicId, clientId), changed };
}

module.exports = { createReport, listReports, getReport, updateReport, nextPublicId, formatDate, formatStamp, BRGY, MAX_LIST, PUBLIC_ID };
