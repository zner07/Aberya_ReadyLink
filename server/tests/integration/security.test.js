'use strict';
/* Admin security over real HTTP: who can do what, with and without a login.
   Each test starts the real Express app on a random local port with a temporary database. Nothing in your real data folder is touched.
   Needs the dependencies installed first:   cd server   then   npm.cmd install   */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

try {
  require('express');
} catch (err) {
  throw new Error('Express is not installed. Open a terminal in the "server" folder and run:  npm.cmd install');
}

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db');
const { seedSamples } = require('../../src/services/seedService');
const { createAdminAuth } = require('../../src/services/adminAuth');
const { geo, FRONTEND_DIR, CLIENT_A, TEST_ADMIN, NO_ADMIN, testConfig, removeDir } = require('../helpers/env');

const JSON_HEADERS = { 'content-type': 'application/json' };

async function startApp(env = {}, { existing, auth, seed = !existing } = {}) {
  const { dir, config } = existing || testConfig(env);
  const db = openDatabase(config.dbFile, { driver: config.dbDriver });
  if (seed) seedSamples(db, { geo, frontendDir: FRONTEND_DIR });
  const server = createApp(config, { db, geo, auth: auth || createAdminAuth(config) }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
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
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString(), json: /application\/json/.test(res.headers['content-type'] || '') ? JSON.parse(bytes.toString()) : undefined });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  const login = (username = TEST_ADMIN.username, password = TEST_ADMIN.password, headers = {}) => request('POST', '/api/admin/login', { headers: { ...JSON_HEADERS, ...headers }, body: { username, password } });
  const cookieFrom = (res) => (res.headers['set-cookie'] ? String(res.headers['set-cookie'][0]).split(';')[0] : null);
  const patch = (id, body, headers = {}) => request('PATCH', `/api/reports/${id}`, { headers: { ...JSON_HEADERS, ...headers }, body });
  const get = async (id) => (await request('GET', `/api/reports/${id}`)).json.report;
  const close = async ({ keepFiles = false } = {}) => {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (!keepFiles) removeDir(dir);
  };
  return { request, login, cookieFrom, patch, get, close, config, dir, baseUrl: `http://127.0.0.1:${port}` };
}
const signedIn = async (app) => {
  const res = await app.login();
  assert.equal(res.status, 200);
  return app.cookieFrom(res);
};

/* ---------------- visitors ---------------- */

test('ordinary visitors can still use the public site: pages, reports, photos, health, map data', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const p of ['/', '/index.html', '/js/api.js', '/css/styles.css', '/data/alangilan.geojson', '/api/health', '/api/reports', '/api/reports/RL-023', '/api/admin/session']) {
    assert.equal((await app.request('GET', p)).status, 200, p);
  }
  assert.equal((await app.request('POST', '/api/reports', { headers: { ...JSON_HEADERS, 'x-client-id': CLIENT_A }, body: { type: 'tree', x: 500, y: 300, desc: 'A visitor report', level: 'mod' } })).status, 201, 'sending a report needs no login');
});

test('visitors cannot change anything: every attempt is 401 and the data does not move', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const before = JSON.stringify(await app.get('RL-026'));
  const attempts = [
    {},
    { cookie: 'readylink_admin=' + 'a'.repeat(43) },
    { cookie: 'readylink_admin=junk' },
    { cookie: 'session=abc; admin=true; role=admin' },
    { authorization: 'Bearer abc.def.ghi' },
    { authorization: 'Basic ' + Buffer.from(`${TEST_ADMIN.username}:${TEST_ADMIN.password}`).toString('base64') },
    { 'x-admin': 'true', 'x-role': 'admin', 'x-forwarded-for': '127.0.0.1' },
    { 'x-client-id': CLIENT_A },
  ];
  for (const headers of attempts) {
    const r = await app.patch('RL-026', { status: 'Resolved', level: 'lo', remark: 'hacked' }, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.equal(r.json.error.code, 'UNAUTHENTICATED');
  }
  assert.equal(JSON.stringify(await app.get('RL-026')), before, 'status, level, remark and history are exactly as before');
});

