'use strict';
/* The login, logout and session handlers, called directly with fake request/response objects. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminHandlers } = require('../../src/routes/admin');
const { createAdminAuth } = require('../../src/services/adminAuth');
const { errorBody } = require('../../src/middleware/errors');
const { loadConfig } = require('../../src/config');
const { TEST_ADMIN, NO_ADMIN } = require('../helpers/env');

const settings = (extra = {}) => loadConfig({ NODE_ENV: 'test', ADMIN_USERNAME: TEST_ADMIN.username, ADMIN_PASSWORD_HASH: TEST_ADMIN.hash, ADMIN_SESSION_SECRET: TEST_ADMIN.secret, ...extra });
const fakeRes = () => ({ statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k.toLowerCase()] = v; return this; }, json(b) { this.body = b; return this; } });
const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', host: 'localhost:3000', ...extra });

function setup(extra = {}) {
  const config = settings(extra);
  const auth = createAdminAuth(config);
  return { config, auth, h: createAdminHandlers({ config, auth }) };
}
async function call(fn, req) {
  const res = fakeRes();
  let error;
  await fn({ headers: {}, socket: { remoteAddress: '10.1.1.1' }, ...req }, res, (e) => { error = e; });
  return { res, error };
}
const login = (h, body, headers = jsonHeaders(), ip = '10.1.1.1') => call(h.login, { headers, body, socket: { remoteAddress: ip } });
const good = { username: TEST_ADMIN.username, password: TEST_ADMIN.password };
const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];

test('login success: 200, the admin name, and a session cookie that JavaScript cannot read', async () => {
  const { h } = setup();
  const { res, error } = await login(h, good);
  assert.equal(error, undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, admin: { name: TEST_ADMIN.username }, writes: true });
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, /^readylink_admin=[A-Za-z0-9_-]{43};/);
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
});

test('the answer never contains the password, the hash, the secret or the token', async () => {
  const { h } = setup();
  const { res } = await login(h, good);
  const text = JSON.stringify(res.body);
  for (const secret of [TEST_ADMIN.password, TEST_ADMIN.hash, TEST_ADMIN.secret, cookieOf(res).split('=')[1]]) assert.ok(!text.includes(secret));
});

test('wrong username and wrong password: the same 401 and the same words', async () => {
  const { h } = setup();
  const a = await login(h, { username: 'nobody', password: TEST_ADMIN.password });
  const b = await login(h, { username: TEST_ADMIN.username, password: 'Wrong password 123!' });
  for (const { error, res } of [a, b]) {
    assert.equal(errorBody(error).status, 401);
    assert.equal(errorBody(error).body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(res.headers['set-cookie'], undefined, 'no cookie on a failed login');
  }
  assert.equal(errorBody(a.error).body.error.message, errorBody(b.error).body.error.message);
  assert.equal(errorBody(a.error).body.error.message, 'Incorrect username or password.');
});

test('missing or wrong-type fields: 400 VALIDATION, not a crash and not a login', async () => {
  const { h } = setup();
  for (const body of [undefined, null, 'x', [], {}, { username: 'a' }, { password: 'a' }, { username: 5, password: 5 }, { username: ' ', password: 'x' }, { username: 'a'.repeat(101), password: 'x' }, { username: 'a', password: 'x'.repeat(1001) }, { username: { $ne: '' }, password: { $ne: '' } }]) {
    const { error, res } = await login(h, body);
    assert.equal(errorBody(error).status, 400, JSON.stringify(body)?.slice(0, 50));
    assert.equal(errorBody(error).body.error.code, 'VALIDATION');
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('a login that comes from another website is refused (403) and a non-JSON one too (415)', async () => {
  const { h } = setup();
  assert.equal(errorBody((await login(h, good, jsonHeaders({ origin: 'https://evil.example' }))).error).status, 403);
  assert.equal(errorBody((await login(h, good, jsonHeaders({ origin: 'null' }))).error).status, 403);
  assert.equal(errorBody((await login(h, good, { host: 'localhost:3000', 'content-type': 'text/plain' })).error).status, 415);
  assert.equal(errorBody((await login(h, good, { host: 'localhost:3000' })).error).status, 415);
  assert.equal((await login(h, good, jsonHeaders({ origin: 'http://localhost:3000' }))).res.statusCode, 200, 'the own page is fine');
});

test('5 wrong tries lock the address: 429 with Retry-After, even for the right password', async () => {
  const { h } = setup();
  for (let i = 0; i < 5; i += 1) await login(h, { username: 'x', password: 'wrong password 1' }, jsonHeaders(), '6.6.6.6');
  const { error, res } = await login(h, good, jsonHeaders(), '6.6.6.6');
  assert.equal(errorBody(error).status, 429);
  assert.equal(errorBody(error).body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(res.headers['retry-after']) > 0);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('with no admin set up: 503 ADMIN_NOT_CONFIGURED with instructions', async () => {
  const { h } = setup(NO_ADMIN);
  const { error } = await login(h, good);
  assert.equal(errorBody(error).status, 503);
  assert.equal(errorBody(error).body.error.code, 'ADMIN_NOT_CONFIGURED');
  assert.match(errorBody(error).body.error.message, /npm\.cmd run admin:setup/);
});

test('session: says whether admin is set up and whether this browser is signed in, and never fails', async () => {
  const { h, auth } = setup();
  assert.deepEqual((await call(h.session, { headers: {} })).res.body, { configured: true, authenticated: false, name: null, writes: true });
  const out = await login(h, good);
  const withCookie = await call(h.session, { headers: { cookie: cookieOf(out.res) } });
  assert.deepEqual(withCookie.res.body, { configured: true, authenticated: true, name: TEST_ADMIN.username, writes: true });
  assert.equal((await call(h.session, { headers: { cookie: 'readylink_admin=junk' } })).res.body.authenticated, false);
  assert.equal(auth.activeSessions(), 1);
  const off = setup(NO_ADMIN);
  assert.deepEqual((await call(off.h.session, { headers: {} })).res.body, { configured: false, authenticated: false, name: null, writes: true });
});

test('logout: ends the session on the server, clears the cookie, and a second logout is harmless', async () => {
  const { h } = setup();
  const cookie = cookieOf((await login(h, good)).res);
  const out = await call(h.logout, { headers: jsonHeaders({ cookie }) });
  assert.deepEqual(out.res.body, { ok: true });
  assert.match(String(out.res.headers['set-cookie']), /^readylink_admin=;.*Max-Age=0/);
  assert.equal((await call(h.session, { headers: { cookie } })).res.body.authenticated, false, 'the old cookie no longer works');
  assert.equal((await call(h.logout, { headers: jsonHeaders({ cookie }) })).res.body.ok, true);
  assert.equal((await call(h.logout, { headers: jsonHeaders() })).res.body.ok, true, 'logout without any cookie');
});

test('logout from another website is refused, so a stranger cannot sign the admin out', async () => {
  const { h } = setup();
  assert.equal(errorBody((await call(h.logout, { headers: jsonHeaders({ origin: 'https://evil.example' }) })).error).status, 403);
});

test('in production the cookie also gets the Secure flag', async () => {
  const { h } = setup({ NODE_ENV: 'production' });
  const { res } = await login(h, good);
  assert.ok(String(res.headers['set-cookie']).includes('; Secure'));
});
