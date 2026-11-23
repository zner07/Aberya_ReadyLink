'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCookies, readToken, sessionCookie, clearedCookie, requireAdmin, COOKIE_NAME } = require('../../src/middleware/adminAuth');
const { isSameOrigin, assertSameOrigin, assertJson } = require('../../src/middleware/origin');
const { errorBody } = require('../../src/middleware/errors');
const { createAdminAuth } = require('../../src/services/adminAuth');
const { loadConfig } = require('../../src/config');
const { TEST_ADMIN, NO_ADMIN } = require('../helpers/env');

const settings = (extra = {}) => loadConfig({ NODE_ENV: 'test', ADMIN_USERNAME: TEST_ADMIN.username, ADMIN_PASSWORD_HASH: TEST_ADMIN.hash, ADMIN_SESSION_SECRET: TEST_ADMIN.secret, ...extra });

test('parseCookies reads cookies and survives junk', () => {
  assert.deepEqual(parseCookies('a=1; b=two; c="three"'), { a: '1', b: 'two', c: 'three' });
  assert.deepEqual(parseCookies('a=1; a=2'), { a: '1' }, 'the first one wins');
  assert.deepEqual(parseCookies('novalue; =x; ;;'), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('x'.repeat(10000)), {}, 'an oversized header is ignored');
  assert.equal(readToken({ headers: { cookie: `${COOKIE_NAME}=abc; other=1` } }), 'abc');
  assert.equal(readToken({ headers: {} }), null);
});

test('the session cookie is HttpOnly, SameSite=Strict, limited in time and for the whole site', () => {
  const c = sessionCookie('TOKEN', { maxAgeSec: 28800, secure: false });
  assert.match(c, /^readylink_admin=TOKEN;/);
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(c.includes(part), part);
  assert.ok(!c.includes('Secure'), 'Secure is only for HTTPS');
  assert.ok(sessionCookie('T', { maxAgeSec: 60, secure: true }).includes('; Secure'));
});

test('the cleared cookie expires at once', () => {
  const c = clearedCookie({ secure: false });
  assert.match(c, /^readylink_admin=;/);
  assert.ok(c.includes('Max-Age=0') && c.includes('HttpOnly') && c.includes('SameSite=Strict'));
});

async function guarded(extra, headers) {
  const auth = createAdminAuth(settings(extra));
  const login = auth.configured ? await auth.login({ username: TEST_ADMIN.username, password: TEST_ADMIN.password, ip: 'x' }) : null;
  const req = { headers: typeof headers === 'function' ? headers(login) : headers };
  let result;
  requireAdmin(auth)(req, {}, (err) => { result = err || 'passed'; });
  return { result, req };
}

test('requireAdmin lets a valid session through and puts the admin on the request', async () => {
  const { result, req } = await guarded({}, (login) => ({ cookie: `${COOKIE_NAME}=${login.token}` }));
  assert.equal(result, 'passed');
  assert.equal(req.admin.name, TEST_ADMIN.username);
});

test('requireAdmin refuses everything else with 401: no cookie, junk cookie, wrong token', async () => {
  for (const headers of [{}, { cookie: '' }, { cookie: `${COOKIE_NAME}=junk` }, { cookie: `${COOKIE_NAME}=${'a'.repeat(43)}` }, { cookie: 'other=1' }]) {
    const { result, req } = await guarded({}, headers);
    assert.equal(errorBody(result).status, 401, JSON.stringify(headers));
    assert.equal(errorBody(result).body.error.code, 'UNAUTHENTICATED');
    assert.equal(req.admin, undefined);
  }
});

test('requireAdmin with no admin set up: 503 with instructions, whatever the request', async () => {
  const { result } = await guarded(NO_ADMIN, { cookie: `${COOKIE_NAME}=${'a'.repeat(43)}` });
  assert.equal(errorBody(result).status, 503);
  assert.equal(errorBody(result).body.error.code, 'ADMIN_NOT_CONFIGURED');
  assert.match(errorBody(result).body.error.message, /admin:setup/);
});

test('a header called x-admin or authorization does not make anyone an admin', async () => {
  const { result } = await guarded({}, { 'x-admin': 'true', authorization: 'Bearer anything', 'x-client-id': 'a'.repeat(20) });
  assert.equal(errorBody(result).status, 401);
});

test('isSameOrigin and assertSameOrigin', () => {
  assert.equal(isSameOrigin('http://localhost:3000', 'localhost:3000'), true);
  for (const o of ['http://localhost:3001', 'https://evil.example', 'null', 'not a url', '']) assert.equal(isSameOrigin(o, 'localhost:3000'), false, o);
  assert.equal(isSameOrigin('http://localhost:3000', undefined), false);
  assert.doesNotThrow(() => assertSameOrigin({ headers: { host: 'localhost:3000' } }), 'no Origin header (curl, tests) is fine');
  assert.doesNotThrow(() => assertSameOrigin({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' } }));
  assert.throws(() => assertSameOrigin({ headers: { origin: 'https://evil.example', host: 'localhost:3000' } }), (e) => e.status === 403 && e.code === 'FORBIDDEN_ORIGIN');
});

test('assertJson', () => {
  assert.doesNotThrow(() => assertJson({ headers: { 'content-type': 'application/json; charset=utf-8' } }));
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    assert.throws(() => assertJson({ headers: { 'content-type': type } }), (e) => e.status === 415);
  }
});