test('a visitor learns nothing from the answer: the same 401 for a bad body, a missing report or a wrong type', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const answers = [
    await app.patch('RL-026', { status: 'Done' }),
    await app.patch('RL-999', { status: 'Verified' }),
    await app.patch('not-an-id', {}),
    await app.request('PATCH', '/api/reports/RL-026', { headers: { 'content-type': 'text/plain' }, body: 'x' }),
    await app.request('PATCH', '/api/reports/RL-026', { headers: JSON_HEADERS, body: '{broken' }),
    await app.request('PATCH', '/api/reports/RL-026', { headers: JSON_HEADERS, body: JSON.stringify({ remark: 'x'.repeat(100000) }) }),
  ];
  for (const r of answers) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, answers[0].json);
  }
});

/* ---------------- logging in ---------------- */

test('wrong credentials are rejected with one message, and no cookie is given', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const wrongUser = await app.login('nobody', TEST_ADMIN.password);
  const wrongPassword = await app.login(TEST_ADMIN.username, 'Wrong password 123!');
  const empty = await app.request('POST', '/api/admin/login', { headers: JSON_HEADERS, body: { username: '', password: '' } });
  for (const r of [wrongUser, wrongPassword]) {
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'INVALID_CREDENTIALS');
    assert.equal(r.headers['set-cookie'], undefined);
  }
  assert.equal(wrongUser.json.error.message, wrongPassword.json.error.message, 'no hint whether the username or the password was wrong');
  assert.equal(empty.status, 400);
});

test('NoSQL-style or odd login bodies are rejected, not accepted', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const body of [{ username: { $ne: '' }, password: { $ne: '' } }, { username: [TEST_ADMIN.username], password: [TEST_ADMIN.password] }, { username: TEST_ADMIN.username }, [], 'x', null]) {
    const r = await app.request('POST', '/api/admin/login', { headers: JSON_HEADERS, body });
    assert.ok([400, 401].includes(r.status), JSON.stringify(body));
    assert.equal(r.headers['set-cookie'], undefined);
  }
});

test('valid credentials: 200, a session cookie with the right flags, and no secret in the answer', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const res = await app.login();
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, admin: { name: TEST_ADMIN.username }, writes: true });
  const setCookie = String(res.headers['set-cookie'][0]);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(setCookie.includes(flag), flag);
  assert.ok(!setCookie.includes('Secure'), 'Secure is for HTTPS (production) only');
  const token = setCookie.split(';')[0].split('=')[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  for (const secret of [TEST_ADMIN.password, TEST_ADMIN.hash, TEST_ADMIN.secret]) {
    assert.ok(!res.text.includes(secret) && !setCookie.includes(secret));
  }
  assert.match(res.headers['cache-control'], /no-store/);
});

test('with the cookie the admin can change reports, and the session endpoint says so', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const cookie = await signedIn(app);
  assert.deepEqual((await app.request('GET', '/api/admin/session', { headers: { cookie } })).json, { configured: true, authenticated: true, name: TEST_ADMIN.username, writes: true });
  const r = await app.patch('RL-026', { status: 'Verified', remark: 'Checked on site.' }, { cookie });
  assert.equal(r.status, 200);
  assert.equal((await app.get('RL-026')).st, 'Verified');
  assert.equal((await app.request('GET', '/api/admin/session')).json.authenticated, false, 'and a visitor without the cookie is still not signed in');
});

test('each login makes a different token, and two admins can be signed in at once', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const a = await signedIn(app);
  const b = await signedIn(app);
  assert.notEqual(a, b);
  assert.equal((await app.patch('RL-026', { remark: 'from A' }, { cookie: a })).status, 200);
  assert.equal((await app.patch('RL-026', { remark: 'from B' }, { cookie: b })).status, 200);
});

/* ---------------- logging out ---------------- */

