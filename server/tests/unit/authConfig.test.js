'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');
const { TEST_ADMIN } = require('../helpers/env');

const full = { ADMIN_USERNAME: TEST_ADMIN.username, ADMIN_PASSWORD_HASH: TEST_ADMIN.hash, ADMIN_SESSION_SECRET: TEST_ADMIN.secret };

test('nothing set means admin is NOT set up (closed by default)', () => {
  const c = loadConfig({});
  assert.equal(c.adminAuth.configured, false);
  assert.equal(c.adminAuth.username, '');
});

test('all three set means admin is set up, with an 8 hour session by default', () => {
  const c = loadConfig(full);
  assert.equal(c.adminAuth.configured, true);
  assert.equal(c.adminAuth.sessionMs, 8 * 3600 * 1000);
});

test('ADMIN_SESSION_HOURS is checked', () => {
  assert.equal(loadConfig({ ...full, ADMIN_SESSION_HOURS: '1.5' }).adminAuth.sessionMs, 5400000);
  for (const bad of ['0', '0.1', '73', 'abc', '-1', '1e3']) assert.throws(() => loadConfig({ ...full, ADMIN_SESSION_HOURS: bad }), /ADMIN_SESSION_HOURS/, bad);
});

test('a half-finished setup stops the server with a message that says what to do (it never starts half open)', () => {
  assert.throws(() => loadConfig({ ADMIN_USERNAME: 'admin' }), /ADMIN_PASSWORD_HASH/);
  assert.throws(() => loadConfig({ ADMIN_PASSWORD_HASH: TEST_ADMIN.hash }), /ADMIN_USERNAME/);
  assert.throws(() => loadConfig({ ...full, ADMIN_SESSION_SECRET: 'too short' }), /ADMIN_SESSION_SECRET must be at least 32/);
  assert.throws(() => loadConfig({ ...full, ADMIN_USERNAME: 'x'.repeat(101) }), /ADMIN_USERNAME/);
});

test('a PLAIN PASSWORD in ADMIN_PASSWORD_HASH is refused (only a real hash is accepted)', () => {
  for (const plain of ['hunter2hunter2', 'admin', 'scrypt$1$2$3$a$b', 'x'.repeat(100)]) {
    assert.throws(() => loadConfig({ ...full, ADMIN_PASSWORD_HASH: plain }), /not a valid hash/, plain);
  }
});

test('the error messages never print the secret values', () => {
  try { loadConfig({ ...full, ADMIN_PASSWORD_HASH: 'my-plain-password-123' }); } catch (e) { assert.ok(!e.message.includes('my-plain-password-123')); }
  try { loadConfig({ ...full, ADMIN_SESSION_SECRET: 'short-secret-value' }); } catch (e) { assert.ok(!e.message.includes('short-secret-value')); }
});

test('geocoder settings: off by default in tests, photon otherwise, and validated', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).geocoder.provider, 'off');
  assert.equal(loadConfig({}).geocoder.provider, 'photon');
  assert.equal(loadConfig({ GEOCODER: 'nominatim', GEOCODER_URL: 'https://example.org/', GEOCODER_CONTACT: 'a@b.c' }).geocoder.url, 'https://example.org');
  assert.equal(loadConfig({ GEOCODER_TIMEOUT_MS: '8000' }).geocoder.timeoutMs, 8000);
  for (const bad of [{ GEOCODER: 'google' }, { GEOCODER_URL: 'ftp://x' }, { GEOCODER_URL: 'not a url' }, { GEOCODER_TIMEOUT_MS: '10' }, { GEOCODER_TIMEOUT_MS: '99999' }]) assert.throws(() => loadConfig(bad), /GEOCODER/, JSON.stringify(bad));
});
