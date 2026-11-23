'use strict';
/* Phase 3 integration tests: the admin review workflow over real HTTP.
   Each test starts the real Express app on a random local port with a temporary database and uploads folder.
   Nothing in your real server/data or server/uploads folders is touched.
   Needs the dependencies installed first:   cd server   then   npm.cmd install   */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

try {
  require('express');
} catch (err) {
  throw new Error('Express is not installed. Open a terminal in the "server" folder and run:  npm.cmd install');
}

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db');
const { seedSamples } = require('../../src/services/seedService');
const { loadFrontend, fakeStorage, plain, cookieFetch } = require('../helpers/frontend');
const images = require('../helpers/images');
const { geo, FRONTEND_DIR, CLIENT_A, CLIENT_B, TEST_ADMIN, testConfig, removeDir } = require('../helpers/env');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const JSON_HEADERS = { 'content-type': 'application/json' };

async function startApp(env = {}, { seed = true, existing } = {}) {
  const { dir, config } = existing || testConfig(env);
  let db;
  let server;
  let port;
  try {
    db = openDatabase(config.dbFile, { driver: config.dbDriver });
    if (seed) seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
    server = createApp(config, { db, geo }).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = server.address().port;
  } catch (err) {
    if (server) server.close();
    if (db) db.close();
    if (!existing) removeDir(dir);
    throw err;
  }
  const request = (method, rawPath, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const h = { ...headers };
      if (payload) h['content-length'] = payload.length;
      const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json;
          if (/application\/json/.test(res.headers['content-type'] || '')) json = JSON.parse(bytes.toString());
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString(), json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  // Every test app has a signed-in admin: app.cookie is its session. Pass { cookie: null } to send a request with no login.
  const login = async (username = TEST_ADMIN.username, password = TEST_ADMIN.password) =>
    request('POST', '/api/admin/login', { headers: JSON_HEADERS, body: { username, password } });
  const first = await login();
  const cookie = first.status === 200 ? String(first.headers['set-cookie'][0]).split(';')[0] : null;
  const patch = (id, body, headers = {}) => {
    const h = { ...JSON_HEADERS, ...(cookie ? { cookie } : {}), ...headers };
    if (h.cookie == null) delete h.cookie;
    return request('PATCH', `/api/reports/${id}`, { headers: h, body });
  };
  const post = (body, clientId = CLIENT_A) => request('POST', '/api/reports', { headers: { ...JSON_HEADERS, 'x-client-id': clientId }, body });
  const get = async (id) => (await request('GET', `/api/reports/${id}`)).json.report;
  const close = async ({ keepFiles = false } = {}) => {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (!keepFiles) removeDir(dir);
  };
  return { request, patch, post, get, close, login, cookie, config, dir, port, baseUrl: `http://127.0.0.1:${port}` };
}

const newReport = (extra = {}) => ({ type: 'drain', x: 500, y: 300, desc: 'Blocked drain near the school.', level: 'hi', ...extra });
const texts = (report) => report.log.map((e) => e.t);

test('health says that an admin account is set up and that admin changes are allowed here', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.request('GET', '/api/health');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.admin, { configured: true, auth: 'session', writes: true });
});

test('a valid status change: 200, the updated report, and it is really saved (a later GET shows it)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.patch('RL-026', { status: 'Verified' });
  assert.equal(r.status, 200);
  assert.equal(r.json.report.id, 'RL-026');
  assert.equal(r.json.report.st, 'Verified');
  assert.deepEqual(r.json.changed, { status: true, level: false, remark: false });
  assert.match(r.headers['cache-control'], /no-store/);
  assert.equal((await app.get('RL-026')).st, 'Verified');
  const list = (await app.request('GET', '/api/reports')).json.reports;
  assert.equal(list.find((x) => x.id === 'RL-026').st, 'Verified', 'the public map list shows it too');
  assert.equal(list.filter((x) => x.st === 'Pending').length, 4, 'and only that one report changed (5 were pending, now 4)');
});

