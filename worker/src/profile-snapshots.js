/**
 * Save profile analytics snapshots independently from coin logging.
 */

import {
  assertAnalyticsIdentity,
  shouldSkipDuplicateSnapshot,
  normalizeProfileSnapshot,
} from './profile-analytics.js';
import { loadProfileStore, appendProfileSnapshot } from './profile-store.js';
import { getAutoConfig } from './coins-provider.js';
import { newEntryId } from './validation.js';

/**
 * Attempt to persist analytics from a successful provider fetch.
 * Never throws into the coin path — failures are logged and ignored.
 *
 * @param {any} env
 * @param {any} analyticsPayload from buildAnalyticsPayload / provider attach
 * @param {{ triggeredBy?: string, source?: string }} [opts]
 */
export async function maybeSaveProfileSnapshot(env, analyticsPayload, opts = {}) {
  const result = {
    saved: false,
    skipped: true,
    reason: null,
  };

  try {
    if (!analyticsPayload) {
      result.reason = 'no_analytics';
      return result;
    }

    const cfg = getAutoConfig(env);
    const identity = assertAnalyticsIdentity(analyticsPayload, {
      player: cfg.player,
      profile: cfg.profile,
    });
    if (!identity.ok) {
      result.reason = identity.reason;
      return result;
    }

    if (!analyticsPayload.skillsAvailable && !analyticsPayload.netWorthAvailable) {
      result.reason = 'empty_analytics';
      return result;
    }

    const timestamp = new Date().toISOString();
    const snapshot = {
      id: newEntryId(),
      timestamp,
      player: cfg.player,
      profile: cfg.profile,
      profileId: analyticsPayload.profileId || null,
      netWorth: analyticsPayload.netWorthAvailable ? analyticsPayload.netWorth : null,
      netWorthAvailable: Boolean(analyticsPayload.netWorthAvailable),
      skills: analyticsPayload.skillsAvailable ? analyticsPayload.skills : {},
      totalSkillXp: analyticsPayload.skillsAvailable
        ? analyticsPayload.totalSkillXp
        : null,
      skillsAvailable: Boolean(analyticsPayload.skillsAvailable),
      source: opts.source || analyticsPayload.provider || 'unknown',
      provider: analyticsPayload.provider,
      fetchedAt: analyticsPayload.fetchedAt || timestamp,
      meta: {
        triggeredBy: opts.triggeredBy || 'unknown',
      },
    };

    const store = await loadProfileStore(env);
    const chrono = [...store.entries].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    );
    const previous = chrono.length ? chrono[chrono.length - 1] : null;

    if (shouldSkipDuplicateSnapshot(previous, snapshot)) {
      result.reason = 'duplicate';
      return result;
    }

    await appendProfileSnapshot(
      env,
      snapshot,
      `Profile snapshot: ${cfg.player}/${cfg.profile}`
    );
    result.saved = true;
    result.skipped = false;
    result.reason = 'saved';
    result.snapshot = normalizeProfileSnapshot(snapshot);
    return result;
  } catch (err) {
    console.error('Profile snapshot save failed', err);
    result.reason = 'save_failed';
    result.error = err.message || String(err);
    return result;
  }
}
