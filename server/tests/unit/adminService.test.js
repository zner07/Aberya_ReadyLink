'use strict';
/* The admin review logic with a real database, for every available SQLite driver. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { updateReport, getReport, listReports, createReport } = require('../../src/services/reportService');
const { validateNewReport, validateUpdate } = require('../../src/services/reportValidation');
const { seedSamples } = require('../../src/services/seedService');
const { openDatabase } = require('../../src/db');
const images = require('../helpers/images');
const { DRIVERS, geo, FRONTEND_DIR, CLIENT_A, memoryDb, tempDir, removeDir } = require('../helpers/env');

const T0 = new Date('2026-10-12T05:00:00.000Z');
const at = (seconds) => () => new Date(T0.getTime() + seconds * 1000);
const patch = (body) => {
  const { value, errors } = validateUpdate(body);
  assert.deepEqual(errors, {}, JSON.stringify(body));
  return value;
};
const newReport = (db, uploadsDir, extra = {}) => {
  const { value } = validateNewReport({ type: 'drain', x: 500, y: 300, desc: 'Blocked drain.', level: 'hi', ...extra }, { geo, maxPhotoBytes: 5e6 });
  return createReport(db, { geo, uploadsDir, now: () => T0 }, {
  ...value,
  assessment: {
    outcome: 'hazard_detected',
    level: 'hi',
    hazardName: null,
    source: 'fallback',
    reason: 'Test rule-based assessment for admin service.',
    demo: false,
  },
}, CLIENT_A);
};
const logTexts = (r) => r.log.map((e) => e.t);

for (const driver of DRIVERS) {
  const t = (name, fn) =>
    test(`[${driver}] ${name}`, () => {
      const db = memoryDb(driver);
      const uploadsDir = tempDir('readylink-admin-');
      try {
        seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
        return fn({ db, uploadsDir, ctx: { geo, now: at(60) } });
      } finally {
        db.close();
        removeDir(uploadsDir);
      }
    });

  t('a status change is saved and the updated report is returned', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' }));
    assert.equal(out.report.id, 'RL-026');
    assert.equal(out.report.st, 'Verified');
    assert.deepEqual(out.changed, { status: true, level: false, remark: false });
    assert.equal(getReport(db, { geo }, 'RL-026').st, 'Verified', 'reading it again gives the new status');
  });

  t('the whole workflow works: Pending -> Verified -> Under monitoring -> Resolved', ({ db, ctx }) => {
    const seen = [];
    for (const status of ['Verified', 'Under monitoring', 'Resolved']) seen.push(updateReport(db, ctx, 'RL-026', patch({ status })).report.st);
    assert.deepEqual(seen, ['Verified', 'Under monitoring', 'Resolved']);
  });

  t('the other order from the request also works (Pending -> Under monitoring -> Verified), because any change is allowed', ({ db, ctx }) => {
    assert.equal(updateReport(db, ctx, 'RL-026', patch({ status: 'Under Monitoring' })).report.st, 'Under monitoring');
    assert.equal(updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' })).report.st, 'Verified');
    assert.deepEqual(logTexts(getReport(db, { geo }, 'RL-026')).slice(2), ['Status changed to Under monitoring', 'Status changed to Verified']);
  });

  t('the timeline keeps the original entries and adds ONE entry per change, with a timestamp', ({ db, ctx }) => {
    const before = getReport(db, { geo }, 'RL-026').log;
    assert.deepEqual(before.map((e) => e.t), ['Report submitted', 'AI-assisted assessment generated']);
    const after = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' })).report.log;
    assert.equal(after.length, 3);
    assert.deepEqual(after.slice(0, 2), before, 'the submission and AI entries are untouched');
    assert.equal(after[2].t, 'Verified by barangay admin');
    assert.equal(after[2].at, '2026-10-12T05:01:00.000Z');
    assert.equal(after[2].d, 'Oct 12, 1:01 PM');
    assert.equal(after[2].n, undefined);
  });

  t('timeline texts are the same ones the frontend demo writes', ({ db, ctx }) => {
    const texts = [];
    for (const status of ['Verified', 'Under monitoring', 'Resolved']) texts.push(logTexts(updateReport(db, ctx, 'RL-026', patch({ status })).report).pop());
    assert.deepEqual(texts, ['Verified by barangay admin', 'Placed under monitoring', 'Marked as resolved']);
    assert.equal(logTexts(updateReport(db, ctx, 'RL-026', patch({ status: 'Pending' })).report).pop(), 'Status changed to Pending', 'going back');
    assert.equal(logTexts(updateReport(db, ctx, 'RL-026', patch({ status: 'Resolved' })).report).pop(), 'Status changed to Resolved', 'skipping steps');
  });

  t('asking for the status it already has changes nothing and writes no history', ({ db, ctx }) => {
    const before = getReport(db, { geo }, 'RL-026');
    const out = updateReport(db, ctx, 'RL-026', patch({ status: 'Pending' }));
    assert.deepEqual(out.changed, { status: false, level: false, remark: false });
    assert.deepEqual(out.report, before);
    assert.equal(db.get('SELECT updated_at FROM reports WHERE public_id = ?', ['RL-026']).updated_at, '2026-09-30T04:00:00.000Z', 'updated_at is not touched either');
  });

  t('sending the same change twice (a double click) records it only once', ({ db, ctx }) => {
    updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' }));
    const again = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' }));
    assert.equal(again.report.log.length, 3);
    assert.equal(again.changed.status, false);
  });

  t('a remark is saved on its own with the timestamp, and appears in the timeline', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ remark: 'Wire reported to the electric cooperative.' }));
    assert.deepEqual(out.changed, { status: false, level: false, remark: true });
    assert.equal(out.report.st, 'Pending', 'a remark alone does not change the status');
    const entry = out.report.log.pop();
    assert.deepEqual([entry.t, entry.n, entry.at], ['Admin remark added', 'Wire reported to the electric cooperative.', '2026-10-12T05:01:00.000Z']);
  });

  t('a remark that comes with a status change is attached to that status entry (one entry, not two)', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified', remark: 'Checked on site.' }));
    assert.deepEqual(out.changed, { status: true, level: false, remark: true });
    assert.equal(out.report.log.length, 3);
    assert.deepEqual([out.report.log[2].t, out.report.log[2].n], ['Verified by barangay admin', 'Checked on site.']);
  });

  t('the same remark sent again within 30 seconds is not written twice, a different one is', ({ db }) => {
    updateReport(db, { geo, now: at(10) }, 'RL-026', patch({ remark: 'Same note.' }));
    const dup = updateReport(db, { geo, now: at(20) }, 'RL-026', patch({ remark: 'Same note.' }));
    assert.equal(dup.report.log.length, 3);
    assert.equal(dup.changed.remark, false);
    const other = updateReport(db, { geo, now: at(25) }, 'RL-026', patch({ remark: 'Another note.' }));
    assert.equal(other.report.log.length, 4);
    const later = updateReport(db, { geo, now: at(200) }, 'RL-026', patch({ remark: 'Another note.' }));
    assert.equal(later.report.log.length, 5, 'after 30 seconds the same words are a new remark');
  });

  t('a status change with a remark followed by the identical request does not duplicate the remark', ({ db }) => {
    updateReport(db, { geo, now: at(10) }, 'RL-026', patch({ status: 'Verified', remark: 'Checked on site.' }));
    const again = updateReport(db, { geo, now: at(12) }, 'RL-026', patch({ status: 'Verified', remark: 'Checked on site.' }));
    assert.equal(again.report.log.length, 3);
    assert.deepEqual(again.changed, { status: false, level: false, remark: false });
  });

  t('changing the risk level is saved and recorded; the AI suggestion (ai) is never changed', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ level: 'lo' }));
    assert.equal(out.report.lv, 'lo');
    assert.equal(out.report.ai, 'hi', 'the original suggestion stays');
    assert.equal(out.report.log.pop().t, 'Risk level set to Low by admin');
    assert.equal(updateReport(db, ctx, 'RL-026', patch({ level: 'lo' })).changed.level, false, 'same level again does nothing');
  });

  t('status, level and remark together are saved atomically', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified', level: 'mod', remark: 'Rechecked.' }));
    assert.deepEqual(out.changed, { status: true, level: true, remark: true });
    assert.deepEqual([out.report.st, out.report.lv], ['Verified', 'mod']);
    assert.deepEqual(logTexts(out.report).slice(2), ['Verified by barangay admin', 'Risk level set to Moderate by admin']);
  });

  t('a failure in the middle leaves no half-saved change (status and history always agree)', ({ db, ctx }) => {
    const failing = Object.create(db);
    failing.run = (sql, params) => {
      if (/INSERT INTO report_events/.test(sql)) throw new Error('disk full');
      return db.run(sql, params);
    };
    assert.throws(() => updateReport(failing, ctx, 'RL-026', patch({ status: 'Verified', remark: 'x' })), /disk full/);
    const after = getReport(db, { geo }, 'RL-026');
    assert.equal(after.st, 'Pending', 'the status was rolled back');
    assert.equal(after.log.length, 2, 'and so was the history');
  });

  t('a report that does not exist, or a malformed id, returns null and changes nothing', ({ db, ctx }) => {
    for (const id of ['RL-404', "RL-026' OR '1'='1", 'rl-026', 'RL-26', '', null, undefined, 5, {}]) {
      assert.equal(updateReport(db, ctx, id, patch({ status: 'Resolved' })), null, String(id));
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM reports WHERE status = 'Resolved'").n, 2, 'only the 2 sample reports that were already resolved');
  });

  t('only the chosen report changes', ({ db, ctx }) => {
    const before = new Map(listReports(db, { geo }).map((r) => [r.id, JSON.stringify(r)]));
    updateReport(db, ctx, 'RL-026', patch({ status: 'Verified', remark: 'x', level: 'lo' }));
    for (const r of listReports(db, { geo })) {
      if (r.id !== 'RL-026') assert.equal(JSON.stringify(r), before.get(r.id), `${r.id} must be unchanged`);
    }
  });

  t('the photo, location, description and owner of the report are untouched by a review', ({ db, uploadsDir, ctx }) => {
    const created = newReport(db, uploadsDir, { photo: images.dataUrl('jpeg') });
    const out = updateReport(db, ctx, created.id, patch({ status: 'Verified', remark: 'ok' }), CLIENT_A);
    for (const key of ['id', 'type', 'x', 'y', 'lat', 'lng', 'desc', 'img', 'ai', 'createdAt', 'date', 'brgy']) assert.equal(out.report[key], created[key], key);
    assert.equal(out.report.mine, true, 'the owner still sees it as theirs');
    assert.equal(getReport(db, { geo }, created.id).mine, false, 'and others do not');
  });

  t('updated_at changes only when something changed', ({ db, ctx }) => {
    updateReport(db, ctx, 'RL-026', patch({ status: 'Verified' }));
    assert.equal(db.get('SELECT updated_at FROM reports WHERE public_id = ?', ['RL-026']).updated_at, '2026-10-12T05:01:00.000Z');
  });

  t('the admin response never contains the client id or database internals', ({ db, ctx }) => {
    const out = updateReport(db, ctx, 'RL-026', patch({ status: 'Verified', remark: 'x' }), CLIENT_A);
    assert.doesNotMatch(JSON.stringify(out), /client|photo_file|public_id|is_sample|updated_at/);
  });

  test(`[${driver}] a saved status and its history are still there after the database is closed and opened again`, () => {
    const dir = tempDir();
    const file = path.join(dir, 'review.db');
    let db = null;
    try {
      db = openDatabase(file, { driver });
      seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
      updateReport(db, { geo, now: at(60) }, 'RL-026', patch({ status: 'Verified', remark: 'Checked on site.' }));
      updateReport(db, { geo, now: at(120) }, 'RL-026', patch({ status: 'Under monitoring', level: 'mod' }));
      db.close();
      db = null;

      db = openDatabase(file, { driver }); // like restarting the server
      const r = getReport(db, { geo }, 'RL-026');
      assert.deepEqual([r.st, r.lv, r.ai], ['Under monitoring', 'mod', 'hi']);
      assert.deepEqual(r.log.map((e) => e.t), ['Report submitted', 'AI-assisted assessment generated', 'Verified by barangay admin', 'Placed under monitoring', 'Risk level set to Moderate by admin']);
      assert.equal(r.log[2].n, 'Checked on site.');
      assert.deepEqual(r.log.map((e) => e.at).slice(2), ['2026-10-12T05:01:00.000Z', '2026-10-12T05:02:00.000Z', '2026-10-12T05:02:00.000Z']);
      db.close();
      db = null;
    } finally {
      if (db) db.close();
      removeDir(dir);
    }
  });
}

