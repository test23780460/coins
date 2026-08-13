#!/usr/bin/env node
/**
 * Interactive Worker setup after `npx wrangler login`.
 * Sets secrets and deploys. Does not print the password back.
 *
 * Usage (from repo root):
 *   node scripts/setup-worker.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const workerDir = path.join(root, 'worker');
const crypto = webcrypto;
const PBKDF2_ITERATIONS = 100000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || root,
      stdio: opts.input != null ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      shell: true,
      env: process.env,
    });
    if (opts.input != null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );
  const hash = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const b64 = (bytes) =>
    Buffer.from(bytes)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

function randomSecret(len = 48) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

const rl = createInterface({ input, output });

console.log('SkyBlock Coin Tracker — Worker setup\n');
console.log('Prerequisites: wrangler login already completed.\n');

const password = await rl.question('Choose your site login password: ');
if (!password || password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
const confirm = await rl.question('Confirm password: ');
if (password !== confirm) {
  console.error('Passwords do not match.');
  process.exit(1);
}

let githubToken = await rl.question(
  'GitHub PAT (Contents R/W on skyblock-coin-data) [Enter to use current gh token]: '
);
if (!githubToken.trim()) {
  githubToken = await new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'token'], { shell: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error('Could not read gh auth token'));
    });
  });
}

rl.close();

const passwordHash = await hashPassword(password);
const sessionSecret = randomSecret(48);

console.log('\nSetting Worker secrets (values are not echoed)...');
await run('npx', ['wrangler', 'secret', 'put', 'AUTH_PASSWORD_HASH'], {
  cwd: workerDir,
  input: passwordHash + '\n',
});
await run('npx', ['wrangler', 'secret', 'put', 'SESSION_SECRET'], {
  cwd: workerDir,
  input: sessionSecret + '\n',
});
await run('npx', ['wrangler', 'secret', 'put', 'GITHUB_TOKEN'], {
  cwd: workerDir,
  input: githubToken.trim() + '\n',
});

console.log('\nDeploying Worker...');
await run('npx', ['wrangler', 'deploy'], { cwd: workerDir });

console.log(`
Done.

Next:
1. Copy the Worker URL from the deploy output (https://skyblock-coin-tracker.<subdomain>.workers.dev)
2. Set GitHub Actions variable on the coins repo:
   gh variable set VITE_API_BASE_URL --body "https://YOUR-WORKER-URL" --repo test23780460/coins
3. Re-run the Pages workflow (or push an empty commit) so the frontend rebuilds with that API URL.
`);