test('the whole workflow works, and "Under Monitoring" with capital letters is stored in the project spelling', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const seen = [];
  for (const status of ['Verified', 'Under Monitoring', 'Resolved']) seen.push((await app.patch('RL-026', { status })).json.report.st);
  assert.deepEqual(seen, ['Verified', 'Under monitoring', 'Resolved']);
  assert.deepEqual(texts(await app.get('RL-026')), ['Report submitted', 'AI-assisted assessment generated', 'Verified by barangay admin', 'Placed under monitoring', 'Marked as resolved']);
});

test('invalid status values are rejected with 400 and nothing changes', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const status of ['Done', 'Closed', 'Under  monitoring', '', 5, ['Pending'], { x: 1 }, "Pending'; DROP TABLE reports;--"]) {
    const r = await app.patch('RL-026', { status });
    assert.equal(r.status, 400, JSON.stringify(status));
    assert.equal(r.json.error.code, 'VALIDATION');
    assert.match(r.json.error.fields.status, /Use one of: Pending, Verified, Under monitoring, Resolved/);
  }
  const after = await app.get('RL-026');
  assert.equal(after.st, 'Pending');
  assert.equal(after.log.length, 2);
  assert.equal((await app.request('GET', '/api/reports')).json.reports.length, 12, 'the table is intact');
});

