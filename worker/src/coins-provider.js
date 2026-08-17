/**
 * Unified liquid-coin provider.
 * Prefers SkyCrypt structured API when tokenized access works; otherwise Hypixel upstream.
 */

import { fetchSkyCryptLiquidCoins, SkyCryptError } from './skycrypt.js';
import { fetchHypixelLiquidCoins, HypixelError } from './hypixel.js';

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ skycrypt?: string, hypixel?: string }} [details]
   */
  constructor(message, code = 'PROVIDER', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {any} env
 */
export function getAutoConfig(env) {
  const enabled = String(env.AUTO_LOG_ENABLED ?? 'true').toLowerCase() !== 'false';
  const uuid = String(env.SKYCRYPT_PLAYER_UUID || '')
    .replace(/-/g, '')
    .trim()
    .toLowerCase();
  return {
    enabled,
    player: String(env.SKYCRYPT_PLAYER || 'justiwantdreams').trim(),
    profile: String(env.SKYCRYPT_PROFILE || 'Raspberry').trim(),
    uuid: /^[a-f0-9]{32}$/.test(uuid) ? uuid : null,
    inactivityHours: Number(env.AUTO_LOG_INACTIVITY_HOURS) || 24,
    minIntervalHours: Number(env.AUTO_LOG_MIN_INTERVAL_HOURS) || 24,
    preferSkyCrypt:
      String(env.AUTO_LOG_PREFER_SKYCRYPT ?? 'true').toLowerCase() !== 'false' &&
      Boolean(env.SKYCRYPT_API_TOKEN),
  };
}

/**
 * Fetch liquid coins for the configured player/profile.
 * @param {any} env
 */
export async function fetchLiquidCoins(env) {
  const cfg = getAutoConfig(env);
  const opts = {
    player: cfg.player,
    profile: cfg.profile,
    ...(cfg.uuid ? { uuid: cfg.uuid } : {}),
  };
  const errors = {};

  if (cfg.preferSkyCrypt) {
    try {
      return await fetchSkyCryptLiquidCoins(env, opts);
    } catch (err) {
      errors.skycrypt = err.message || String(err);
      if (
        err instanceof SkyCryptError &&
        (err.code === 'WRONG_PLAYER' ||
          err.code === 'WRONG_PROFILE' ||
          err.code === 'INVALID_BALANCE')
      ) {
        throw err;
      }
    }
  } else {
    errors.skycrypt = 'skipped (no SKYCRYPT_API_TOKEN)';
  }

  try {
    return await fetchHypixelLiquidCoins(env, opts);
  } catch (err) {
    errors.hypixel = err.message || String(err);
    if (err instanceof HypixelError) {
      throw new ProviderError(
        `Unable to fetch liquid coins. SkyCrypt: ${errors.skycrypt || 'skipped'}; Hypixel: ${errors.hypixel}`,
        err.code,
        errors
      );
    }
    throw new ProviderError(
      `Unable to fetch liquid coins. SkyCrypt: ${errors.skycrypt || 'skipped'}; Hypixel: ${errors.hypixel}`,
      'PROVIDER',
      errors
    );
  }
}

export { SkyCryptError, HypixelError };
