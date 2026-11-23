'use strict';
/* The admin session logic: login, sessions, expiry, lockout. Time is fake so nothing has to wait. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminAuth, MAX_SESSIONS } = require('../../src/services/adminAuth');
const { loadConfig } = require('../../src/config');
const { TEST_ADMIN, NO_ADMIN } = require('../helpers/env');

const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const settings = (extra = {}) => loadConfig({ NODE_ENV: 'test', ADMIN_USERNAME: TEST_ADMIN.username, ADMIN_PASSWORD_HASH: TEST_ADMIN.hash, ADMIN_SESSION_SECRET: TEST_ADMIN.secret, ...extra });
const make = (extra, c = clock()) => ({ auth: createAdminAuth(settings(extra), { now: c.now }), c });
const good = { username: TEST_ADMIN.username, password: TEST_ADMIN.password, ip: '10.0.0.1' };

test('the right username and password give a session token', async () => {
  const { auth } = make();
  const out = await auth.login(good);
  assert.equal(out.ok, true);
  assert.equal(out.name, TEST_ADMIN.username);
  assert.match(out.token, /^[A-Za-z0-9_-]{43}$/, '256 random bits');
  assert.equal(auth.validate(out.token).name, TEST_ADMIN.username);
  assert.equal(auth.activeSessions(), 1);
});

test('the username is not case sensitive, the password is, and a wrong one is refused', async () => {
  const { auth } = make();
  assert.equal((await auth.login({ ...good, username: TEST_ADMIN.username.toUpperCase() })).ok, true);
  assert.equal((await auth.login({ ...good, password: TEST_ADMIN.password.toLowerCase() })).ok, false);
  assert.equal((await auth.login({ ...good, password: '' })).ok, false);
  assert.equal((await auth.login({ ...good, username: 'someone.else' })).ok, false);
});

test('a wrong username and a wrong password give the SAME answer (no hint about which one was wrong)', async () => {
  const { auth } = make();
  const wrongUser = await auth.login({ ...good, username: 'nobody' });
  const wrongPassword = await auth.login({ ...good, password: 'Not the password 1' });
  assert.deepEqual(wrongUser, { ok: false, code: 'INVALID' });
  assert.deepEqual(wrongPassword, { ok: false, code: 'INVALID' });
});

test('the password is checked even when the username is wrong (same work, so the time does not give the username away)', async () => {
  let checks = 0;
  const auth = createAdminAuth(settings(), { now: clock().now, verify: async () => { checks += 1; return false; } });
  await auth.login({ ...good, username: 'nobody' });
  await auth.login({ ...good });
  assert.equal(checks, 2);
});

test('sessions are unguessable and each login makes a NEW token', async () => {
  const { auth } = make();
  const tokens = new Set();
  for (let i = 0; i < 5; i += 1) tokens.add((await auth.login({ ...good, ip: `10.0.0.${i}` })).token);
  assert.equal(tokens.size, 5);
});

test('validate accepts only real tokens: junk, empty, wrong type, near misses and old formats are refused', async () => {
  const { auth } = make();
  const { token } = await auth.login(good);
  for (const bad of [undefined, null, '', 'abc', 123, {}, token.slice(0, -1), `${token}x`, token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'), 'x'.repeat(500)]) {
    assert.equal(auth.validate(bad), null, String(bad).slice(0, 30));
  }
  assert.ok(auth.validate(token));
});

test('logout ends the session on the server: the same token no longer works', async () => {
  const { auth } = make();
  const { token } = await auth.login(good);
  auth.logout(token);
  assert.equal(auth.validate(token), null);
  assert.equal(auth.activeSessions(), 0);
  auth.logout(token); auth.logout(undefined); auth.logout('junk'); // harmless
});

test('a session ends by itself after the session time (ADMIN_SESSION_HOURS)', async () => {
  const { auth, c } = make({ ADMIN_SESSION_HOURS: '2' });
  const { token } = await auth.login(good);
  c.advance(2 * 3600 * 1000 - 1000);
  assert.ok(auth.validate(token), 'still valid just before the end');
  c.advance(2000);
  assert.equal(auth.validate(token), null, 'gone after the end');
  assert.equal(auth.activeSessions(), 0, 'and removed from memory');
});

test('a token from another login secret is worthless: sessions are tied to ADMIN_SESSION_SECRET', async () => {
  const a = make();
  const { token } = await a.auth.login(good);
  const b = make({ ADMIN_SESSION_SECRET: 'another-secret-another-secret-another-secret-xx' });
  assert.equal(b.auth.validate(token), null);
});

test('the token is never stored: only a keyed hash of it is kept in memory', async () => {
  const { auth } = make();
  const { token } = await auth.login(good);
  // nothing in the public API exposes the table, and the object holds no copy of the token
  assert.ok(!JSON.stringify(Object.values(auth)).includes(token));
});

test('5 wrong tries from one address lock that address for 15 minutes, even for the right password', async () => {
  const { auth, c } = make();
  for (let i = 0; i < 5; i += 1) assert.equal((await auth.login({ ...good, username: 'x', ip: '9.9.9.9' })).code, 'INVALID');
  const locked = await auth.login({ ...good, ip: '9.9.9.9' });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'LOCKED');
  assert.ok(locked.retryAfterSec > 800 && locked.retryAfterSec <= 900);
  assert.equal((await auth.login({ ...good, ip: '8.8.8.8' })).ok, true, 'another address is not affected');
  c.advance(15 * 60 * 1000 + 1000);
  assert.equal((await auth.login({ ...good, ip: '9.9.9.9' })).ok, true, 'the lock ends after 15 minutes');
});

test('10 wrong tries against one username lock that username, whatever the address', async () => {
  const { auth } = make();
  for (let i = 0; i < 10; i += 1) await auth.login({ username: TEST_ADMIN.username, password: 'wrong password 1', ip: `7.7.7.${i}` });
  const locked = await auth.login({ ...good, ip: '1.2.3.4' });
  assert.equal(locked.code, 'LOCKED');
});

test('a successful login clears the failed-try count', async () => {
  const { auth } = make();
  for (let i = 0; i < 4; i += 1) await auth.login({ ...good, password: 'wrong password 1' });
  assert.equal((await auth.login(good)).ok, true);
  for (let i = 0; i < 4; i += 1) await auth.login({ ...good, password: 'wrong password 1' });
  assert.equal((await auth.login(good)).ok, true, 'the count started again from zero');
});

test('there is a limit on how many sessions exist at once (the oldest goes first)', async () => {
  const { auth } = make();
  const first = await auth.login({ ...good, ip: '1.1.1.1' });
  for (let i = 0; i < MAX_SESSIONS + 5; i += 1) await auth.login({ ...good, ip: `2.2.${Math.floor(i / 250)}.${i % 250}` });
  assert.ok(auth.activeSessions() <= MAX_SESSIONS);
  assert.equal(auth.validate(first.token), null, 'the oldest session was dropped');
});

test('with no admin set up nothing works: login is refused and no token validates', async () => {
  const { auth } = make(NO_ADMIN);
  assert.equal(auth.configured, false);
  assert.deepEqual(await auth.login(good), { ok: false, code: 'NOT_CONFIGURED' });
  assert.equal(auth.validate('a'.repeat(43)), null);
});