test('an empty change, a bad body, the wrong content type and a too-large body get the right HTTP errors', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  let r = await app.patch('RL-026', {});
  assert.equal(r.status, 400);
  assert.match(r.json.error.fields._body, /Send a status, a level or a remark/);

  r = await app.request('PATCH', '/api/reports/RL-026', { headers: { ...JSON_HEADERS, cookie: app.cookie }, body: '{"status": "Verified", ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_JSON');
  assert.doesNotMatch(r.text, /Unexpected|position/);

  r = await app.request('PATCH', '/api/reports/RL-026', { headers: { ...JSON_HEADERS, cookie: app.cookie }, body: '[1,2]' });
  assert.equal(r.status, 400);

  r = await app.request('PATCH', '/api/reports/RL-026', { headers: { 'content-type': 'text/plain', cookie: app.cookie }, body: JSON.stringify({ status: 'Verified' }) });
  assert.equal(r.status, 415);
  r = await app.request('PATCH', '/api/reports/RL-026', { headers: { cookie: app.cookie }, body: JSON.stringify({ status: 'Verified' }) });
  assert.equal(r.status, 415);

  r = await app.request('PATCH', '/api/reports/RL-026', { headers: { ...JSON_HEADERS, cookie: app.cookie }, body: JSON.stringify({ remark: 'x'.repeat(40 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE');

  r = await app.patch('RL-026', { remark: 'x'.repeat(501) });
  assert.equal(r.status, 400);
  assert.match(r.json.error.fields.remark, /500/);
  assert.equal((await app.get('RL-026')).st, 'Pending');
});

test('a report that does not exist is 404, and malformed ids are 404 too and never reach SQL', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const id of ['RL-404', 'RL-999', "RL-026'%20OR%20'1'='1", 'rl-026', 'RL-26', '%2e%2e', 'abc', 'RL-026%00']) {
    const r = await app.patch(id, { status: 'Resolved' });
    assert.equal(r.status, 404, id);
    assert.equal(r.json.error.code, 'NOT_FOUND', id);
  }
  assert.equal((await app.request('GET', '/api/reports')).json.reports.filter((x) => x.st === 'Resolved').length, 2, 'only the 2 sample reports that were already resolved');
});

test('remarks: saved with a timestamp, shown in the history, original entries preserved, same remark not written twice', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const before = (await app.get('RL-026')).log;
  const r = await app.patch('RL-026', { remark: 'Reported to the electric cooperative.' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.changed, { status: false, level: false, remark: true });
  const log = r.json.report.log;
  assert.deepEqual(log.slice(0, 2), before, 'submission and AI entries untouched');
  assert.equal(log[2].t, 'Admin remark added');
  assert.equal(log[2].n, 'Reported to the electric cooperative.');
  assert.ok(!Number.isNaN(Date.parse(log[2].at)), 'ISO timestamp');
  assert.match(log[2].d, /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/, 'display time in the same format as the rest of the app');
  assert.equal(r.json.report.st, 'Pending');

  const again = await app.patch('RL-026', { remark: 'Reported to the electric cooperative.' });
  assert.equal(again.json.report.log.length, 3, 'the identical remark right away is not written again');
  assert.equal((await app.patch('RL-026', { remark: 'Another note.' })).json.report.log.length, 4);
});

test('a status change together with a remark and a level change is saved in one go', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const r = await app.patch('RL-026', { status: 'Verified', level: 'mod', remark: 'Rechecked on site.' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.changed, { status: true, level: true, remark: true });
  assert.deepEqual([r.json.report.st, r.json.report.lv, r.json.report.ai], ['Verified', 'mod', 'hi']);
  assert.deepEqual(texts(r.json.report).slice(2), ['Verified by barangay admin', 'Risk level set to Moderate by admin']);
  assert.equal(r.json.report.log[2].n, 'Rechecked on site.');
});

test('the same request many times at once changes the status only once and writes ONE history entry', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const results = await Promise.all(Array.from({ length: 10 }, () => app.patch('RL-026', { status: 'Verified', remark: 'Same note.' })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.json.changed.status).length, 1, 'exactly one request did the change');
  const report = await app.get('RL-026');
  assert.equal(report.st, 'Verified');
  assert.equal(report.log.length, 3);
});

test('a saved status, remark and history survive a server restart', async (t) => {
  const first = await startApp();
  await first.patch('RL-026', { status: 'Verified', remark: 'Checked on site.' });
  await first.patch('RL-026', { status: 'Under monitoring', level: 'lo' });
  const kept = { dir: first.dir, config: first.config };
  await first.close({ keepFiles: true });

  const second = await startApp({}, { seed: false, existing: kept });
  t.after(() => second.close());
  const report = await second.get('RL-026');
  assert.deepEqual([report.st, report.lv, report.ai], ['Under monitoring', 'lo', 'hi']);
  assert.deepEqual(texts(report), ['Report submitted', 'AI-assisted assessment generated', 'Verified by barangay admin', 'Placed under monitoring', 'Risk level set to Low by admin']);
  assert.equal(report.log[2].n, 'Checked on site.');
  assert.equal((await second.request('GET', '/api/reports')).json.reports.length, 12, 'no sample was duplicated or lost by the restart');
});

test('admin changes can be turned off (ADMIN_WRITES=off): 403, nothing changes, reading still works', async (t) => {
  const app = await startApp({ ADMIN_WRITES: 'off' });
  t.after(() => app.close());
  const r = await app.patch('RL-026', { status: 'Verified' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'ADMIN_WRITES_DISABLED');
  assert.equal((await app.get('RL-026')).st, 'Pending');
  assert.deepEqual((await app.request('GET', '/api/health')).json.admin, { configured: true, auth: 'session', writes: false });
  assert.equal((await app.request('GET', '/api/reports')).status, 200);
  assert.equal((await app.post(newReport())).status, 201, 'residents can still send reports');
});

test('a request that comes from another website is refused, one from this server\'s own page is accepted', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const origin of ['https://evil.example', 'http://localhost:9999', 'null']) {
    const r = await app.patch('RL-026', { status: 'Verified' }, { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.json.error.code, 'FORBIDDEN_ORIGIN');
  }
  assert.equal((await app.get('RL-026')).st, 'Pending');
  const ok = await app.patch('RL-026', { status: 'Verified' }, { origin: app.baseUrl });
  assert.equal(ok.status, 200);
});

test('the response contains no private data (client id, file names, database internals)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.post(newReport({ photo: images.dataUrl('jpeg') }));
  const r = await app.patch('RL-035', { status: 'Verified', remark: 'ok' }, { 'x-client-id': CLIENT_A });
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /client-|client_id|photo_file|public_id|is_sample|updated_at|\.db|readylink-test/);
  assert.equal(r.json.report.mine, true, 'the owner is still recognised');
});

