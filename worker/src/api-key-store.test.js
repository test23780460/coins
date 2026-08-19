import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  ConfigCryptoError,
} from './crypto-config.js';
import {
  validateApiKeyFormat,
  getApiKeyStatus,
  getExternalApiKey,
  updateExternalApiKey,
  saveValidatedApiKey,
  markApiKeyInvalid,
  KV_API_KEY_RECORD,
} from './api-key-store.js';

const ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

function createMemoryKv(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key, type) {
      const v = map.get(key);
      if (v == null) return null;
      if (type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

describe('crypto round trip', () => {
  it('encrypts and decrypts', async () => {
    const env = { CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY };
    const payload = await encryptSecret('secret-api-key-value', env);
    expect(payload.iv).toBeTruthy();
    expect(payload.ciphertext).toBeTruthy();
    const plain = await decryptSecret(payload, env);
    expect(plain).toBe('secret-api-key-value');
  });

  it('corrupted ciphertext fails safely', async () => {
    const env = { CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY };
    const payload = await encryptSecret('abc', env);
    payload.ciphertext = Buffer.from('not-valid-gcm').toString('base64');
    await expect(decryptSecret(payload, env)).rejects.toBeInstanceOf(ConfigCryptoError);
  });
});

describe('validateApiKeyFormat', () => {
  it('accepts uuid-like keys', () => {
    expect(validateApiKeyFormat('681d77d7-1234-5678-9abc-def012345678').ok).toBe(true);
  });
  it('rejects empty / short', () => {
    expect(validateApiKeyFormat('').ok).toBe(false);
    expect(validateApiKeyFormat('short').ok).toBe(false);
  });
});

describe('api key store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('status never includes raw key', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
      HYPIXEL_API_KEY: '',
    };
    await saveValidatedApiKey(env, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const status = await getApiKeyStatus(env);
    expect(status.lastFour).toBe('EEEE');
    expect(JSON.stringify(status)).not.toMatch(/aaaaaaaa/i);
    expect(status).not.toHaveProperty('apiKey');
    expect(status).not.toHaveProperty('ciphertext');
  });

  it('getExternalApiKey decrypts KV value', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
    };
    const key = '11111111-2222-3333-4444-555555555555';
    await saveValidatedApiKey(env, key);
    expect(await getExternalApiKey(env)).toBe(key);
  });

  it('falls back to legacy Worker secret', async () => {
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: createMemoryKv(),
      HYPIXEL_API_KEY: 'legacy-key-abcdefghijklmnopqrstuvwxyz',
    };
    expect(await getExternalApiKey(env)).toBe('legacy-key-abcdefghijklmnopqrstuvwxyz');
  });

  it('invalid key rejected and old key preserved', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
      SKYCRYPT_PLAYER_UUID: '82f8e698500d46c792ee93cd1ca7ad7a',
      SKYCRYPT_PROFILE: 'Raspberry',
    };
    const oldKey = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await saveValidatedApiKey(env, oldKey);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, cause: 'Invalid API key' }), {
          status: 403,
        })
      )
    );

    const result = await updateExternalApiKey(env, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(result.ok).toBe(false);
    expect(result.preserved).toBe(true);
    expect(await getExternalApiKey(env)).toBe(oldKey);
  });

  it('valid key replaces old key', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
      SKYCRYPT_PLAYER_UUID: '82f8e698500d46c792ee93cd1ca7ad7a',
      SKYCRYPT_PROFILE: 'Raspberry',
    };
    await saveValidatedApiKey(env, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const newKey = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            success: true,
            profiles: [{ cute_name: 'Raspberry', members: {} }],
          }),
          { status: 200 }
        )
      )
    );

    const result = await updateExternalApiKey(env, newKey);
    expect(result.ok).toBe(true);
    expect(result.lastFour).toBe('BBBB');
    expect(await getExternalApiKey(env)).toBe(newKey);
  });

  it('mark invalid does not wipe ciphertext', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
    };
    const key = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await saveValidatedApiKey(env, key);
    await markApiKeyInvalid(env, 'expired');
    const status = await getApiKeyStatus(env);
    expect(status.status).toBe('invalid');
    expect(await getExternalApiKey(env)).toBe(key);
    const raw = await kv.get(KV_API_KEY_RECORD, 'json');
    expect(raw.ciphertext).toBeTruthy();
  });

  it('only final 4 characters displayed', async () => {
    const kv = createMemoryKv();
    const env = {
      CONFIG_ENCRYPTION_KEY: ENCRYPTION_KEY,
      PRIVATE_CONFIG: kv,
    };
    await saveValidatedApiKey(env, 'dddddddd-dddd-dddd-dddd-ddddddddA82F');
    const status = await getApiKeyStatus(env);
    expect(status.lastFour).toBe('A82F');
    expect(status.lastFour.length).toBe(4);
  });
});

describe('failure isolation expectations', () => {
  it('unauthorized Hypixel errors use UNAUTHORIZED code (no fake data path)', async () => {
    const { HypixelError } = await import('./hypixel.js');
    const err = new HypixelError('Hypixel API key rejected (Invalid API key)', 'UNAUTHORIZED');
    expect(err.code).toBe('UNAUTHORIZED');
  });
});
