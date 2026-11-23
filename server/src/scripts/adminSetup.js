'use strict';
/* Creates (or changes) the admin account.   Run from the server folder:   npm.cmd run admin:setup

   It asks for a username and a password (the password is not shown while you type), then writes THREE lines in server/.env:
     ADMIN_USERNAME        the username
     ADMIN_PASSWORD_HASH   a scrypt hash of the password. The password itself is never saved anywhere.
     ADMIN_SESSION_SECRET  a long random value used to protect login sessions
   Other lines in .env are kept. The old .env is copied to .env.bak-<time> first. Restart the server afterwards.
   There is no default account and no default password. Nothing is open until you run this. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SERVER_DIR } = require('../config');
const { hashPassword, passwordProblem } = require('../services/passwordService');

const KEYS = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET'];
const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{1,100}$/;

/* Returns the .env text with these KEY=value lines replaced (or added). Every other line stays exactly as it was. */
function applyEnvUpdates(text, updates) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const missing = [];
  for (const [key, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*${key}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`);
    let at = lines.findIndex((l) => active.test(l));
    if (at === -1) at = lines.findIndex((l) => commented.test(l));
    if (at === -1) missing.push(key);
    else lines[at] = `${key}=${value}`;
  }
  if (missing.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '# --- Admin login (written by: npm.cmd run admin:setup) ---');
    for (const key of missing) lines.push(`${key}=${updates[key]}`);
    lines.push('');
  }
  return lines.join(eol);
}

function currentValue(text, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

/* The part the tests use. Throws an Error with a readable message when something is not acceptable. */
async function runSetup({ envFile, exampleFile, username, password, cost, now = () => new Date() }) {
  if (!USERNAME_PATTERN.test(username || '')) throw new Error('Use 1 to 100 characters for the username: letters, numbers and . _ @ + -');
  const problem = passwordProblem(password, { username });
  if (problem) throw new Error(problem);

  const existed = fs.existsSync(envFile);
  let text = '';
  if (existed) text = fs.readFileSync(envFile, 'utf8');
  else if (exampleFile && fs.existsSync(exampleFile)) text = fs.readFileSync(exampleFile, 'utf8');

  let backup = null;
  if (existed) {
    const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = `${envFile}.bak-${stamp}`;
    fs.copyFileSync(envFile, backup);
  }

  const updates = {
    ADMIN_USERNAME: username,
    ADMIN_PASSWORD_HASH: await hashPassword(password, cost),
    ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
  };
  fs.writeFileSync(envFile, applyEnvUpdates(text, updates), { mode: 0o600 });
  return { envFile, backup, created: !existed };
}

/* ---- the interactive part ------------------------------------------------------------------------------------------ */
function ask(question) {
  return new Promise((resolve) => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/* Reads a line without showing what is typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\nCancelled.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const envFile = process.env.READYLINK_ENV_FILE || path.join(SERVER_DIR, '.env');
  const exampleFile = path.join(SERVER_DIR, '.env.example');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  console.log('\nREADYLINK admin setup');
  console.log('This saves an admin username and a HASH of the password in server/.env. The password itself is never saved.\n');

  let username = process.env.ADMIN_SETUP_USERNAME;
  let password = process.env.ADMIN_SETUP_PASSWORD;
  if (username === undefined || password === undefined) {
    if (!process.stdin.isTTY) {
      console.error('This needs a normal terminal window (PowerShell) to type the password.\nFor automation only, set ADMIN_SETUP_USERNAME and ADMIN_SETUP_PASSWORD.\n');
      process.exit(1);
    }
    const old = currentValue(existing, 'ADMIN_USERNAME');
    username = (await ask(`Admin username${old ? ` [${old}]` : ''}: `)) || old;
    password = await askHidden(`Password (at least 12 characters, not shown): `);
    const again = await askHidden('Type the password again: ');
    if (again !== password) {
      console.error('\nThe two passwords are not the same. Nothing was saved.\n');
      process.exit(1);
    }
  } else {
    console.log('(using ADMIN_SETUP_USERNAME and ADMIN_SETUP_PASSWORD from the environment)\n');
  }

  try {
    const result = await runSetup({ envFile, exampleFile, username, password });
    console.log(`\nDone. The admin account "${username}" is saved in ${result.envFile}`);
    if (result.backup) console.log(`The previous file was copied to ${result.backup} (delete it when you no longer need it).`);
    console.log('\nNext: restart the server (stop it with Ctrl+C, then run: npm.cmd start), open the site and use Admin > Sign in.');
    console.log('Never share or commit server/.env. It is already listed in .gitignore.\n');
  } catch (err) {
    console.error(`\n${err.message}\nNothing was saved.\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { applyEnvUpdates, runSetup, currentValue, KEYS, USERNAME_PATTERN };
