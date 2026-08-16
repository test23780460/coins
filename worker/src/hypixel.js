/**
 * Hypixel SkyBlock profiles client (SkyCrypt's upstream data source).
 *
 * Used when SkyCrypt's HTTP API is unavailable (it requires a private X-API-Token).
 * Liquid coins = purse + coop bank + personal bank for the configured cute-name profile.
 */

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
  if (!env.HYPIXEL_API_KEY) {
    throw new HypixelError('HYPIXEL_API_KEY is not configured', 'CONFIG');
  }

  const uuid = (opts.uuid || (await resolveUuid(player))).replace(/-/g, '').toLowerCase();

  let res;
  try {
    res = await fetch(
      `https://api.hypixel.net/v2/skyblock/profiles?uuid=${encodeURIComponent(uuid)}`,
      {
        method: 'GET',
        headers: {
          'API-Key': env.HYPIXEL_API_KEY,
          Accept: 'application/json',
          'User-Agent': 'skyblock-coin-tracker-worker/1.0',
        },
        signal: AbortSignal.timeout(Number(env.HYPIXEL_TIMEOUT_MS) || 20000),
      }
    );
  } catch (err) {
    throw new HypixelError(`Hypixel request failed: ${err.message || 'network error'}`, 'NETWORK');
  }

  if (res.status === 403 || res.status === 401) {
    throw new HypixelError('Hypixel API key rejected', 'UNAUTHORIZED');
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

  let data;
  try {
    data = await res.json();
  } catch {
    throw new HypixelError('Hypixel returned invalid JSON', 'MALFORMED');
  }

  if (!data || data.success !== true) {
    throw new HypixelError(data?.cause || 'Hypixel request unsuccessful', 'UPSTREAM');
  }

  return parseHypixelProfilesPayload(data, { player, profile, uuid });
}

/**
 * @param {string} username
 */
export async function resolveUuid(username) {
  let res;
  try {
    res = await fetch(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'skyblock-coin-tracker-worker/1.0' },
        signal: AbortSignal.timeout(10000),
      }
    );
  } catch (err) {
    throw new HypixelError(`UUID lookup failed: ${err.message || 'network error'}`, 'NETWORK');
  }
  if (res.status === 404 || res.status === 204) {
    throw new HypixelError(`Player not found: ${username}`, 'NOT_FOUND');
  }
  if (!res.ok) {
    throw new HypixelError(`UUID lookup HTTP ${res.status}`, 'HTTP');
  }
  const data = await res.json();
  if (!data?.id) {
    throw new HypixelError('UUID lookup returned no id', 'MALFORMED');
  }
  if (data.name && String(data.name).toLowerCase() !== String(username).toLowerCase()) {
    // Mojang returns canonical casing — still OK if case differs
  }
  return String(data.id);
}

/**
 * Pure parser for Hypixel profiles payload (testable).
 * @param {any} data
 * @param {{ player: string, profile: string, uuid: string }} expected
 */
export function parseHypixelProfilesPayload(data, expected) {
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
  // Hypixel member keys are undashed lowercase uuids
  const member =
    members[uuid] ||
    members[expected.uuid] ||
    Object.entries(members).find(([k]) => k.replace(/-/g, '').toLowerCase() === uuid)?.[1];

  if (!member || typeof member !== 'object') {
    throw new HypixelError('Player member data missing on profile', 'WRONG_PLAYER');
  }

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

  // Coop bank — must be present to interpret "bank balance"
  if (!profile.banking || typeof profile.banking !== 'object' || !('balance' in profile.banking)) {
    throw new HypixelError('Missing bank balance (banking API off or unavailable)', 'MISSING_FIELDS');
  }
  const bank = Number(profile.banking.balance);
  if (!Number.isFinite(bank) || bank < 0) {
    throw new HypixelError('Invalid bank value', 'INVALID_BALANCE');
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
    fetchedAt: new Date().toISOString(),
    lastUpdated: null,
  };
}