test('logout really ends the session: the old cookie is useless afterwards, even if it is sent again', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const cookie = await signedIn(app);
  assert.equal((await app.patch('RL-026', { remark: 'before logout' }, { cookie })).status, 200);
  const out = await app.request('POST', '/api/admin/logout', { headers: { ...JSON_HEADERS, cookie }, body: {} });
  assert.equal(out.status, 200);
  assert.match(String(out.headers['set-cookie'][0]), /^readylink_admin=;.*Max-Age=0/);
  const replay = await app.patch('RL-026', { status: 'Resolved' }, { cookie });
  assert.equal(replay.status, 401, 'a copied or stolen cookie stops working at logout');
  assert.equal((await app.request('GET', '/api/admin/session', { headers: { cookie } })).json.authenticated, false);
  assert.equal((await app.get('RL-026')).st, 'Pending');
});

test('logging out one admin does not sign out another', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const a = await signedIn(app);
  const b = await signedIn(app);
  await app.request('POST', '/api/admin/logout', { headers: { ...JSON_HEADERS, cookie: a }, body: {} });
  assert.equal((await app.patch('RL-026', { remark: 'still in' }, { cookie: b })).status, 200);
});

/* ---------------- guessing ---------------- */

test('guessing: after 5 wrong tries even the right password is refused for a while (429 with Retry-After)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (let i = 0; i < 5; i += 1) assert.equal((await app.login(TEST_ADMIN.username, `wrong guess number ${i}`)).status, 401);
  const locked = await app.login();
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(locked.headers['retry-after']) > 0);
  assert.equal(locked.headers['set-cookie'], undefined);
});

/* ---------------- no admin set up (the safe default) ---------------- */

test('with no admin set up nothing is open: login 503, changes 503, and the public site still works', async (t) => {
  const app = await startApp(NO_ADMIN);
  t.after(() => app.close());
  const l = await app.login();
  assert.equal(l.status, 503);
  assert.equal(l.json.error.code, 'ADMIN_NOT_CONFIGURED');
  assert.match(l.json.error.message, /admin:setup/);
  const p = await app.patch('RL-026', { status: 'Verified' });
  assert.equal(p.status, 503);
  assert.equal(p.json.error.code, 'ADMIN_NOT_CONFIGURED');
  assert.deepEqual((await app.request('GET', '/api/admin/session')).json, { configured: false, authenticated: false, name: null, writes: true });
  assert.deepEqual((await app.request('GET', '/api/health')).json.admin, { configured: false, auth: 'none', writes: true });
  assert.equal((await app.request('GET', '/api/reports')).status, 200);
  assert.equal((await app.get('RL-026')).st, 'Pending');
});

/* ---------------- other websites ---------------- */

test('other websites cannot sign in, sign out or change anything on the admin\'s behalf', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const evil = { origin: 'https://evil.example' };
  assert.equal((await app.login(TEST_ADMIN.username, TEST_ADMIN.password, evil)).status, 403);
  const cookie = await signedIn(app);
  assert.equal((await app.request('POST', '/api/admin/logout', { headers: { ...JSON_HEADERS, ...evil, cookie }, body: {} })).status, 403);
  assert.equal((await app.patch('RL-026', { status: 'Resolved' }, { ...evil, cookie })).status, 403);
  assert.equal((await app.patch('RL-026', { status: 'Verified' }, { origin: app.baseUrl, cookie })).status, 200, 'the READYLINK page itself is fine');
  assert.equal((await app.request('GET', '/api/admin/session', { headers: { cookie } })).json.authenticated, true, 'the failed logout did not end the session');
});

test('the login only accepts JSON (a plain HTML form from another site cannot submit it)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const form = await app.request('POST', '/api/admin/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `username=${TEST_ADMIN.username}&password=${encodeURIComponent(TEST_ADMIN.password)}` });
  assert.equal(form.status, 415);
  assert.equal((await app.request('POST', '/api/admin/login', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ username: TEST_ADMIN.username, password: TEST_ADMIN.password }) })).status, 415);
  assert.equal((await app.request('GET', `/api/admin/login?username=${TEST_ADMIN.username}&password=x`)).status, 404, 'no login through the address bar');
});

/* ---------------- sessions end ---------------- */

