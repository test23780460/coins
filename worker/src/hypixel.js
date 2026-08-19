/**
 * Hypixel SkyBlock profiles client (SkyCrypt's upstream data source).
 *
 * Used when SkyCrypt's HTTP API is unavailable (it requires a private X-API-Token).
 * Liquid coins = purse + coop bank + personal bank for the configured cute-name profile.
 */

import { analyticsFromHypixelMember } from './profile-analytics.js';
import {
  getExternalApiKey,
  markApiKeyInvalid,
  markApiKeySuccess,
} from './api-key-store.js';

export class HypixelError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code = 'HYPIXEL') {
    super(message);
    this.code = code;
  }
}

/**
 * @param {any} env
 * @param {{ player: string, profile: string, uuid?: string }} opts
 */
export async function fetchHypixelLiquidCoins(env, opts) {
  const player = String(opts.player || '').trim();
  const profile = String(opts.profile || '').trim();
  if (!player || !profile) {
    throw new HypixelError('Player and profile are required', 'CONFIG');
  }

  const apiKey = await getExternalApiKey(env);
  if (!apiKey) {
    throw new HypixelError('Hypixel API key is not configured', 'CONFIG');
  }

  const uuid = (
    opts.uuid ||
    (await resolveUuid(player, env))
  )
    .replace(/-/g, '')
    .toLowerCase();

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
        signal: AbortSignal.timeout(Number(env.HYPIXEL_TIMEOUT_MS) || 20000),
      }
    );
  } catch (err) {
    throw new HypixelError(`Hypixel request failed: ${err.message || 'network error'}`, 'NETWORK');
  }

  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  let data = null;
  if (bodyText) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = null;
    }
  }

  if (res.status === 403 || res.status === 401) {
    const cause = data?.cause || data?.error || `HTTP ${res.status}`;
    await markApiKeyInvalid(env, `Hypixel API key rejected (${cause})`);
    throw new HypixelError(`Hypixel API key rejected (${cause})`, 'UNAUTHORIZED');
  }
  if (res.status === 429) {
    throw new HypixelError('Hypixel rate limited', 'RATE_LIMIT');
  }
  if (res.status >= 500) {
    throw new HypixelError(`Hypixel server error (${res.status})`, 'UPSTREAM');
  }
  if (!res.ok) {
    throw new HypixelError(`Hypixel HTTP ${res.status}`, 'HTTP');
  }

  if (!data || data.success !== true) {
    throw new HypixelError(data?.cause || 'Hypixel request unsuccessful', 'UPSTREAM');
  }

  const parsed = parseHypixelProfilesPayload(data, { player, profile, uuid });
  await markApiKeySuccess(env);
  return parsed;
}

/**
 * @param {string} username
 * @param {any} [env]
 */