test('My Reports: the owner sees the new status and history, other devices do not see it as theirs, and the photo is untouched', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const created = (await app.post(newReport({ photo: images.dataUrl('jpeg') }))).json.report;
  const photoBefore = sha256((await app.request('GET', created.img)).bytes);

  assert.equal((await app.patch(created.id, { status: 'Verified', remark: 'Checked on site.' })).status, 200);

  const mine = await app.request('GET', '/api/reports?mine=1', { headers: { 'x-client-id': CLIENT_A } });
  assert.deepEqual(mine.json.reports.map((r) => r.id), [created.id]);
  assert.equal(mine.json.reports[0].st, 'Verified');
  assert.equal(mine.json.reports[0].log.pop().n, 'Checked on site.');
  assert.deepEqual((await app.request('GET', '/api/reports?mine=1', { headers: { 'x-client-id': CLIENT_B } })).json.reports, []);

  const after = (await app.request('GET', `/api/reports/${created.id}`)).json.report;
  assert.equal(after.img, created.img);
  assert.equal(sha256((await app.request('GET', after.img)).bytes), photoBefore, 'the uploaded photo is byte for byte the same');
  for (const key of ['type', 'x', 'y', 'lat', 'lng', 'desc', 'ai', 'createdAt']) assert.equal(after[key], created[key], key);
});

test('regression: sending reports, ids, ordering and the samples behave exactly as before an admin review', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.patch('RL-026', { status: 'Verified' });
  const a = await app.post(newReport());
  assert.equal(a.status, 201);
  assert.equal(a.json.report.id, 'RL-035');
  assert.equal(a.json.report.st, 'Pending', 'a new report always starts as Pending');
  const list = (await app.request('GET', '/api/reports')).json.reports;
  assert.equal(list[0].id, 'RL-035');
  assert.equal(list.length, 13);
  assert.deepEqual(Object.keys(list[0]).sort(), ['ai', 'brgy', 'createdAt', 'date', 'desc', 'id', 'img', 'lat', 'lng', 'log', 'lv', 'mine', 'st', 'type', 'x', 'y'], 'the report format did not change');
  const flood = list.find((r) => r.id === 'RL-023');
  assert.deepEqual([flood.x, flood.y, flood.st], [355, 81, 'Verified']);
});

test('a client cannot change anything except status, level and remark', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const before = await app.get('RL-026');
  const r = await app.patch('RL-026', { status: 'Verified', desc: 'hacked', type: 'tree', x: 5, y: 5, id: 'RL-999', ai: 'lo', img: '/uploads/x.jpg', createdAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(r.status, 200);
  for (const key of ['id', 'type', 'x', 'y', 'desc', 'ai', 'img', 'createdAt', 'date']) assert.equal(r.json.report[key], before[key], key);
});

/* ---------- the real frontend client against the real server ---------- */

const browser = (baseUrl, extraGlobals = {}, config = {}) =>
  loadFrontend({ config: { API_MODE: 'auto', API_BASE: baseUrl, PROBE_TIMEOUT_MS: 3000, ...config }, fetch: cookieFetch(), localStorage: fakeStorage(), globals: { goto: () => {}, ...extraGlobals } });
const signedIn = async (fe) => {
  await fe.API.init();
  assert.equal((await fe.API.signIn(TEST_ADMIN.username, TEST_ADMIN.password)).ok, true);
  return fe;
};

test('frontend + server: the admin screen\'s update flow saves in the database and refreshes the list', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const toasts = [];
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fe = browser(app.baseUrl, { S, toast: (m) => toasts.push(m), render: () => {} });
  await signedIn(fe);
  assert.equal(fe.API.adminWrites, true);
  await fe.run('loadReports()');

  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified', remark: 'Checked on site.' }, 'Report verified')");
  assert.equal(result.ok, true);
  assert.deepEqual(toasts, ['Report verified']);
  assert.equal(plain(fe.run('R')).find((r) => r.id === 'RL-026').st, 'Verified');
  const saved = await app.get('RL-026');
  assert.equal(saved.st, 'Verified');
  assert.equal(saved.log.pop().n, 'Checked on site.');
});