test('a session ends after the session time', async (t) => {
  let now = Date.now();
  const { dir, config } = testConfig({ ADMIN_SESSION_HOURS: '2' });
  const app = await startApp({}, { existing: { dir, config }, seed: true, auth: createAdminAuth(config, { now: () => now }) });
  t.after(() => app.close());
  const cookie = await signedIn(app);
  now += 2 * 3600 * 1000 - 5000;
  assert.equal((await app.patch('RL-026', { remark: 'still inside the time' }, { cookie })).status, 200);
  now += 10000;
  assert.equal((await app.patch('RL-026', { remark: 'too late' }, { cookie })).status, 401);
});

test('restarting the server signs everyone out (sessions are only in memory)', async (t) => {
  const first = await startApp();
  const cookie = await signedIn(first);
  const kept = { dir: first.dir, config: first.config };
  await first.close({ keepFiles: true });
  const second = await startApp({}, { existing: kept });
  t.after(() => second.close());
  assert.equal((await second.patch('RL-026', { status: 'Verified' }, { cookie })).status, 401);
  assert.equal((await second.get('RL-026')).st, 'Pending');
});

/* ---------------- the second lock and HTTPS ---------------- */

test('in production the cookie is Secure and admin changes need the explicit switch', async (t) => {
  const prod = await startApp({ NODE_ENV: 'production' });
  t.after(() => prod.close());
  const res = await prod.login();
  assert.equal(res.status, 200);
  assert.ok(String(res.headers['set-cookie'][0]).includes('; Secure'));
  const blocked = await prod.patch('RL-026', { status: 'Verified' }, { cookie: prod.cookieFrom(res) });
  assert.equal(blocked.status, 403, 'logged in, but ADMIN_WRITES is off by default in production');
  assert.equal(blocked.json.error.code, 'ADMIN_WRITES_DISABLED');
  const on = await startApp({ NODE_ENV: 'production', ADMIN_WRITES: 'on' });
  t.after(() => on.close());
  assert.equal((await on.patch('RL-026', { status: 'Verified' }, { cookie: await signedIn(on) })).status, 200);
});

/* ---------------- secrets stay on the server ---------------- */

test('no file the server hands out contains the password, the hash or the session secret', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signedIn(app);
  const served = ['/', '/index.html'];
  for (const dir of ['css', 'js', 'data']) for (const f of fs.readdirSync(path.join(FRONTEND_DIR, dir))) served.push(`/${dir}/${f}`);
  for (const p of served) {
    const r = await app.request('GET', p);
    assert.equal(r.status, 200, p);
    for (const secret of [TEST_ADMIN.password, TEST_ADMIN.hash, TEST_ADMIN.secret, 'scrypt$', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) assert.ok(!r.text.includes(secret), `${p} contains ${secret.slice(0, 12)}`);
  }
  for (const p of ['/.env', '/server/.env', '/server/.env.example', '/server/src/config.js', '/server/src/services/adminAuth.js', '/.git/config', '/server/data/readylink.db']) {
    assert.equal((await app.request('GET', p)).status, 404, p);
  }
  const health = JSON.stringify((await app.request('GET', '/api/health')).json);
  for (const secret of [TEST_ADMIN.hash, TEST_ADMIN.secret, TEST_ADMIN.username]) assert.ok(!health.includes(secret), 'health does not leak admin details');
});

test('error answers never contain stack traces, file paths or secrets', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const answers = [
    await app.request('POST', '/api/admin/login', { headers: JSON_HEADERS, body: '{broken' }),
    await app.login('x'.repeat(300), 'y'),
    await app.request('POST', '/api/admin/login', { headers: JSON_HEADERS, body: 'x'.repeat(20000) }),
    await app.patch('RL-026', { status: 'Verified' }),
  ];
  for (const r of answers) {
    assert.doesNotMatch(r.text, /\bat [A-Za-z.<]+ \(|node_modules|\/src\/|\\src\\|Error:/);
    for (const secret of [TEST_ADMIN.hash, TEST_ADMIN.secret]) assert.ok(!r.text.includes(secret));
  }
});
