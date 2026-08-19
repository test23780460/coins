/**
 * Encrypted Hypixel API key storage in Cloudflare KV (PRIVATE_CONFIG).
 *
 * Raw keys never leave the Worker except when calling Hypixel.
 * Frontend only receives non-sensitive status metadata (lastFour, timestamps).
 */

import { encryptSecret, decryptSecret, ConfigCryptoError } from './crypto-config.js';

export const KV_API_KEY_RECORD = 'hypixel_api_key_v1';

/**
 * @typedef {{
 *   v: number,
 *   iv: string,
 *   ciphertext: string,
 *   updatedAt: string,
 *   lastFour: string,
 *   lastValidationAt: string|null,
 *   validationStatus: 'valid'|'invalid'|'unknown',
 *   lastSuccessfulRequest: string|null,
 *   lastError: string|null,
 *   lastErrorAt: string|null,
 * }} ApiKeyRecord
 */

/**
 * Central helper — all Hypixel requests must use this.
 * Prefers encrypted KV value; falls back to legacy Worker secret HYPIXEL_API_KEY.
 * @param {any} env
 * @returns {Promise<string|null>}
 */
export async function getExternalApiKey(env) {
  const fromKv = await readDecryptedApiKey(env);
  if (fromKv) return fromKv;

  const legacy = String(env.HYPIXEL_API_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  return legacy || null;
}

/**
 * @param {any} env
 * @returns {Promise<string|null>}
 */
async function readDecryptedApiKey(env) {
  const record = await loadApiKeyRecord(env);
  if (!record?.iv || !record?.ciphertext) return null;
  try {
    const plain = await decryptSecret(
      { iv: record.iv, ciphertext: record.ciphertext },
      env
    );
    const key = String(plain || '')
      .trim()
      .replace(/^["']|["']$/g, '');
    return key || null;
  } catch (err) {
    console.error('API key decrypt failed', err?.code || err?.message);
    return null;
  }
}

/**
 * @param {any} env
 * @returns {Promise<ApiKeyRecord|null>}
 */
export async function loadApiKeyRecord(env) {
  if (!env.PRIVATE_CONFIG) return null;
  try {
    const raw = await env.PRIVATE_CONFIG.get(KV_API_KEY_RECORD, 'json');
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch (err) {
    console.error('Failed to read API key record', err);
    return null;
  }
}

/**
 * Public status for the dashboard — never includes the raw key.
 * @param {any} env
 */
export async function getApiKeyStatus(env) {
  const record = await loadApiKeyRecord(env);
  const legacyConfigured = Boolean(
    String(env.HYPIXEL_API_KEY || '')
      .trim()
      .replace(/^["']|["']$/g, '')
  );
  const configured = Boolean(record?.ciphertext) || legacyConfigured;

  let status = 'needs_key';
  if (record?.validationStatus === 'invalid') status = 'invalid';
  else if (configured) status = 'connected';

  const updatedAt = record?.updatedAt || null;
  const ageDays = updatedAt ? (Date.now() - Date.parse(updatedAt)) / 86400000 : null;
  const mayNeedRotation =
    status === 'connected' && Number.isFinite(ageDays) && ageDays >= 6;

  return {
    configured,
    status,
    lastFour: record?.lastFour || null,
    updatedAt,
    lastValidationAt: record?.lastValidationAt || null,
    lastSuccessfulRequest: record?.lastSuccessfulRequest || null,
    lastError: record?.validationStatus === 'invalid' ? record?.lastError || null : null,
    lastErrorAt: record?.validationStatus === 'invalid' ? record?.lastErrorAt || null : null,
    source: record?.ciphertext ? 'kv' : legacyConfigured ? 'legacy_secret' : 'none',
    mayNeedRotation,
    ageDays: Number.isFinite(ageDays) ? Math.floor(ageDays) : null,
  };
}

/**
 * Basic Hypixel developer key format check (UUID-like).
 * @param {string} apiKey
 */
export function validateApiKeyFormat(apiKey) {
  const key = String(apiKey || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) return { ok: false, error: 'API key is required' };
  if (key.length < 20 || key.length > 128) {
    return { ok: false, error: 'API key length looks invalid' };
  }
  // Hypixel keys are typically UUID format; allow nearby variants
  if (!/^[0-9a-fA-F-]{20,80}$/.test(key) && !/^[A-Za-z0-9_-]{20,128}$/.test(key)) {
    return { ok: false, error: 'API key format looks invalid' };
  }
  return { ok: true, key };
}

/**
 * Read-only Hypixel validation using the candidate key.
 * Confirms the key works for the configured player's SkyBlock profiles.
 * @param {any} env
 * @param {string} apiKey
 */
export async function validateHypixelApiKey(env, apiKey) {
  const profile = String(env.SKYCRYPT_PROFILE || 'Raspberry').trim();
  const uuid = String(env.SKYCRYPT_PLAYER_UUID || '')
    .replace(/-/g, '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(uuid)) {
    return { ok: false, error: 'Player UUID is not configured on the Worker' };
  }

  let res;
  try {
    res = await fetch(
      `https://api.hypixel.net/v2/skyblock/profiles?uuid=${encodeURIComponent(uuid)}`,
      {
        method: 'GET',
        headers: {
          'API-Key': apiKey,
          Accept: 'application/json',
          'User-Agent': 'skyblock-coin-tracker-worker/1.0',
        },
        signal: AbortSignal.timeout(20000),
      }
    );
  } catch (err) {
    return { ok: false, error: `Could not reach Hypixel (${err.message || 'network error'})` };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: data?.cause || 'Hypixel rejected this API key',
    };
  }
  if (!res.ok) {
    return { ok: false, error: `Hypixel returned HTTP ${res.status}` };
  }
  if (!data || data.success !== true) {
    return { ok: false, error: data?.cause || 'Hypixel request was unsuccessful' };
  }
  if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
    return { ok: false, error: 'Key worked but no SkyBlock profiles were returned' };
  }

  const profileMatch = data.profiles.find(
    (p) =>
      p &&
      typeof p.cute_name === 'string' &&
      p.cute_name.toLowerCase() === profile.toLowerCase()
  );
  if (!profileMatch) {
    return {
      ok: false,
      error: `Key worked but profile "${profile}" was not found`,
    };
  }

  return { ok: true, profile: profileMatch.cute_name };
}

/**
 * Persist a validated key. Call ONLY after validateHypixelApiKey succeeds.
 * @param {any} env
 * @param {string} apiKey
 */
export async function saveValidatedApiKey(env, apiKey) {
  if (!env.PRIVATE_CONFIG) {
    throw new ConfigCryptoError('PRIVATE_CONFIG KV binding is missing', 'CONFIG');
  }
  if (!env.CONFIG_ENCRYPTION_KEY) {
    throw new ConfigCryptoError('CONFIG_ENCRYPTION_KEY is not configured', 'CONFIG');
  }

  const now = new Date().toISOString();
  const lastFour = apiKey.slice(-4).toUpperCase();
  const { iv, ciphertext } = await encryptSecret(apiKey, env);

  /** @type {ApiKeyRecord} */
  const record = {
    v: 1,
    iv,
    ciphertext,
    updatedAt: now,
    lastFour,
    lastValidationAt: now,
    validationStatus: 'valid',
    lastSuccessfulRequest: now,
    lastError: null,
    lastErrorAt: null,
  };

  await env.PRIVATE_CONFIG.put(KV_API_KEY_RECORD, JSON.stringify(record));
  return {
    lastFour,
    updatedAt: now,
    status: 'connected',
  };
}

/**
 * Mark current key invalid after Hypixel rejects it. Does not delete the ciphertext.
 * @param {any} env
 * @param {string} message
 */
export async function markApiKeyInvalid(env, message) {
  const record = await loadApiKeyRecord(env);
  if (!record || !env.PRIVATE_CONFIG) return;
  record.validationStatus = 'invalid';
  record.lastError = String(message || 'API key invalid').slice(0, 300);
  record.lastErrorAt = new Date().toISOString();
  try {
    await env.PRIVATE_CONFIG.put(KV_API_KEY_RECORD, JSON.stringify(record));
  } catch (err) {
    console.error('Failed to mark API key invalid', err);
  }
}

/**
 * Record a successful Hypixel request against the current key.
 * @param {any} env
 */
export async function markApiKeySuccess(env) {
  const record = await loadApiKeyRecord(env);
  if (!record || !env.PRIVATE_CONFIG) return;
  const now = new Date().toISOString();
  record.validationStatus = 'valid';
  record.lastSuccessfulRequest = now;
  record.lastValidationAt = now;
  record.lastError = null;
  record.lastErrorAt = null;
  try {
    await env.PRIVATE_CONFIG.put(KV_API_KEY_RECORD, JSON.stringify(record));
  } catch (err) {
    console.error('Failed to mark API key success', err);
  }
}

/**
 * Full update flow: format → live validate → encrypt+store. Never overwrites on failure.
 * @param {any} env
 * @param {string} candidate
 */
export async function updateExternalApiKey(env, candidate) {
  const format = validateApiKeyFormat(candidate);
  if (!format.ok) {
    return {
      ok: false,
      error: format.error,
      code: 'VALIDATION',
    };
  }

  const previous = await loadApiKeyRecord(env);
  const validation = await validateHypixelApiKey(env, format.key);
  if (!validation.ok) {
    return {
      ok: false,
      error:
        'That API key could not be validated. Your existing key was left unchanged.',
      detail: validation.error,
      code: 'INVALID_KEY',
      preserved: Boolean(previous?.ciphertext),
    };
  }

  try {
    const saved = await saveValidatedApiKey(env, format.key);
    return {
      ok: true,
      message: 'API key updated and validated.',
      ...saved,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || 'Failed to store API key',
      code: err.code || 'STORE',
      preserved: Boolean(previous?.ciphertext),
    };
  }
}