test('frontend + server: double clicks send ONE request to the server (one history entry)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fe = browser(app.baseUrl, { S, toast: () => {}, render: () => {} });
  await signedIn(fe);
  await fe.run('loadReports()');
  const clicks = await Promise.all([1, 2, 3, 4, 5].map(() => fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'ok')")));
  assert.equal(clicks.filter((c) => c.ok).length, 1);
  assert.equal(clicks.filter((c) => c.busy).length, 4);
  assert.equal((await app.get('RL-026')).log.length, 3);
});

test('frontend + server: failures are shown in plain words and nothing is shown as saved', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const toasts = [];
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fe = browser(app.baseUrl, { S, toast: (m) => toasts.push(m), render: () => {} });
  await signedIn(fe);
  await fe.run('loadReports()');

  assert.equal((await fe.run("adminUpdate('RL-404', { status: 'Verified' }, 'saved!')")).ok, false);
  assert.equal((await fe.run("adminUpdate('RL-026', { status: 'Done' }, 'saved!')")).ok, false);
  assert.match(toasts[0], /could not find that report/);
  assert.match(toasts[1], /Please check the change\. Status: Use one of/);
  assert.ok(!toasts.includes('saved!'));
  assert.equal(plain(fe.run('R')).find((r) => r.id === 'RL-026').st, 'Pending');
  assert.equal((await app.get('RL-026')).st, 'Pending');
  assert.deepEqual(plain(S.remarkDraft), { id: 'RL-026', text: '' });
});

test('frontend + server: when admin changes are turned off the app knows and shows a clear message', async (t) => {
  const app = await startApp({ ADMIN_WRITES: 'off' });
  t.after(() => app.close());
  const toasts = [];
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fe = browser(app.baseUrl, { S, toast: (m) => toasts.push(m), render: () => {} });
  await signedIn(fe);
  assert.equal(fe.API.adminWrites, false, 'learned from /api/health');
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'saved!')");
  assert.equal(result.ok, false);
  assert.deepEqual(toasts, ['Admin changes are turned off on this server.']);
  assert.equal((await app.get('RL-026')).st, 'Pending');
});

test('frontend + server: a status change made by an admin is what the resident sees in My Reports and on the Risk Map list', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const resident = browser(app.baseUrl);
  await resident.API.init();
  const sent = plain(await resident.API.submitReport({ x: 500, y: 300, desc: 'Resident report', img: images.dataUrl('jpeg') }, { outcome: 'hazard_detected', type: 'drain', level: 'hi', hazardName: null, reason: 'The blocked drain needs review.', source: 'fallback', demo: false }));

  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const admin = browser(app.baseUrl, { S, toast: () => {}, render: () => {} });
  await signedIn(admin);
  await admin.run('loadReports()');
  assert.equal((await admin.run(`adminUpdate('${sent.id}', { status: 'Under monitoring', remark: 'Being watched.' }, 'ok')`)).ok, true);

  const mine = plain(await resident.API.listMyReports());
  assert.equal(mine[0].st, 'Under monitoring');
  const last = mine[0].log[mine[0].log.length - 1];
  assert.deepEqual([last.t, last.n], ['Status changed to Under monitoring', 'Being watched.'], 'Pending to Under monitoring skips a step, so the timeline says it plainly');
  assert.equal(plain(await resident.API.listReports()).find((r) => r.id === sent.id).st, 'Under monitoring', 'the map list shows it too');
  assert.match(mine[0].img, /\/uploads\/[0-9a-f-]{36}\.jpg$/, 'and the photo is still linked');
});

