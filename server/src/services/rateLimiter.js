'use strict';
/* A small in-memory counter with a time window, used to slow down guessing (admin login) and to protect the place-search
   proxy from being used too much. It lives in this server process only: restarting the server clears it, and it does not
   work across several server copies. That is fine for this project, and README says so. */
function createCounter({ max, windowMs, now = Date.now, maxKeys = 5000 }) {
  const entries = new Map(); // key -> { count, start }

  function current(key) {
    const t = now();
    const e = entries.get(key);
    if (!e || t - e.start >= windowMs) {
      entries.delete(key);
      return { count: 0, start: t };
    }
    return e;
  }
  function prune() {
    if (entries.size < maxKeys) return;
    const t = now();
    for (const [k, e] of entries) if (t - e.start >= windowMs) entries.delete(k);
    while (entries.size >= maxKeys) entries.delete(entries.keys().next().value); // oldest first
  }
  const retryAfter = (e) => Math.max(1, Math.ceil((e.start + windowMs - now()) / 1000));

  return {
    /* Counts one event. allowed is true while the count is still within max. */
    hit(key) {
      const e = current(key);
      e.count += 1;
      prune();
      entries.set(key, e);
      return { allowed: e.count <= max, count: e.count, retryAfterSec: retryAfter(e) };
    },
    /* Looks without counting. blocked is true once max events were counted in the window. */
    peek(key) {
      const e = current(key);
      return { blocked: e.count >= max, count: e.count, retryAfterSec: retryAfter(e) };
    },
    reset(key) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

module.exports = { createCounter };
