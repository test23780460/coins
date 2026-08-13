/**
 * Password hashing (PBKDF2) and signed session tokens.
 * Secrets: AUTH_PASSWORD_HASH, SESSION_SECRET
 */

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/**
 * Hash a password for storage as AUTH_PASSWORD_HASH.
 * Format: pbkdf2$sha256$iterations$saltB64$hashB64
 * @param {string} password
 * @param {string} [saltB64]
 */
export async function hashPassword(password, saltB64) {
  const salt = saltB64
    ? b64ToBytes(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const hash = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

/**
 * Verify password against stored hash. Constant-time-ish compare.
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') {
    return false;
  }
  const iterations = Number(parts[2]);
  const salt = b64ToBytes(parts[3]);
  const expected = b64ToBytes(parts[4]);
  const key = await deriveKey(password, salt, iterations);
  const actual = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/**
 * Create a signed session token.
 * @param {string} sessionSecret
 */
export async function createSessionToken(sessionSecret) {
  const payload = {
    v: 1,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: bytesToB64(crypto.getRandomValues(new Uint8Array(12))),
  };
  const body = utf8ToB64(JSON.stringify(payload));
  const sig = await hmacSign(sessionSecret, body);
  return `${body}.${sig}`;
}

/**
 * Validate session token. Returns payload or null.
 * @param {string} token
 * @param {string} sessionSecret
 */
export async function verifySessionToken(token, sessionSecret) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = await hmacSign(sessionSecret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(b64ToUtf8(body));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

/**
 * Extract Bearer token from request.
 * @param {Request} request
 */
export function getBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function deriveKey(password, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToB64(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const normalized = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToB64(str) {
  return bytesToB64(new TextEncoder().encode(str));
}

function b64ToUtf8(b64) {
  return new TextDecoder().decode(b64ToBytes(b64));
}
