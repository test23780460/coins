/**
 * SkyCrypt structured API client.
 *
 * Modern SkyCrypt (sky.shiiyu.moe) serves stats from SkyCrypt-Backend:
 *   GET /api/stats/{player}/{profileCuteNameOrId}
 *
 * Production requires header: X-API-Token (SERVER_API_TOKEN).
 * Set Worker secret SKYCRYPT_API_TOKEN when available.
 *
 * Liquid coins = purse + bank + personalBank (SkyCrypt fields).
 */

export class SkyCryptError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code = 'SKYCRYPT') {
    super(message);
    this.code = code;
  }
}

/**
 * @param {any} env
 * @param {{ player: string, profile: string }} opts
 */
export async function fetchSkyCryptLiquidCoins(env, opts) {
  const player = String(opts.player || '').trim();
  const profile = String(opts.profile || '').trim();
  if (!player || !profile) {
    throw new SkyCryptError('Player and profile are required', 'CONFIG');
  }

  const base = (env.SKYCRYPT_API_BASE || 'https://sky.shiiyu.moe').replace(/\/$/, '');
  const url = `${base}/api/stats/${encodeURIComponent(player)}/${encodeURIComponent(profile)}`;

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'skyblock-coin-tracker-worker/1.0',
  };
  if (env.SKYCRYPT_API_TOKEN) {
    headers['X-API-Token'] = env.SKYCRYPT_API_TOKEN;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Number(env.SKYCRYPT_TIMEOUT_MS) || 20000),
    });
  } catch (err) {
    throw new SkyCryptError(`SkyCrypt request failed: ${err.message || 'network error'}`, 'NETWORK');
  }

  if (res.status === 401 || res.status === 403) {
    throw new SkyCryptError('SkyCrypt API unauthorized (token required or blocked)', 'UNAUTHORIZED');
  }
  if (res.status === 404) {
    throw new SkyCryptError('SkyCrypt player/profile not found', 'NOT_FOUND');
  }
  if (res.status === 429) {
    throw new SkyCryptError('SkyCrypt rate limited', 'RATE_LIMIT');
  }
  if (res.status >= 500) {
    throw new SkyCryptError(`SkyCrypt server error (${res.status})`, 'UPSTREAM');
  }
  if (!res.ok) {
    throw new SkyCryptError(`SkyCrypt HTTP ${res.status}`, 'HTTP');
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new SkyCryptError('SkyCrypt returned non-JSON response', 'MALFORMED');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new SkyCryptError('SkyCrypt returned invalid JSON', 'MALFORMED');
  }

  if (data?.error) {
    throw new SkyCryptError(String(data.error), 'UPSTREAM');
  }

  return parseSkyCryptStatsPayload(data, { player, profile });
}

/**
 * Pure parser for SkyCrypt stats JSON (testable).
 * @param {any} data
 * @param {{ player: string, profile: string }} expected
 */
export function parseSkyCryptStatsPayload(data, expected) {
  if (!data || typeof data !== 'object') {
    throw new SkyCryptError('Malformed SkyCrypt payload', 'MALFORMED');
  }

  const cute =
    data.profile_cute_name ||
    data.cute_name ||
    data.profile?.cute_name ||
    data.profile?.profile_cute_name;
  const username =
    data.username ||
    data.display_name ||
    data.player?.username ||
    data.player?.displayname;

  if (username && !equalsIgnoreCase(username, expected.player)) {
    throw new SkyCryptError(
      `SkyCrypt returned unexpected player "${username}"`,
      'WRONG_PLAYER'
    );
  }
  if (cute && !equalsIgnoreCase(cute, expected.profile)) {
    throw new SkyCryptError(
      `SkyCrypt returned unexpected profile "${cute}"`,
      'WRONG_PROFILE'
    );
  }

  if (!('purse' in data)) {
    throw new SkyCryptError('Missing purse field', 'MISSING_FIELDS');
  }

  const purse = Number(data.purse);
  if (!Number.isFinite(purse) || purse < 0) {
    throw new SkyCryptError('Invalid purse value', 'INVALID_BALANCE');
  }

  // bank may be null in schema when unknown — treat unknown as failure (safe)
  if (!('bank' in data) || data.bank == null) {
    throw new SkyCryptError('Missing bank balance', 'MISSING_FIELDS');
  }
  const bank = Number(data.bank);
  if (!Number.isFinite(bank) || bank < 0) {
    throw new SkyCryptError('Invalid bank value', 'INVALID_BALANCE');
  }

  const personalBank = Number(data.personalBank ?? 0);
  if (!Number.isFinite(personalBank) || personalBank < 0) {
    throw new SkyCryptError('Invalid personal bank value', 'INVALID_BALANCE');
  }

  const coins = Math.round(purse + bank + personalBank);
  if (!Number.isFinite(coins) || coins < 0 || !Number.isSafeInteger(coins)) {
    throw new SkyCryptError('Computed balance is invalid', 'INVALID_BALANCE');
  }

  return {
    provider: 'skycrypt',
    player: expected.player,
    profile: expected.profile,
    profileCuteName: cute || expected.profile,
    coins,
    purse: Math.round(purse),
    bank: Math.round(bank),
    personalBank: Math.round(personalBank),
    fetchedAt: new Date().toISOString(),
    lastUpdated: data.last_updated || data.lastUpdated || null,
  };
}

function equalsIgnoreCase(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
