/**
 * 24-hour inactivity auto-logging orchestration.
 */

import { readJsonFile, writeJsonFile, ConflictError } from './github.js';
import { loadStore, mutateStore } from './store.js';
import { newEntryId, compactCoins } from './validation.js';
import { fetchLiquidCoins, getAutoConfig, ProviderError } from './coins-provider.js';
import { maybeSaveProfileSnapshot } from './profile-snapshots.js';
import { getApiKeyStatus, getExternalApiKey } from './api-key-store.js';

export const AUTOMATION_STATE_PATH = 'data/automation-state.json';
export const SOURCE_MANUAL = 'manual';
export const SOURCE_AUTO_SKYCRYPT = 'auto-skycrypt';
export const SOURCE_AUTO_HYPIXEL = 'auto-hypixel';

const AUTO_NOTE =
  'Automatically logged from SkyCrypt/Hypixel after 24 hours without a manual entry.';

const MANUAL_CHECK_NOTE = 'Logged from Run Auto Check (Hypixel/SkyCrypt).';

/**
 * @param {any} entry
 */
export function isAutoSource(entry) {
  const s = entry?.source;
  return s === SOURCE_AUTO_SKYCRYPT || s === SOURCE_AUTO_HYPIXEL;
}

/**
 * Entries without source are treated as manual (backwards compatible).
 * @param {any} entry
 */
export function isManualSource(entry) {
  return !isAutoSource(entry);
}

/**
 * @param {Array<{ timestamp: string, source?: string }>} entries
 */
export function findLastManualAt(entries) {
  let latest = null;
  for (const e of entries || []) {
    if (!isManualSource(e)) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (latest == null || t > latest) latest = t;
  }
  return latest;
}

/**
 * @param {Array<{ timestamp: string, source?: string }>} entries
 */
export function findLastAutoAt(entries) {
  let latest = null;
  for (const e of entries || []) {
    if (!isAutoSource(e)) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (latest == null || t > latest) latest = t;
  }
  return latest;
}

/**
 * Pure eligibility decision (testable).
 * @param {{
 *   now: number,
 *   enabled: boolean,
 *   inactivityMs: number,
 *   minIntervalMs: number,
 *   lastManualAt: number|null,
 *   lastAutoAt: number|null,
 *   suppressAutoUntil: number|null,
 * }} input
 */
export function evaluateAutoEligibility(input) {
  const {
    now,
    enabled,
    inactivityMs,
    minIntervalMs,
    lastManualAt,
    lastAutoAt,
    suppressAutoUntil,
  } = input;

  if (!enabled) {
    return { eligible: false, reason: 'disabled' };
  }
  if (suppressAutoUntil != null && now < suppressAutoUntil) {
    return {
      eligible: false,
      reason: 'suppressed_after_delete',
      nextEligibleAt: suppressAutoUntil,
    };
  }

  // No manual entries yet: allow first auto only after inactivity window from "epoch of empty"
  // Practical rule: if never manually logged, require minInterval from last auto (or allow if none).
  if (lastManualAt != null) {
    const sinceManual = now - lastManualAt;
    if (sinceManual < inactivityMs) {
      return {
        eligible: false,
        reason: 'manual_recent',
        nextEligibleAt: lastManualAt + inactivityMs,
        hoursSinceManual: sinceManual / 3600000,
      };
    }
  }

  if (lastAutoAt != null) {
    const sinceAuto = now - lastAutoAt;
    if (sinceAuto < minIntervalMs) {
      return {
        eligible: false,
        reason: 'auto_recent',
        nextEligibleAt: lastAutoAt + minIntervalMs,
        hoursSinceAuto: sinceAuto / 3600000,
      };
    }
  }

  const nextFromManual =
    lastManualAt != null ? lastManualAt + inactivityMs : null;
  const nextFromAuto = lastAutoAt != null ? lastAutoAt + minIntervalMs : null;
  const bases = [nextFromManual, nextFromAuto].filter((n) => n != null);
  const nextEligibleAt = bases.length ? Math.max(...bases) : now;

  return {
    eligible: true,
    reason: 'eligible',
    nextEligibleAt,
  };
}

/**
 * @param {any} env
 */
