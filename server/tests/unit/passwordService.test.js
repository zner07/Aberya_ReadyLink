'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, hashPasswordSync, verifyPassword, parseHash, isValidHashFormat, passwordProblem, DEFAULT_COST, MIN_PASSWORD_LENGTH } = require('../../src/services/passwordService');

const FAST = { N: 1024, r: 8, p: 1 }; // low cost, only to keep the tests quick

test('a hash is one text value that does not contain the password', () => {
  const hash = hashPasswordSync('my very long secret password', FAST);
  assert.match(hash, /^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(!hash.includes('secret'));
  assert.ok(isValidHashFormat(hash));
});

test('the same password gives a different hash every time (random salt), and both verify', async () => {
  const a = hashPasswordSync('same password twice', FAST);
  const b = hashPasswordSync('same password twice', FAST);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password twice', a), true);
  assert.equal(await verifyPassword('same password twice', b), true);
});

test('the right password verifies, a wrong one does not', async () => {
  const hash = await hashPassword('correct horse battery staple', FAST);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  for (const wrong of ['correct horse battery stapl', 'Correct horse battery staple', 'correct horse battery staple ', '', 'x'.repeat(5000)]) {
    assert.equal(await verifyPassword(wrong, hash), false, JSON.stringify(wrong.slice(0, 20)));
  }
});

test('the real default settings are strong (scrypt N=32768) and still verify', async () => {
  assert.deepEqual({ ...DEFAULT_COST }, { N: 32768, r: 8, p: 1 });
  const hash = await hashPassword('a long enough passphrase');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('a long enough passphrase', hash), true);
});

test('verifyPassword never throws: broken stored values and odd inputs are simply "wrong"', async () => {
  const hash = hashPasswordSync('whatever password 1', FAST);
  for (const stored of [undefined, null, '', 'plain-text-password', 'scrypt$1$2$3$a$b', hash.slice(0, -5), hash.replace('1024', '999'), hash.replace('$8$', '$0$'), 12345, {}]) {
    assert.equal(await verifyPassword('whatever password 1', stored), false, String(stored));
  }
  for (const input of [undefined, null, 123, {}, []]) assert.equal(await verifyPassword(input, hash), false);
});

test('parseHash only accepts safe settings', () => {
  const hash = hashPasswordSync('some password here', FAST);
  const parsed = parseHash(hash);
  assert.deepEqual([parsed.N, parsed.r, parsed.p], [1024, 8, 1]);
  assert.equal(parsed.key.length, 64);
  assert.equal(parseHash(hash.replace('$1024$', '$1000$')), null, 'N must be a power of two');
  assert.equal(parseHash(hash.replace('$1024$', '$512$')), null, 'N must not be tiny');
  assert.equal(parseHash(hash.replace('$1024$', '$4294967296$')), null, 'N must not be huge');
  assert.equal(parseHash(hash.replace('$1$', '$99$')), null);
  assert.equal(parseHash('x'), null);
});

test('hashing refuses unsafe settings', () => {
  for (const cost of [{ N: 1000, r: 8, p: 1 }, { N: 512, r: 8, p: 1 }, { N: 1024, r: 0, p: 1 }, { N: 1024, r: 8, p: 99 }]) {
    assert.throws(() => hashPasswordSync('whatever password', cost), /Unsupported password hash settings/);
  }
});

test('passwordProblem: the setup script refuses weak passwords', () => {
  assert.match(passwordProblem('short'), /at least 12/);
  assert.match(passwordProblem('a'.repeat(201)), /at most 200/);
  assert.match(passwordProblem(' leading space here'), /space/);
  assert.match(passwordProblem('trailing space here '), /space/);
  assert.match(passwordProblem('aaaaaaaaaaaaaaaa'), /different characters/);
  assert.match(passwordProblem('password12345'), /too easy/);
  assert.match(passwordProblem('my-barangay.admin-2026', { username: 'barangay.admin' }), /username/);
  assert.equal(passwordProblem('A long passphrase 2026'), null);
  assert.equal(passwordProblem(undefined), `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
});
