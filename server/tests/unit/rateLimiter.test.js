'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCounter } = require('../../src/services/rateLimiter');

const clock = (start = 1000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('hit counts events and is allowed up to max', () => {
  const c = clock();
  const counter = createCounter({ max: 3, windowMs: 60000, now: c.now });
  assert.deepEqual([1, 2, 3, 4].map(() => counter.hit('a').allowed), [true, true, true, false]);
});

test('keys are independent', () => {
  const counter = createCounter({ max: 1, windowMs: 60000, now: clock().now });
  assert.equal(counter.hit('a').allowed, true);
  assert.equal(counter.hit('a').allowed, false);
  assert.equal(counter.hit('b').allowed, true);
});

test('the window ends: counting starts again after windowMs', () => {
  const c = clock();
  const counter = createCounter({ max: 2, windowMs: 1000, now: c.now });
  counter.hit('a'); counter.hit('a');
  assert.equal(counter.hit('a').allowed, false);
  c.advance(1000);
  assert.equal(counter.hit('a').allowed, true);
});

test('peek looks without counting, and reports blocked once max was reached', () => {
  const counter = createCounter({ max: 2, windowMs: 60000, now: clock().now });
  assert.equal(counter.peek('a').blocked, false);
  counter.hit('a'); counter.hit('a');
  assert.equal(counter.peek('a').blocked, true);
  assert.equal(counter.peek('a').count, 2, 'peek did not add to the count');
});

test('retryAfterSec tells how long to wait (at least 1 second)', () => {
  const c = clock();
  const counter = createCounter({ max: 1, windowMs: 90000, now: c.now });
  counter.hit('a');
  assert.equal(counter.hit('a').retryAfterSec, 90);
  c.advance(89500);
  assert.equal(counter.peek('a').retryAfterSec, 1);
});

test('reset forgets a key', () => {
  const counter = createCounter({ max: 1, windowMs: 60000, now: clock().now });
  counter.hit('a'); counter.hit('a');
  counter.reset('a');
  assert.equal(counter.peek('a').blocked, false);
});

test('memory stays bounded: old keys are dropped when there are too many', () => {
  const counter = createCounter({ max: 5, windowMs: 60000, now: clock().now, maxKeys: 50 });
  for (let i = 0; i < 500; i += 1) counter.hit(`key-${i}`);
  assert.ok(counter.size() <= 50, String(counter.size()));
});
