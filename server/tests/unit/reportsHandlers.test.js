'use strict';
/* These tests call the handler functions directly with small fake request/response objects.
   They check the logic of the HTTP layer (status codes, error shapes, headers, what is returned).
   They do NOT prove that Express routes and parses requests: that is what tests/integration/reports.test.js does. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReportHandlers } = require('../../src/routes/reports');
const { createUploadsHandler } = require('../../src/routes/uploads');
const { AppError, errorBody } = require('../../src/middleware/errors');
const { seedSamples } = require('../../src/services/seedService');
const images = require('../helpers/images');
const { DRIVERS, geo, FRONTEND_DIR, CLIENT_A, CLIENT_B, memoryDb, testConfig, removeDir } = require('../helpers/env');

const NOW = new Date('2026-10-12T05:00:00.000Z');
const body = (extra = {}) => ({ type: 'drain', x: 500, y: 300, desc: 'Blocked drain.', level: 'hi', ...extra });

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/* Calls a handler and returns { res, error }. Handlers must report problems through next(err), not by throwing. */
async function call(handler, req) {
  const res = fakeRes();
  let error;

  await handler(
    { headers: {}, query: {}, params: {}, ...req, headers: { ...(req.headers || {}) } },
    res,
    (err) => { error = err; }
  );

  return { res, error };
}
const json = (extra = {}) => ({ 'content-type': 'application/json', 'x-client-id': CLIENT_A, ...extra });

