'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');

test('admin changes: allowed by default only on a local-only, non-production server', () => {
  assert.equal(loadConfig({}).adminWrites, true);
  assert.equal(loadConfig({ HOST: '127.0.0.1' }).adminWrites, true);
  assert.equal(loadConfig({ HOST: 'localhost', NODE_ENV: 'development' }).adminWrites, true);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).adminWrites, true);
});

test('admin changes are OFF by default when the server is reachable from the network or in production', () => {
  assert.equal(loadConfig({ HOST: '0.0.0.0' }).adminWrites, false);
  assert.equal(loadConfig({ HOST: '192.168.1.20' }).adminWrites, false);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).adminWrites, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' }).adminWrites, false);
});

test('ADMIN_WRITES=on forces them on and ADMIN_WRITES=off forces them off', () => {
  assert.equal(loadConfig({ ADMIN_WRITES: 'on', HOST: '0.0.0.0' }).adminWrites, true);
  assert.equal(loadConfig({ ADMIN_WRITES: 'on', NODE_ENV: 'production' }).adminWrites, true);
  assert.equal(loadConfig({ ADMIN_WRITES: 'off' }).adminWrites, false);
  assert.equal(loadConfig({ ADMIN_WRITES: 'auto' }).adminWrites, true);
});

test('ADMIN_WRITES only accepts auto, on or off (surrounding spaces are fine, capital letters are not)', () => {
  for (const bad of ['yes', 'true', '1', 'ON', 'Auto', 'enabled']) {
    assert.throws(() => loadConfig({ ADMIN_WRITES: bad }), /ADMIN_WRITES must be one of/, bad);
  }
  assert.equal(loadConfig({ ADMIN_WRITES: ' on ' }).adminWrites, true);
});

test('the setting is part of the frozen config and an empty value means auto', () => {
  const c = loadConfig({ ADMIN_WRITES: '' });
  assert.equal(c.adminWritesSetting, 'auto');
  assert.equal(c.adminWrites, true);
  assert.throws(() => { c.adminWrites = false; }, TypeError);
});