export async function loadAutomationState(env) {
  const file = await readJsonFile(env, AUTOMATION_STATE_PATH);
  if (!file.exists) {
    return {
      data: emptyAutomationState(),
      sha: null,
    };
  }
  return {
    data: normalizeAutomationState(file.data),
    sha: file.sha,
  };
}

/**
 * @param {any} env
 * @param {object} state
 * @param {string|null} sha
 * @param {string} message
 */
export async function saveAutomationState(env, state, sha, message) {
  return writeJsonFile(env, AUTOMATION_STATE_PATH, state, sha, message);
}

export function emptyAutomationState() {
  return {
    version: 1,
    lastManualAt: null,
    lastAutoAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    suppressAutoUntil: null,
    lastFetch: null,
  };
}

/**
 * @param {any} raw
 */
export function normalizeAutomationState(raw) {
  const base = emptyAutomationState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    lastManualAt: isoOrNull(raw.lastManualAt),
    lastAutoAt: isoOrNull(raw.lastAutoAt),
    lastAttemptAt: isoOrNull(raw.lastAttemptAt),
    lastSuccessAt: isoOrNull(raw.lastSuccessAt),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    lastErrorAt: isoOrNull(raw.lastErrorAt),
    suppressAutoUntil: isoOrNull(raw.suppressAutoUntil),
    lastFetch:
      raw.lastFetch && typeof raw.lastFetch === 'object' ? raw.lastFetch : null,
  };
}

function isoOrNull(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Build public automation status for the dashboard.
 * @param {any} env
 * @param {Array} entries
 * @param {object} state
 */
export async function buildAutomationStatus(env, entries, state) {
  const cfg = getAutoConfig(env);
  const now = Date.now();
  const lastManualAt = findLastManualAt(entries) ?? (state.lastManualAt ? Date.parse(state.lastManualAt) : null);
  const lastAutoAt = findLastAutoAt(entries) ?? (state.lastAutoAt ? Date.parse(state.lastAutoAt) : null);
  const suppressAutoUntil = state.suppressAutoUntil
    ? Date.parse(state.suppressAutoUntil)
    : null;

  const decision = evaluateAutoEligibility({
    now,
    enabled: cfg.enabled,
    inactivityMs: cfg.inactivityHours * 3600000,
    minIntervalMs: cfg.minIntervalHours * 3600000,
    lastManualAt,
    lastAutoAt,
    suppressAutoUntil: Number.isFinite(suppressAutoUntil) ? suppressAutoUntil : null,
  });

  const apiConnection = await getApiKeyStatus(env);
  const hasKey = Boolean(await getExternalApiKey(env));

  return {
    enabled: cfg.enabled,
    player: cfg.player,
    profile: cfg.profile,
    inactivityHours: cfg.inactivityHours,
    minIntervalHours: cfg.minIntervalHours,
    hasHypixelKey: hasKey,
    hasSkyCryptToken: Boolean(env.SKYCRYPT_API_TOKEN),
    apiConnection,
    lastManualAt: lastManualAt != null ? new Date(lastManualAt).toISOString() : null,
    lastAutoAt: lastAutoAt != null ? new Date(lastAutoAt).toISOString() : null,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    suppressAutoUntil: state.suppressAutoUntil,
    lastFetch: state.lastFetch,
    eligibleNow: decision.eligible,
    eligibilityReason: decision.reason,
    nextEligibleAt:
      decision.nextEligibleAt != null
        ? new Date(decision.nextEligibleAt).toISOString()
        : null,
  };
}

/**
 * Record manual activity timestamp (best-effort).
 * @param {any} env
 * @param {string} timestampIso
 */
export async function recordManualActivity(env, timestampIso) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await loadAutomationState(env);
      data.lastManualAt = timestampIso;
      data.suppressAutoUntil = null;
      try {
        await saveAutomationState(
          env,
          data,
          sha,
          `Automation: manual activity ${timestampIso.slice(0, 10)}`
        );
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    console.error('Failed to record manual activity', err);
  }
}

/**
 * After deleting an auto entry, suppress recreation until min interval elapses.
 * @param {any} env
 */
