'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateUpdate, normalizeStatus, STATUSES, LEVELS, MAX_REMARK_LENGTH } = require('../../src/services/reportValidation');

test('the statuses are the ones the whole project already uses, in the same order', () => {
  assert.deepEqual([...STATUSES], ['Pending', 'Verified', 'Under monitoring', 'Resolved']);
});

test('normalizeStatus accepts any capital letters but always returns the exact stored name', () => {
  assert.equal(normalizeStatus('Under Monitoring'), 'Under monitoring');
  assert.equal(normalizeStatus('under monitoring'), 'Under monitoring');
  assert.equal(normalizeStatus('  VERIFIED '), 'Verified');
  assert.equal(normalizeStatus('pending'), 'Pending');
  assert.equal(normalizeStatus('Resolved'), 'Resolved');
});

test('normalizeStatus rejects everything that is not one of the four statuses', () => {
  for (const bad of ['Done', 'Closed', 'Under  monitoring', 'Underm onitoring', '', '   ', null, undefined, 5, true, {}, ['Pending'], 'Pending;DROP TABLE reports']) {
    assert.equal(normalizeStatus(bad), null, String(bad));
  }
});

test('a valid status change passes', () => {
  assert.deepEqual(validateUpdate({ status: 'Verified' }), { value: { status: 'Verified' }, errors: {} });
  assert.deepEqual(validateUpdate({ status: 'under monitoring' }).value, { status: 'Under monitoring' });
});

test('every one of the four statuses and three levels is accepted', () => {
  for (const status of STATUSES) assert.deepEqual(validateUpdate({ status }).errors, {}, status);
  for (const level of LEVELS) assert.deepEqual(validateUpdate({ level }).errors, {}, level);
});

test('an invalid status is rejected with a readable message', () => {
  for (const status of ['Done', 'Closed', 5, [], {}, true]) {
    const { value, errors } = validateUpdate({ status });
    assert.equal(value, null, String(status));
    assert.match(errors.status, /Use one of: Pending, Verified, Under monitoring, Resolved/);
  }
});

test('an invalid level is rejected', () => {
  for (const level of ['High', 'high', 'urgent', 5, {}]) {
    assert.match(validateUpdate({ level }).errors.level, /Use one of: hi, mod, lo/, String(level));
  }
});

test('a remark is trimmed and cleaned, and may be combined with a status', () => {
  assert.deepEqual(validateUpdate({ status: 'Verified', remark: '  Checked by the tanod.  ' }).value, { status: 'Verified', remark: 'Checked by the tanod.' });
  assert.equal(validateUpdate({ remark: 'Line one\nLine two\u0000\u0007' }).value.remark, 'Line one\nLine two');
  assert.equal(validateUpdate({ remark: '<b>bold</b> & "quotes"' }).value.remark, '<b>bold</b> & "quotes"', 'stored as plain text; the page escapes it');
});

test('a remark has a maximum length', () => {
  assert.equal(validateUpdate({ remark: 'a'.repeat(MAX_REMARK_LENGTH) }).errors.remark, undefined);
  assert.match(validateUpdate({ remark: 'a'.repeat(MAX_REMARK_LENGTH + 1) }).errors.remark, /500/);
  assert.match(validateUpdate({ remark: 12345 }).errors.remark, /must be text/);
  assert.match(validateUpdate({ remark: { text: 'x' } }).errors.remark, /must be text/);
});

test('an empty remark means "no remark" (the admin form sends an empty box as "")', () => {
  assert.deepEqual(validateUpdate({ status: 'Verified', remark: '' }).value, { status: 'Verified' });
  assert.deepEqual(validateUpdate({ status: 'Verified', remark: '   ' }).value, { status: 'Verified' });
  assert.deepEqual(validateUpdate({ status: 'Verified', remark: null }).value, { status: 'Verified' });
});

test('a change with nothing to do is rejected', () => {
  for (const body of [{}, { remark: '' }, { status: null, level: null, remark: null }, { id: 'RL-001' }, { mine: true }]) {
    const { value, errors } = validateUpdate(body);
    assert.equal(value, null, JSON.stringify(body));
    assert.match(errors._body, /Send a status, a level or a remark/);
  }
});

test('a body that is not an object is rejected', () => {
  for (const body of [null, undefined, 'Verified', 5, [], [{ status: 'Verified' }]]) {
    const { value, errors } = validateUpdate(body);
    assert.equal(value, null, String(body));
    assert.ok(errors._body, String(body));
  }
});

test('all problems are reported together', () => {
  const { value, errors } = validateUpdate({ status: 'Done', level: 'x', remark: 5 });
  assert.equal(value, null);
  assert.deepEqual(Object.keys(errors).sort(), ['level', 'remark', 'status']);
});

test('id, public_id, created and owner fields sent by the client are ignored', () => {
  const { value } = validateUpdate({ status: 'Resolved', id: 'RL-999', public_id: 'RL-999', createdAt: '2000-01-01', client_id: 'x', mine: true, ai: 'lo', desc: 'changed', type: 'tree' });
  assert.deepEqual(value, { status: 'Resolved' });
});