for (const driver of DRIVERS) {
  const t = (name, fn) =>
  test(`[${driver}] ${name}`, async () => {
      const db = memoryDb(driver);
      const { dir, config } = testConfig();
      try {
        const aiService = {
  async analyzeReport({ desc, selectedType }) {
    return {
  outcome: 'hazard_detected',
  type: selectedType || 'drain',
  level: 'mod',
  hazardName: null,
  reason: 'Test assessment for report handler.',
  source: 'fallback',
  demo: false
};
  }
};

const handlers = createReportHandlers({
  db, geo, config, now: () => NOW, aiService
});
        return await fn({ db, config, handlers, dir });
      } finally {
        db.close();
        removeDir(dir);
      }
    });

  t('POST creates a report: 201, Location header and the report in the body', async ({ handlers, db }) => {
      const { res, error } = await call(handlers.create, { headers: json(), body: body() });
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers.Location, '/api/reports/RL-001');
    assert.equal(res.body.report.id, 'RL-001');
    assert.equal(res.body.report.st, 'Pending');
    assert.equal(res.body.report.mine, true);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 1);
  });


  t('POST without an AI service -> 503 AI_UNAVAILABLE', async ({ db, config }) => {
    const handlers = createReportHandlers({ db, geo, config, now: () => NOW });
    const { error } = await call(handlers.create, { headers: json(), body: body() });

    assert.ok(error instanceof AppError);
    assert.equal(errorBody(error).status, 503);
    assert.equal(errorBody(error).body.error.code, 'AI_UNAVAILABLE');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
  });

  t('POST with an uncertain AI result -> 422 AI_UNCERTAIN', async ({ db, config }) => {
  const aiService = {
    async analyzeReport() {
      return {
        outcome: 'uncertain',
        type: null,
        level: null,
        hazardName: null,
        reason: 'Could not confidently classify this report.',
        source: 'fallback',
        demo: false
      };
    },
  };
  const handlers = createReportHandlers({ db, geo, config, now: () => NOW, aiService });
  const { error } = await call(handlers.create, { headers: json(), body: body() });

  assert.ok(error instanceof AppError);
  assert.equal(errorBody(error).status, 422);
  assert.equal(errorBody(error).body.error.code, 'AI_UNCERTAIN');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
});

  t('POST passes an AI service error to the error handler', async ({ db, config }) => {
    const failure = new Error('Test AI service failure');
    const aiService = {
      async analyzeReport() {
        throw failure;
      },
    };
    const handlers = createReportHandlers({ db, geo, config, now: () => NOW, aiService });
    const { error } = await call(handlers.create, { headers: json(), body: body() });

    assert.equal(error, failure);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
  });

    t('POST rejects invalid AI assessment metadata and saves no report', async ({ db, config }) => {
  const validBase = {
    outcome: 'hazard_detected',
    type: 'drain',
    level: 'mod',
    hazardName: null,
    source: 'fallback',
    reason: 'A valid test reason.',
    demo: false
  };

  const invalidAssessments = [
    { ...validBase, source: 'unknown' },
    { ...validBase, reason: 'short' },
    { ...validBase, reason: '   ' },
    { ...validBase, reason: 'x'.repeat(201) },
  ];

  for (const assessment of invalidAssessments) {
    const aiService = {
      async analyzeReport() {
        return assessment;
      },
    };
    const handlers = createReportHandlers({ db, geo, config, now: () => NOW, aiService });
    const { error } = await call(handlers.create, { headers: json(), body: body() });

    assert.ok(error instanceof AppError);
    assert.equal(errorBody(error).status, 422);
    assert.equal(errorBody(error).body.error.code, 'AI_INVALID_ASSESSMENT');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
  }
});

  t('POST keeps the photo: it is stored and the report links to it', async ({ handlers, config }) => {
    const { res } = await call(handlers.create, { headers: json(), body: body({ photo: images.dataUrl('jpeg') }) });
    assert.equal(res.statusCode, 201);
    assert.match(res.body.report.img, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);
    assert.ok(fs.existsSync(path.join(config.uploadsDir, path.basename(res.body.report.img))));
  });

  t('POST ignores an id, status or owner chosen by the client', async ({ handlers }) => {
    const { res } = await call(handlers.create, { headers: json(), body: body({ id: 'RL-999', status: 'Resolved', st: 'Resolved', mine: false, client_id: CLIENT_B }) });
    assert.equal(res.body.report.id, 'RL-001');
    assert.equal(res.body.report.st, 'Pending');
    assert.equal(res.body.report.mine, true);
  });

  t('POST with a wrong content type -> 415', async ({ handlers }) => {
    for (const type of [undefined, 'text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
      const { error } = await call(handlers.create, { headers: json({ 'content-type': type }), body: body() });
      assert.ok(error instanceof AppError, String(type));
      assert.equal(errorBody(error).status, 415);
      assert.equal(errorBody(error).body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  t('POST without or with an invalid X-Client-Id -> 400', async ({ handlers, db }) => {
    let out = await call(handlers.create, { headers: { 'content-type': 'application/json' }, body: body() });
    assert.equal(errorBody(out.error).body.error.code, 'CLIENT_ID_REQUIRED');
    for (const bad of ['short', 'has spaces in the identifier', 'x'.repeat(70)]) {
      out = await call(handlers.create, { headers: json({ 'x-client-id': bad }), body: body() });
      assert.equal(errorBody(out.error).status, 400);
      assert.equal(errorBody(out.error).body.error.code, 'INVALID_CLIENT_ID');
    }
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
  });

  t('POST with bad data -> 400 VALIDATION with a message per field, and nothing is saved', async ({ handlers, db, config }) => {
    const { error } = await call(handlers.create, { headers: json(), body: { type: 'bridge', x: 5, y: 5, desc: 'x'.repeat(300), level: 'urgent', photo: 'nope' } });
    const { status, body: payload } = errorBody(error);
    assert.equal(status, 400);
    assert.equal(payload.error.code, 'VALIDATION');
    assert.deepEqual(Object.keys(payload.error.fields).sort(), ['desc', 'level', 'location', 'photo', 'type']);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM reports').n, 0);
    assert.ok(!fs.existsSync(config.uploadsDir) || fs.readdirSync(config.uploadsDir).length === 0);
  });

  t('POST with no body or a body that is not an object -> 400 VALIDATION', async ({ handlers }) => {
    for (const bad of [undefined, null, 'text', 42, [], [body()]]) {
      const { error } = await call(handlers.create, { headers: json(), body: bad });
      assert.equal(errorBody(error).status, 400, String(bad));
      assert.equal(errorBody(error).body.error.code, 'VALIDATION');
    }
  });

  t('POST: a photo that is not a real image is refused and no file is left behind', async ({ handlers, config }) => {
    const fake = images.dataUrlFromBuffer(Buffer.from('<script>alert(1)</script>'), 'image/jpeg');
    const { error } = await call(handlers.create, { headers: json(), body: body({ photo: fake }) });
    assert.match(errorBody(error).body.error.fields.photo, /not a JPEG, PNG or WEBP/);
    assert.ok(!fs.existsSync(config.uploadsDir) || fs.readdirSync(config.uploadsDir).length === 0);
  });

  t('POST: a photo over the size limit is refused', async ({ db, config }) => {
    const small = { ...config, maxPhotoBytes: 200 };
    const handlers = createReportHandlers({ db, geo, config: small, now: () => NOW });
    const { error } = await call(handlers.create, { headers: json(), body: body({ photo: images.dataUrl('jpeg') }) });
    assert.match(errorBody(error).body.error.fields.photo, /too large/);
  });

  t('GET /api/reports returns { reports } for the public map, newest first', async ({ handlers }) => {
    await call(handlers.create, { headers: json(), body: body() });
    await call(handlers.create, { headers: json({ 'x-client-id': CLIENT_B }), body: body({ type: 'tree' }) });
    const { res, error } = await call(handlers.list, {});
    assert.equal(error, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.reports.map((r) => r.id), ['RL-002', 'RL-001']);
    assert.deepEqual(res.body.reports.map((r) => r.mine), [false, false], 'no client id sent, so nothing is "mine"');
  });

  t('GET /api/reports marks the sender\'s own reports as mine', async ({ handlers }) => {
    await call(handlers.create, { headers: json(), body: body() });
    await call(handlers.create, { headers: json({ 'x-client-id': CLIENT_B }), body: body() });
    const { res } = await call(handlers.list, { headers: { 'x-client-id': CLIENT_A } });
    assert.deepEqual(res.body.reports.map((r) => r.mine), [false, true]);
  });

  t('GET /api/reports?mine=1 returns only this device\'s reports, and needs a client id', async ({ handlers }) => {
    await call(handlers.create, { headers: json(), body: body() });
    await call(handlers.create, { headers: json({ 'x-client-id': CLIENT_B }), body: body() });
    const own = await call(handlers.list, { query: { mine: '1' }, headers: { 'x-client-id': CLIENT_B } });
    assert.deepEqual(own.res.body.reports.map((r) => r.id), ['RL-002']);
    const stranger = await call(handlers.list, { query: { mine: '1' }, headers: { 'x-client-id': 'client-cccccccccccccccc' } });
    assert.deepEqual(stranger.res.body.reports, []);
    for (const headers of [{}, { 'x-client-id': 'bad' }]) {
      const { error } = await call(handlers.list, { query: { mine: '1' }, headers });
      assert.equal(errorBody(error).status, 400);
      assert.equal(errorBody(error).body.error.code, 'CLIENT_ID_REQUIRED');
    }
  });

  t('GET /api/reports ignores a malformed X-Client-Id instead of failing', async ({ handlers }) => {
    await call(handlers.create, { headers: json(), body: body() });
    const { res, error } = await call(handlers.list, { headers: { 'x-client-id': '!!bad!!' } });
    assert.equal(error, undefined);
    assert.equal(res.body.reports.length, 1);
    assert.equal(res.body.reports[0].mine, false);
  });

  t('GET /api/reports/:id returns the report, or 404 NOT_FOUND', async ({ handlers }) => {
    await call(handlers.create, { headers: json(), body: body() });
    const ok = await call(handlers.getOne, { params: { id: 'RL-001' }, headers: { 'x-client-id': CLIENT_A } });
    assert.equal(ok.res.body.report.id, 'RL-001');
    assert.equal(ok.res.body.report.mine, true);
    for (const id of ['RL-404', "RL-001' OR '1'='1", 'rl-001', '..', 'RL-1']) {
      const { error } = await call(handlers.getOne, { params: { id } });
      assert.equal(errorBody(error).status, 404, id);
      assert.equal(errorBody(error).body.error.code, 'NOT_FOUND');
    }
  });

  t('no response ever contains a client id or a file path', async ({ handlers, config }) => {
    await call(handlers.create, { headers: json(), body: body({ photo: images.dataUrl('png') }) });
    const listed = (await call(handlers.list, { headers: { 'x-client-id': CLIENT_A } })).res.body;
    const single = (await call(handlers.getOne, { params: { id: 'RL-001' }, headers: { 'x-client-id': CLIENT_A } })).res.body;
    const text = JSON.stringify([listed, single]);
    assert.doesNotMatch(text, /client-/);
    assert.ok(!text.includes(config.uploadsDir), 'the server folder must not appear');
    assert.doesNotMatch(text, /client_id|photo_file|public_id|is_sample/);
  });

  t('the seeded sample reports can be listed and read', async ({ handlers, db }) => {
    seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
    assert.equal((await call(handlers.list, {})).res.body.reports.length, 12);
    assert.equal((await call(handlers.getOne, { params: { id: 'RL-029' } })).res.body.report.type, 'river');
  });
}

/* ---- uploads handler ---------------------------------------------------------------------- */
function uploadsCall(handler, req) {
  const calls = { sendFile: null, status: null, text: null };
  const res = {
    status(c) { calls.status = c; return this; },
    type() { return this; },
    send(t) { calls.text = t; return this; },
    sendFile(name, options, cb) { calls.sendFile = { name, options }; calls.cb = cb; },
  };
  let error;
  handler({ method: 'GET', ...req }, res, (e) => { error = e; });
  return { calls, error };
}

test('uploads: a server-generated name is sent from the uploads folder with safe headers', () => {
  const handler = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  const { calls } = uploadsCall(handler, { path: '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' });
  assert.equal(calls.sendFile.name, '3281e664-afc8-4af8-bbda-a7784714bd5d.jpg');
  assert.equal(calls.sendFile.options.root, '/srv/uploads');
  assert.equal(calls.sendFile.options.dotfiles, 'deny');
  const h = calls.sendFile.options.headers;
  assert.equal(h['Content-Type'], 'image/jpeg');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.match(h['Content-Security-Policy'], /default-src 'none'/);
});

test('uploads: png and webp get their own content type', () => {
  const handler = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  const type = (ext) => uploadsCall(handler, { path: `/3281e664-afc8-4af8-bbda-a7784714bd5d.${ext}` }).calls.sendFile.options.headers['Content-Type'];
  assert.equal(type('png'), 'image/png');
  assert.equal(type('webp'), 'image/webp');
});

test('uploads: anything that is not a server-generated name is a plain 404 and never touches the disk', () => {
  const handler = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  for (const p of ['/', '', '/..', '/../package.json', '/.env', '/photo.jpg', '/3281e664-afc8-4af8-bbda-a7784714bd5d', '/3281e664-afc8-4af8-bbda-a7784714bd5d.php',
    '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg/extra', '/%2e%2e/x', '/3281e664-afc8-4af8-bbda-a7784714bd5d.JPG', '/sub/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg']) {
    const { calls } = uploadsCall(handler, { path: p });
    assert.equal(calls.status, 404, p);
    assert.equal(calls.sendFile, null, p);
  }
});

test('uploads: only GET and HEAD are served', () => {
  const handler = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const { calls } = uploadsCall(handler, { method, path: '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' });
    assert.equal(calls.status, 404, method);
    assert.equal(calls.sendFile, null, method);
  }
});

test('uploads: a missing file is a 404 and other errors go to the error handler', () => {
  const handler = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  const missing = uploadsCall(handler, { path: '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' });
  missing.calls.cb(Object.assign(new Error('nope'), { code: 'ENOENT' }));
  assert.equal(missing.calls.status, 404);

  const broken = uploadsCall(handler, { path: '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' });
  let passed;
  const handler2 = createUploadsHandler({ uploadsDir: '/srv/uploads' });
  const res = { status() { return this; }, type() { return this; }, send() { return this; }, sendFile(n, o, cb) { cb(new Error('EIO')); } };
  handler2({ method: 'GET', path: '/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' }, res, (e) => { passed = e; });
  assert.equal(passed.message, 'EIO');
  assert.ok(broken.calls.sendFile);
});
