/**
 * AES-GCM helpers for encrypting private runtime config (API keys) at rest in KV.
 * CONFIG_ENCRYPTION_KEY must be a Worker secret (32+ bytes, base64 or hex).
 */

export class ConfigCryptoError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'CRYPTO') {
    super(message);
    this.code = code;
  }
}

/**
 * @param {string} secret
 * @returns {Uint8Array}
 */
export function decodeEncryptionKeyMaterial(secret) {
  const raw = String(secret || '').trim();
  if (!raw) {
    throw new ConfigCryptoError('CONFIG_ENCRYPTION_KEY is not configured', 'CONFIG');
  }

  // Prefer base64
  try {
    const b64 = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    if (b64.length >= 32) return b64.slice(0, 32);
  } catch {
    // fall through
  }

  // Hex
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length >= 64) {
    const hex = raw.slice(0, 64);
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  // UTF-8 passphrase — derive 32 bytes via SHA-256
  // (acceptable for Worker secret paste; prefer random 32-byte base64 in production)
  return null; // signal async derive
}

/**
 * @param {any} env
 * @returns {Promise<CryptoKey>}
 */
export async function importConfigEncryptionKey(env) {
  if (!env?.CONFIG_ENCRYPTION_KEY) {
    throw new ConfigCryptoError('CONFIG_ENCRYPTION_KEY is not configured', 'CONFIG');
  }

  let material = decodeEncryptionKeyMaterial(env.CONFIG_ENCRYPTION_KEY);
  if (!material) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(env.CONFIG_ENCRYPTION_KEY))
    );
    material = new Uint8Array(digest);
  }

  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * @param {string} plaintext
 * @param {any} env
 * @returns {Promise<{ iv: string, ciphertext: string }>}
 */
export async function encryptSecret(plaintext, env) {
  const key = await importConfigEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plaintext));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
  };
}

/**
 * @param {{ iv: string, ciphertext: string }} payload
 * @param {any} env
 * @returns {Promise<string>}
 */
export async function decryptSecret(payload, env) {
  if (!payload?.iv || !payload?.ciphertext) {
    throw new ConfigCryptoError('Encrypted payload is incomplete', 'CORRUPT');
  }
  let iv;
  let cipherBytes;
  try {
    iv = base64ToBytes(payload.iv);
    cipherBytes = base64ToBytes(payload.ciphertext);
  } catch {
    throw new ConfigCryptoError('Encrypted payload is malformed', 'CORRUPT');
  }

  try {
    const key = await importConfigEncryptionKey(env);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBytes
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    throw new ConfigCryptoError('Failed to decrypt config value', 'CORRUPT');
  }
}

/**
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * @param {string} b64
 */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
