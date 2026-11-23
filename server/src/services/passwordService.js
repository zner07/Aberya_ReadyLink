'use strict';
/* Password hashing with scrypt (built into Node.js, no extra package).

   A stored hash is ONE text value that carries everything needed to check a password later:
       scrypt$<N>$<r>$<p>$<salt, base64url>$<hash, base64url>
   - A new random salt is made for every hash, so two identical passwords never give the same text.
   - The cost settings (N, r, p) are inside the text, so they can be raised later without breaking old hashes.
   - Passwords are NEVER stored. Only this text goes in server/.env, and it is useless without the password.
   - Checking uses a constant-time comparison. */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const DEFAULT_COST = Object.freeze({ N: 32768, r: 8, p: 1 }); // about 80 ms on a normal laptop. Slow on purpose.
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MIN_N = 1024; // lower values are only meant for fast tests
const MAX_N = 2 ** 20;
const HASH_FORMAT = /^scrypt\$(\d{1,8})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{43,})$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

const maxMemory = (N, r) => 128 * N * r * 2 + 1024 * 1024; // scrypt needs about 128*N*r bytes

function checkCost({ N, r, p }) {
  const power = Number.isInteger(N) && N >= MIN_N && N <= MAX_N && (N & (N - 1)) === 0;
  if (!power || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new Error('Unsupported password hash settings.');
  }
}

function format({ N, r, p }, salt, key) {
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/* Turns stored text into its parts, or returns null when the text is not a valid hash. */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const m = HASH_FORMAT.exec(stored);
  if (!m) return null;
  const cost = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  try {
    checkCost(cost);
  } catch (err) {
    return null;
  }
  const salt = Buffer.from(m[4], 'base64url');
  const key = Buffer.from(m[5], 'base64url');
  if (salt.length < SALT_LENGTH || key.length !== KEY_LENGTH) return null; // a cut-off or altered hash is not a hash
  return { ...cost, salt, key };
}

const isValidHashFormat = (stored) => parseHash(stored) !== null;

function hashPasswordSync(password, cost = DEFAULT_COST) {
  checkCost(cost);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = crypto.scryptSync(String(password), salt, KEY_LENGTH, { ...cost, maxmem: maxMemory(cost.N, cost.r) });
  return format(cost, salt, key);
}

async function hashPassword(password, cost = DEFAULT_COST) {
  checkCost(cost);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await scryptAsync(String(password), salt, KEY_LENGTH, { ...cost, maxmem: maxMemory(cost.N, cost.r) });
  return format(cost, salt, key);
}

/* true / false. Never throws for bad input. A stored value that is not a valid hash is simply "wrong password". */
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH * 5) return false;
  try {
    const key = await scryptAsync(password, parsed.salt, parsed.key.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxMemory(parsed.N, parsed.r) });
    return key.length === parsed.key.length && crypto.timingSafeEqual(key, parsed.key);
  } catch (err) {
    return false;
  }
}

/* For the setup script. Returns a message when the password is not acceptable, otherwise null. */
function passwordProblem(password, { username = '' } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (/^\s|\s$/.test(password)) return 'Do not start or end the password with a space.';
  const lower = password.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase()) && String(username).length >= 4) return 'The password must not contain the username.';
  if (new Set(password).size < 5) return 'Use a password with more different characters.';
  if (/^(password|admin|readylink|qwerty|123456|letmein)/i.test(password)) return 'That password is too easy to guess.';
  return null;
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, parseHash, isValidHashFormat, passwordProblem, DEFAULT_COST, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