export async function suppressAutoAfterDelete(env) {
  const cfg = getAutoConfig(env);
  const until = new Date(
    Date.now() + cfg.minIntervalHours * 3600000
  ).toISOString();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await loadAutomationState(env);
      data.suppressAutoUntil = until;
      try {
        await saveAutomationState(
          env,
          data,
          sha,
          'Automation: suppress after auto entry delete'
        );
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    console.error('Failed to set auto suppress', err);
  }
}

/**
 * Hourly cron entry point — may no-op unless `force` is set (manual Run Auto Check).
 * @param {any} env
 * @param {{ force?: boolean, fetched?: any }} [options]
 */
export async function runScheduledAutoLog(env, options = {}) {
  const force = Boolean(options.force);
  const cfg = getAutoConfig(env);
  const result = {
    ranAt: new Date().toISOString(),
    created: false,
    skipped: true,
    reason: null,
  };

  if (!cfg.enabled && !force) {
    result.reason = 'disabled';
    return result;
  }

  // Mark attempt
  let stateWrap = await loadAutomationState(env);
  stateWrap.data.lastAttemptAt = result.ranAt;
  try {
    await saveAutomationState(
      env,
      stateWrap.data,
      stateWrap.sha,
      force ? 'Automation: manual check' : 'Automation: hourly check'
    );
    stateWrap = await loadAutomationState(env);
  } catch (err) {
    console.error('Failed to stamp automation attempt', err);
  }

  // Fetch profile once — used for coins (if eligible) and profile analytics
  let fetched = options.fetched || null;
  if (!fetched) {
    try {
      fetched = await fetchLiquidCoins(env);
    } catch (err) {
      const message = err.message || 'fetch failed';
      console.error('Auto-log fetch failed', err);
      await stampAutomationError(env, message, {
        skycrypt: err.details?.skycrypt,
        hypixel: err.details?.hypixel,
        code: err.code,
      });
      result.reason = 'fetch_failed';
      result.error = message;
      return result;
    }
  }

  // Profile analytics — independent of coin eligibility / inactivity timer
  result.profileSnapshot = await maybeSaveProfileSnapshot(env, fetched.profileAnalytics, {
    triggeredBy: force ? 'manual-check' : 'cron',
    source: fetched.provider === 'skycrypt' ? 'auto-skycrypt' : 'auto-hypixel',
  });

  // Coin eligibility (skipped when force)
  let store = await loadStore(env);
  if (!force) {
    const now = Date.now();
    const lastManualAt =
      findLastManualAt(store.entries) ??
      (stateWrap.data.lastManualAt ? Date.parse(stateWrap.data.lastManualAt) : null);
    const lastAutoAt =
      findLastAutoAt(store.entries) ??
      (stateWrap.data.lastAutoAt ? Date.parse(stateWrap.data.lastAutoAt) : null);
    const suppressAutoUntil = stateWrap.data.suppressAutoUntil
      ? Date.parse(stateWrap.data.suppressAutoUntil)
      : null;

    const decision = evaluateAutoEligibility({
      now,
      enabled: cfg.enabled,
      inactivityMs: cfg.inactivityHours * 3600000,
      minIntervalMs: cfg.minIntervalHours * 3600000,
      lastManualAt,
      lastAutoAt,
      suppressAutoUntil: Number.isFinite(suppressAutoUntil) ? suppressAutoUntil : null,
    });

    if (!decision.eligible) {
      result.reason = decision.reason;
      return result;
    }
  }

  // Re-check immediately before commit (manual may have won) — skipped when force
  if (!force) {
    store = await loadStore(env);
    stateWrap = await loadAutomationState(env);
    const lastManualAt2 =
      findLastManualAt(store.entries) ??
      (stateWrap.data.lastManualAt ? Date.parse(stateWrap.data.lastManualAt) : null);
    const lastAutoAt2 =
      findLastAutoAt(store.entries) ??
      (stateWrap.data.lastAutoAt ? Date.parse(stateWrap.data.lastAutoAt) : null);
    const suppress2 = stateWrap.data.suppressAutoUntil
      ? Date.parse(stateWrap.data.suppressAutoUntil)
      : null;
    const decision2 = evaluateAutoEligibility({
      now: Date.now(),
      enabled: cfg.enabled,
      inactivityMs: cfg.inactivityHours * 3600000,
      minIntervalMs: cfg.minIntervalHours * 3600000,
      lastManualAt: lastManualAt2,
      lastAutoAt: lastAutoAt2,
      suppressAutoUntil: Number.isFinite(suppress2) ? suppress2 : null,
    });
    if (!decision2.eligible) {
      result.reason = `aborted_${decision2.reason}`;
      return result;
    }
  }

  const source =
    fetched.provider === 'skycrypt' ? SOURCE_AUTO_SKYCRYPT : SOURCE_AUTO_HYPIXEL;
  const timestamp = new Date().toISOString();

  try {
    await mutateStore(env, async (s) => {
      if (!force) {
        // Final in-mutator guard against duplicates from concurrent crons
        const manual = findLastManualAt(s.entries);
        const auto = findLastAutoAt(s.entries);
        const guard = evaluateAutoEligibility({
          now: Date.now(),
          enabled: true,
          inactivityMs: cfg.inactivityHours * 3600000,
          minIntervalMs: cfg.minIntervalHours * 3600000,
          lastManualAt: manual,
          lastAutoAt: auto,
          suppressAutoUntil: null,
        });
        if (!guard.eligible) {
          throw Object.assign(new Error(`Auto-log aborted: ${guard.reason}`), {
            status: 409,
            code: 'AUTO_ABORT',
          });
        }
      }

      const entry = {
        id: newEntryId(),
        coins: fetched.coins,
        timestamp,
        note: force ? MANUAL_CHECK_NOTE : AUTO_NOTE,
        source,
        meta: {
          profile: fetched.profileCuteName || cfg.profile,
          player: cfg.player,
          provider: fetched.provider,
          fetchedAt: fetched.fetchedAt,
          purse: fetched.purse,
          bank: fetched.bank,
          personalBank: fetched.personalBank,
          bankApiUnavailable: Boolean(fetched.bankApiUnavailable),
          lastUpdated: fetched.lastUpdated,
          triggeredBy: force ? 'manual-check' : 'cron',
        },
      };
      return {
        entries: [...s.entries, entry],
        version: s.version,
        message: force
          ? `Manual auto check: ${compactCoins(fetched.coins)} (${source})`
          : `Auto balance: ${compactCoins(fetched.coins)} (${source})`,
      };
    });
  } catch (err) {
    if (err.code === 'AUTO_ABORT') {
      result.reason = err.message;
      return result;
    }
    console.error('Auto-log commit failed', err);
    await stampAutomationError(env, err.message || 'commit failed');
    result.reason = 'commit_failed';
    result.error = err.message;
    return result;
  }

  // Update automation state success
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await loadAutomationState(env);
      fresh.data.lastAutoAt = timestamp;
      fresh.data.lastSuccessAt = timestamp;
      fresh.data.lastError = null;
      fresh.data.lastErrorAt = null;
      fresh.data.lastFetch = {
        provider: fetched.provider,
        coins: fetched.coins,
        purse: fetched.purse,
        bank: fetched.bank,
        personalBank: fetched.personalBank,
        fetchedAt: fetched.fetchedAt,
        triggeredBy: force ? 'manual-check' : 'cron',
      };
      try {
        await saveAutomationState(
          env,
          fresh.data,
          fresh.sha,
          force
            ? `Automation: manual check ${compactCoins(fetched.coins)}`
            : `Automation: recorded auto balance ${compactCoins(fetched.coins)}`
        );
        break;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    console.error('Failed to update automation success state', err);
  }

  result.created = true;
  result.skipped = false;
  result.reason = 'created';
  result.coins = fetched.coins;
  result.source = source;
  return result;
}

async function stampAutomationError(env, message, extra = null) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await loadAutomationState(env);
      data.lastError = message.slice(0, 500);
      data.lastErrorAt = new Date().toISOString();
      if (extra) data.lastFetch = { error: true, ...extra, at: data.lastErrorAt };
      try {
        await saveAutomationState(env, data, sha, 'Automation: fetch/commit error');
        return;
      } catch (err) {
        if (err instanceof ConflictError && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    console.error('Failed to stamp automation error', err);
  }
}

export { ProviderError, AUTO_NOTE };
