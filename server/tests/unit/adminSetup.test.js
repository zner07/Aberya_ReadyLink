'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { applyEnvUpdates, runSetup, currentValue } = require('../../src/scripts/adminSetup');
const { verifyPassword } = require('../../src/services/passwordService');
const { loadConfig } = require('../../src/config');
const { tempDir, removeDir } = require('../helpers/env');

const FAST = { N: 1024, r: 8, p: 1 };
const EXAMPLE = path.join(__dirname, '..', '..', '.env.example');

test('applyEnvUpdates replaces existing lines, adds missing ones, and keeps everything else exactly', () => {
  const before = '# my notes\nPORT=4000\nADMIN_USERNAME=old\n\nDB_FILE=./data/x.db\n';
  const after = applyEnvUpdates(before, { ADMIN_USERNAME: 'new', ADMIN_PASSWORD_HASH: 'H', ADMIN_SESSION_SECRET: 'S' });
  const parsed = util.parseEnv(after);
  assert.equal(parsed.ADMIN_USERNAME, 'new');
  assert.equal(parsed.ADMIN_PASSWORD_HASH, 'H');
  assert.equal(parsed.PORT, '4000');
  assert.equal(parsed.DB_FILE, './data/x.db');
  assert.ok(after.includes('# my notes'));
  assert.equal((after.match(/^ADMIN_USERNAME=/gm) || []).length, 1);
});

test('applyEnvUpdates fills in the commented placeholders of .env.example in place', () => {
  const after = applyEnvUpdates(fs.readFileSync(EXAMPLE, 'utf8'), { ADMIN_USERNAME: 'u', ADMIN_PASSWORD_HASH: 'h', ADMIN_SESSION_SECRET: 's' });
  assert.equal(util.parseEnv(after).ADMIN_SESSION_SECRET, 's');
  assert.equal((after.match(/ADMIN_SESSION_SECRET=/g) || []).length, 1, 'the placeholder was replaced, not repeated');
});

test('applyEnvUpdates keeps Windows line endings', () => {
  const out = applyEnvUpdates('PORT=3000\r\n', { ADMIN_USERNAME: 'u' });
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
});

test('runSetup creates .env from the example, saves a HASH (never the password) and the config accepts it', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const envFile = path.join(dir, '.env');
  const password = 'Brgy-Alangilan admin 2026!';
  const result = await runSetup({ envFile, exampleFile: EXAMPLE, username: 'barangay.admin', password, cost: FAST });
  assert.equal(result.created, true);
  const text = fs.readFileSync(envFile, 'utf8');
  assert.ok(!text.includes(password), 'the password is not in the file');
  const parsed = util.parseEnv(text);
  assert.equal(await verifyPassword(password, parsed.ADMIN_PASSWORD_HASH), true);
  assert.ok(parsed.ADMIN_SESSION_SECRET.length >= 32);
  assert.equal(loadConfig(parsed).adminAuth.configured, true);
  assert.equal(parsed.ADMIN_SESSION_HOURS, '8', 'the other settings of the example are kept');
});

test('running it again changes the password, makes a backup of the old file, and makes a new session secret', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const envFile = path.join(dir, '.env');
  await runSetup({ envFile, exampleFile: EXAMPLE, username: 'admin.one', password: 'First long passphrase 1', cost: FAST });
  const first = util.parseEnv(fs.readFileSync(envFile, 'utf8'));
  const second = await runSetup({ envFile, exampleFile: EXAMPLE, username: 'admin.one', password: 'Second long passphrase 2', cost: FAST });
  const now = util.parseEnv(fs.readFileSync(envFile, 'utf8'));
  assert.equal(await verifyPassword('Second long passphrase 2', now.ADMIN_PASSWORD_HASH), true);
  assert.equal(await verifyPassword('First long passphrase 1', now.ADMIN_PASSWORD_HASH), false);
  assert.notEqual(now.ADMIN_SESSION_SECRET, first.ADMIN_SESSION_SECRET);
  assert.ok(second.backup && fs.existsSync(second.backup));
  assert.equal(util.parseEnv(fs.readFileSync(second.backup, 'utf8')).ADMIN_USERNAME, 'admin.one', 'the backup is the old file');
});

test('weak passwords and odd usernames are refused and NOTHING is written', async (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const envFile = path.join(dir, '.env');
  for (const [username, password, message] of [['admin', 'short', /at least 12/], ['bad name!', 'A fine long passphrase 1', /username/], ['', 'A fine long passphrase 1', /username/], ['admin', 'password12345', /too easy/], ['barangay.admin', 'xx barangay.admin xx 99', /must not contain the username/]]) {
    await assert.rejects(() => runSetup({ envFile, exampleFile: EXAMPLE, username, password, cost: FAST }), message);
  }
  assert.equal(fs.existsSync(envFile), false);
});

test('currentValue reads the existing username for the prompt', () => {
  assert.equal(currentValue('A=1\nADMIN_USERNAME= boss \n', 'ADMIN_USERNAME'), 'boss');
  assert.equal(currentValue('A=1\n', 'ADMIN_USERNAME'), '');
});

test('.env is listed in .gitignore, so the real secrets cannot be committed by accident', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m);
});