export async function resolveUuid(username, env = {}) {
  const configured = String(env.SKYCRYPT_PLAYER_UUID || '').replace(/-/g, '').trim();
  if (/^[a-f0-9]{32}$/i.test(configured)) {
    return configured.toLowerCase();
  }

  const errors = [];
  const providers = [
    {
      name: 'ashcon',
      url: `https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(username)}`,
      pick: (data) => data?.uuid,
    },
    {
      name: 'playerdb',
      url: `https://playerdb.co/api/player/minecraft/${encodeURIComponent(username)}`,
      pick: (data) => data?.data?.player?.id || data?.data?.player?.raw_id,
    },
    {
      name: 'mojang',
      url: `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
      pick: (data) => data?.id,
    },
  ];

  for (const provider of providers) {
    try {
      const res = await fetch(provider.url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'skyblock-coin-tracker-worker/1.0',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 204) {
        errors.push(`${provider.name}: not found`);
        continue;
      }
      if (!res.ok) {
        errors.push(`${provider.name}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const id = String(provider.pick(data) || '')
        .replace(/-/g, '')
        .toLowerCase();
      if (/^[a-f0-9]{32}$/.test(id)) return id;
      errors.push(`${provider.name}: malformed id`);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message || 'network error'}`);
    }
  }

  throw new HypixelError(
    `UUID lookup failed for ${username} (${errors.join('; ')})`,
    'NOT_FOUND'
  );
}

/**
 * Pure parser for Hypixel profiles payload (testable).
 * @param {any} data
 * @param {{ player: string, profile: string, uuid: string }} expected
 */
export function parseHypixelProfilesPayload(data, expected) {
  const { profile, member, uuid } = resolveHypixelMember(data, expected);

  const purseRaw =
    member.coin_purse ??
    member.currencies?.coin_purse ??
    member.currencies?.coins;
  if (purseRaw == null) {
    throw new HypixelError('Missing purse (coin_purse) field', 'MISSING_FIELDS');
  }
  const purse = Number(purseRaw);
  if (!Number.isFinite(purse) || purse < 0) {
    throw new HypixelError('Invalid purse value', 'INVALID_BALANCE');
  }

  // Coop bank — absent when Bank API is disabled in SkyBlock settings
  let bank = 0;
  let bankApiUnavailable = false;
  if (profile.banking && typeof profile.banking === 'object' && 'balance' in profile.banking) {
    bank = Number(profile.banking.balance);
    if (!Number.isFinite(bank) || bank < 0) {
      throw new HypixelError('Invalid bank value', 'INVALID_BALANCE');
    }
  } else {
    bankApiUnavailable = true;
  }

  const personalRaw =
    member.profile?.bank_account ??
    member.banking?.balance ??
    0;
  const personalBank = Number(personalRaw);
  if (!Number.isFinite(personalBank) || personalBank < 0) {
    throw new HypixelError('Invalid personal bank value', 'INVALID_BALANCE');
  }

  const coins = Math.round(purse + bank + personalBank);
  if (!Number.isFinite(coins) || coins < 0 || !Number.isSafeInteger(coins)) {
    throw new HypixelError('Computed balance is invalid', 'INVALID_BALANCE');
  }

  const fetchedAt = new Date().toISOString();
  const profileAnalytics = analyticsFromHypixelMember(member, {
    provider: 'hypixel',
    player: expected.player,
    profile: expected.profile,
    profileId: profile.profile_id || null,
    fetchedAt,
  });

  return {
    provider: 'hypixel',
    player: expected.player,
    profile: expected.profile,
    profileCuteName: profile.cute_name,
    profileId: profile.profile_id || null,
    uuid,
    coins,
    purse: Math.round(purse),
    bank: Math.round(bank),
    personalBank: Math.round(personalBank),
    bankApiUnavailable,
    fetchedAt,
    lastUpdated: null,
    profileAnalytics,
  };
}

/**
 * Parse coins and analytics independently from one Hypixel profiles payload.
 * Coin failure does not discard valid analytics (and vice versa).
 * @param {any} data
 * @param {{ player: string, profile: string, uuid: string }} expected
 */
export function parseHypixelProfileBundle(data, expected) {
  let profile;
  let member;
  let uuid;
  try {
    ({ profile, member, uuid } = resolveHypixelMember(data, expected));
  } catch (err) {
    return {
      coins: null,
      coinsError: err,
      analytics: null,
    };
  }

  const fetchedAt = new Date().toISOString();
  const analytics = analyticsFromHypixelMember(member, {
    provider: 'hypixel',
    player: expected.player,
    profile: expected.profile,
    profileId: profile.profile_id || null,
    fetchedAt,
  });

  let coins = null;
  let coinsError = null;
  try {
    coins = parseHypixelProfilesPayload(data, expected);
  } catch (err) {
    coinsError = err;
  }

  return { coins, coinsError, analytics, uuid, profileId: profile.profile_id || null };
}

/**
 * @param {any} data
 * @param {{ player: string, profile: string, uuid: string }} expected
 */
function resolveHypixelMember(data, expected) {
  const profiles = data?.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new HypixelError('No SkyBlock profiles returned', 'NOT_FOUND');
  }

  const profile = profiles.find(
    (p) =>
      p &&
      typeof p.cute_name === 'string' &&
      p.cute_name.toLowerCase() === expected.profile.toLowerCase()
  );
  if (!profile) {
    throw new HypixelError(
      `Profile "${expected.profile}" not found for player`,
      'WRONG_PROFILE'
    );
  }

  const uuid = expected.uuid.replace(/-/g, '').toLowerCase();
  const members = profile.members || {};
  const member =
    members[uuid] ||
    members[expected.uuid] ||
    Object.entries(members).find(([k]) => k.replace(/-/g, '').toLowerCase() === uuid)?.[1];

  if (!member || typeof member !== 'object') {
    throw new HypixelError('Player member data missing on profile', 'WRONG_PLAYER');
  }

  return { profile, member, uuid };
}

