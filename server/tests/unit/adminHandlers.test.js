'use strict';
/* The HTTP layer of PATCH /api/reports/:id, called directly with simple fake request/response objects.
   (The real Express route is covered by tests/integration/admin.test.js.) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReportHandlers } = require('../../src/routes/reports');
const { errorBody } = require('../../src/middleware/errors');
const { seedSamples } = require('../../src/services/seedService');
const { DRIVERS, geo, FRONTEND_DIR, CLIENT_A, memoryDb, testConfig, removeDir } = require('../helpers/env');

const NOW = new Date('2026-10-12T05:00:00.000Z');
const fakeRes = () => ({ statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } });
function call(handler, req) {
  const res = fakeRes();
  let error;
  // Since the admin login exists, the handler needs req.admin (the route guard sets it). These tests run AFTER a login by default.
  // A test can pass admin: null to try the handler without one.
  handler({ headers: {}, query: {}, params: {}, admin: { name: 'tester' }, ...req, headers: { ...(req.headers || {}) } }, res, (e) => { error = e; });
  return { res, error };
}
const json = (extra = {}) => ({ 'content-type': 'application/json', host: 'localhost:3000', ...extra });
const code = (error) => errorBody(error).body.error.code;

for (const driver of DRIVERS) {
  const t = (name, fn, env = {}) =>
    test(`[${driver}] ${name}`, () => {
      const db = memoryDb(driver);
      const { dir, config } = testConfig(env);
      try {
        seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
        return fn({ db, config, handlers: createReportHandlers({ db, geo, config, now: () => NOW }) });
      } finally {
        db.close();
        removeDir(dir);
      }
    });
  const patch = (handlers, id, body, headers = json()) => call(handlers.update, { params: { id }, body, headers });

  t('without a signed-in admin the handler itself refuses (401) and changes nothing, even if the route guard were missing', ({ handlers, db }) => {
    const { error } = call(handlers.update, { params: { id: 'RL-026' }, body: { status: 'Verified' }, headers: json(), admin: null });
    assert.equal(errorBody(error).status, 401);
    assert.equal(code(error), 'UNAUTHENTICATED');
    assert.equal(db.get('SELECT status FROM reports WHERE public_id = ?', ['RL-026']).status, 'Pending');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM report_events WHERE report_id = (SELECT id FROM reports WHERE public_id = ?)', ['RL-026']).n, 2);
  });

  t('the login check comes first: with no admin AND admin changes turned off the answer is 401, not 403', ({ handlers }) => {
    assert.equal(code(call(handlers.update, { params: { id: 'RL-026' }, body: { status: 'Verified' }, headers: json(), admin: null }).error), 'UNAUTHENTICATED');
  }, { ADMIN_WRITES: 'off' });

  t('a valid status change: 200 with the updated report and what changed', ({ handlers, db }) => {
    const { res, error } = patch(handlers, 'RL-026', { status: 'Verified' });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.report.id, 'RL-026');
    assert.equal(res.body.report.st, 'Verified');
    assert.deepEqual(res.body.changed, { status: true, level: false, remark: false });
    assert.equal(db.get('SELECT status FROM reports WHERE public_id = ?', ['RL-026']).status, 'Verified', 'it is in the database, not only in the answer');
  });

  t('"Under Monitoring" with capital letters is accepted and stored in the exact project spelling', ({ handlers }) => {
    assert.equal(patch(handlers, 'RL-026', { status: 'Under Monitoring' }).res.body.report.st, 'Under monitoring');
  });

  t('an invalid status: 400 VALIDATION with a message, and nothing changes', ({ handlers, db }) => {
    for (const status of ['Done', 'Closed', '', 5, null]) {
      const { error } = patch(handlers, 'RL-026', { status });
      assert.equal(errorBody(error).status, 400, String(status));
      assert.equal(code(error), 'VALIDATION');
    }
    assert.match(errorBody(patch(handlers, 'RL-026', { status: 'Done' }).error).body.error.fields.status, /Use one of/);
    assert.equal(db.get('SELECT status FROM reports WHERE public_id = ?', ['RL-026']).status, 'Pending');
  });

  t('nothing to change, or a body that is not an object: 400', ({ handlers }) => {
    for (const body of [{}, { remark: '' }, undefined, null, 'Verified', []]) {
      const { error } = patch(handlers, 'RL-026', body);
      assert.equal(errorBody(error).status, 400, JSON.stringify(body));
      assert.equal(code(error), 'VALIDATION');
    }
  });

  t('a missing report: 404 NOT_FOUND; a malformed id is also 404 and never reaches SQL', ({ handlers, db }) => {
    for (const id of ['RL-404', "RL-026' OR '1'='1", 'rl-026', '..', 'RL-1']) {
      const { error } = patch(handlers, id, { status: 'Resolved' });
      assert.equal(errorBody(error).status, 404, id);
      assert.equal(code(error), 'NOT_FOUND');
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM reports WHERE status = 'Resolved'").n, 2);
  });

  t('the body must be JSON: 415 otherwise', ({ handlers }) => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const { error } = patch(handlers, 'RL-026', { status: 'Verified' }, json({ 'content-type': type }));
      assert.equal(errorBody(error).status, 415, String(type));
      assert.equal(code(error), 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  t('admin changes turned off: 403 ADMIN_WRITES_DISABLED and nothing changes', ({ handlers, db }) => {
    const { error } = patch(handlers, 'RL-026', { status: 'Verified' });
    assert.equal(errorBody(error).status, 403);
    assert.equal(code(error), 'ADMIN_WRITES_DISABLED');
    assert.match(errorBody(error).body.error.message, /no login/i);
    assert.equal(db.get('SELECT status FROM reports WHERE public_id = ?', ['RL-026']).status, 'Pending');
  }, { ADMIN_WRITES: 'off' });

  t('admin changes are refused by default on a network-reachable server', ({ handlers }) => {
    assert.equal(code(patch(handlers, 'RL-026', { status: 'Verified' }).error), 'ADMIN_WRITES_DISABLED');
  }, { HOST: '0.0.0.0' });
  t('admin changes are refused by default in production', ({ handlers }) => {
    assert.equal(code(patch(handlers, 'RL-026', { status: 'Verified' }).error), 'ADMIN_WRITES_DISABLED');
  }, { NODE_ENV: 'production' });
  t('ADMIN_WRITES=on allows them anywhere (explicit choice)', ({ handlers }) => {
    assert.equal(patch(handlers, 'RL-026', { status: 'Verified' }).res.statusCode, 200);
  }, { HOST: '0.0.0.0', ADMIN_WRITES: 'on' });

  t('a request that comes from another website is refused (403 FORBIDDEN_ORIGIN)', ({ handlers, db }) => {
    for (const origin of ['https://evil.example', 'http://localhost:4000', 'http://localhost', 'null', 'not a url']) {
      const { error } = patch(handlers, 'RL-026', { status: 'Verified' }, json({ origin }));
      assert.equal(errorBody(error).status, 403, origin);
      assert.equal(code(error), 'FORBIDDEN_ORIGIN');
    }
    assert.equal(db.get('SELECT status FROM reports WHERE public_id = ?', ['RL-026']).status, 'Pending');
  });

  t('a request from this server\'s own page (same host) or with no Origin is accepted', ({ handlers }) => {
    assert.equal(patch(handlers, 'RL-026', { status: 'Verified' }, json({ origin: 'http://localhost:3000' })).res.statusCode, 200);
    assert.equal(patch(handlers, 'RL-026', { remark: 'x' }, json({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })).res.statusCode, 200);
    const noOrigin = { 'content-type': 'application/json' }; // curl, PowerShell, tests
    assert.equal(patch(handlers, 'RL-026', { level: 'lo' }, noOrigin).res.statusCode, 200);
  });

  t('history comes back in the same format as everywhere else: { t, d, at, n? }', ({ handlers }) => {
    const { res } = patch(handlers, 'RL-026', { status: 'Verified', remark: 'Checked on site.' });
    const last = res.body.report.log.pop();
    assert.deepEqual(Object.keys(last).sort(), ['at', 'd', 'n', 't']);
    assert.deepEqual([last.t, last.n, last.at, last.d], ['Verified by barangay admin', 'Checked on site.', '2026-10-12T05:00:00.000Z', 'Oct 12, 1:00 PM']);
  });

  t('the same request twice: the second one is a harmless no-op (200, changed all false, no duplicate history)', ({ handlers }) => {
    patch(handlers, 'RL-026', { status: 'Verified', remark: 'Once.' });
    const { res } = patch(handlers, 'RL-026', { status: 'Verified', remark: 'Once.' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.changed, { status: false, level: false, remark: false });
    assert.equal(res.body.report.log.length, 3);
  });

  t('a valid X-Client-Id only fills the "mine" label and is never required or returned', ({ handlers }) => {
    const none = patch(handlers, 'RL-026', { remark: 'a' });
    assert.equal(none.res.statusCode, 200);
    assert.equal(none.res.body.report.mine, false);
    const withId = patch(handlers, 'RL-026', { remark: 'b' }, json({ 'x-client-id': CLIENT_A }));
    assert.equal(withId.res.statusCode, 200);
    assert.doesNotMatch(JSON.stringify(withId.res.body), /client-/);
    const bad = patch(handlers, 'RL-026', { remark: 'c' }, json({ 'x-client-id': '!!bad!!' }));
    assert.equal(bad.res.statusCode, 200, 'a malformed id is ignored, not an error');
  });

  t('a client cannot change anything else by adding extra fields', ({ handlers, db }) => {
    patch(handlers, 'RL-026', { status: 'Verified', desc: 'hacked', type: 'tree', id: 'RL-999', img: '/x.jpg', ai: 'lo', lat: 1, x: 5 });
    const row = db.get('SELECT * FROM reports WHERE public_id = ?', ['RL-026']);
    assert.equal(row.description, 'Pole is cracked at the base and a wire hangs low over the footpath.', 'the description is exactly the sample text');
    assert.equal(row.type, 'pole');
    assert.equal(row.ai_level, 'hi');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM reports WHERE public_id = 'RL-999'").n, 0);
  });
}
