/**
 * Profile analytics (skill XP + estimated net worth) — separate from coin tracking.
 *
 * Snapshots are derived from the same Hypixel/SkyCrypt profile fetch used for coins.
 * Missing metrics are left null/omitted; never invented.
 */

/** Canonical skill ids we track when present in the API. */
export const TRACKED_SKILLS = [
  'farming',
  'mining',
  'combat',
  'foraging',
  'fishing',
  'enchanting',
  'alchemy',
  'taming',
  'carpentry',
  'runecrafting',
  'social',
];

const SKILL_API_KEYS = {
  farming: ['SKILL_FARMING', 'experience_skill_farming'],
  mining: ['SKILL_MINING', 'experience_skill_mining'],
  combat: ['SKILL_COMBAT', 'experience_skill_combat'],
  foraging: ['SKILL_FORAGING', 'experience_skill_foraging'],
  fishing: ['SKILL_FISHING', 'experience_skill_fishing'],
  enchanting: ['SKILL_ENCHANTING', 'experience_skill_enchanting'],
  alchemy: ['SKILL_ALCHEMY', 'experience_skill_alchemy'],
  taming: ['SKILL_TAMING', 'experience_skill_taming'],
  carpentry: ['SKILL_CARPENTRY', 'experience_skill_carpentry'],
  runecrafting: ['SKILL_RUNECRAFTING', 'experience_skill_runecrafting'],
  social: ['SKILL_SOCIAL', 'experience_skill_social'],
};

/**
 * Extract skill XP map from a Hypixel SkyBlock member object.
 * @param {any} member
 * @returns {{ skills: Record<string, { xp: number }>, totalSkillXp: number|null, skillsAvailable: boolean }}
 */
export function extractHypixelSkills(member) {
  if (!member || typeof member !== 'object') {
    return { skills: {}, totalSkillXp: null, skillsAvailable: false };
  }

  const experience =
    (member.player_data && member.player_data.experience) ||
    member.experience ||
    {};

  /** @type {Record<string, { xp: number }>} */
  const skills = {};
  let total = 0;
  let found = 0;

  for (const skill of TRACKED_SKILLS) {
    const keys = SKILL_API_KEYS[skill] || [];
    let xp = null;
    for (const key of keys) {
      if (experience && experience[key] != null) {
        xp = Number(experience[key]);
        break;
      }
      if (member[key] != null) {
        xp = Number(member[key]);
        break;
      }
    }
    if (xp == null || !Number.isFinite(xp) || xp < 0) continue;
    const rounded = Math.round(xp);
    skills[skill] = { xp: rounded };
    total += rounded;
    found += 1;
  }

  if (found === 0) {
    return { skills: {}, totalSkillXp: null, skillsAvailable: false };
  }

  return { skills, totalSkillXp: total, skillsAvailable: true };
}

/**
 * Best-effort net worth extraction from SkyCrypt-style payloads.
 * Hypixel does not provide estimated net worth.
 * @param {any} data
 * @returns {{ netWorth: number|null, netWorthAvailable: boolean }}
 */
export function extractNetWorth(data) {
  if (!data || typeof data !== 'object') {
    return { netWorth: null, netWorthAvailable: false };
  }

  const candidates = [
    data.networth,
    data.netWorth,
    data.net_worth,
    data.networth?.networth,
    data.networth?.netWorth,
    data.netWorth?.total,
    data.networth?.total,
    data.profile?.networth,
    data.profile?.netWorth,
  ];

  for (const raw of candidates) {
    if (raw == null) continue;
    const n = typeof raw === 'object' ? Number(raw.networth ?? raw.netWorth ?? raw.total) : Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return { netWorth: Math.round(n), netWorthAvailable: true };
    }
  }

  return { netWorth: null, netWorthAvailable: false };
}

/**
 * Extract skills from SkyCrypt-style payloads when present.
 * @param {any} data
 */
export function extractSkyCryptSkills(data) {
  if (!data || typeof data !== 'object') {
    return { skills: {}, totalSkillXp: null, skillsAvailable: false };
  }

  const skillsRoot =
    data.skills ||
    data.profile?.skills ||
    data.raw?.skills ||
    null;

  /** @type {Record<string, { xp: number }>} */
  const skills = {};
  let total = 0;
  let found = 0;

  if (skillsRoot && typeof skillsRoot === 'object') {
    for (const skill of TRACKED_SKILLS) {
      const node = skillsRoot[skill] || skillsRoot[skill.toUpperCase()];
      if (!node || typeof node !== 'object') continue;
      const xp = Number(node.xp ?? node.experience ?? node.totalXp ?? node.total_xp);
      if (!Number.isFinite(xp) || xp < 0) continue;
      const rounded = Math.round(xp);
      skills[skill] = { xp: rounded };
      total += rounded;
      found += 1;
    }
  }

  if (found === 0) {
    // Fall back to Hypixel-shaped member blobs nested in SkyCrypt responses
    const member = data.raw || data.member || data.player_data;
    if (member) return extractHypixelSkills(member);
    return { skills: {}, totalSkillXp: null, skillsAvailable: false };
  }

  return { skills, totalSkillXp: total, skillsAvailable: true };
}

/**
 * Build a profile analytics payload from provider-specific pieces.
 * Independent of coin validity.
 * @param {{
 *   provider: string,
 *   player: string,
 *   profile: string,
 *   skills?: Record<string, { xp: number }>,
 *   totalSkillXp?: number|null,
 *   skillsAvailable?: boolean,
 *   netWorth?: number|null,
 *   netWorthAvailable?: boolean,
 *   fetchedAt?: string,
 *   profileId?: string|null,
 * }} partial
 */
export function buildAnalyticsPayload(partial) {
  const skillsAvailable = Boolean(partial.skillsAvailable);
  const netWorthAvailable = Boolean(partial.netWorthAvailable);
  const skills = skillsAvailable ? { ...(partial.skills || {}) } : {};
  const totalSkillXp =
    skillsAvailable && Number.isFinite(partial.totalSkillXp)
      ? Number(partial.totalSkillXp)
      : skillsAvailable
        ? sumSkillXp(skills)
        : null;
  const netWorth =
    netWorthAvailable && Number.isFinite(partial.netWorth) && partial.netWorth >= 0
      ? Math.round(Number(partial.netWorth))
      : null;

  if (!skillsAvailable && !netWorthAvailable) {
    return null;
  }

  return {
    provider: partial.provider,
    player: partial.player,
    profile: partial.profile,
    profileId: partial.profileId || null,
    skills,
    totalSkillXp,
    skillsAvailable,
    netWorth,
    netWorthAvailable,
    fetchedAt: partial.fetchedAt || new Date().toISOString(),
  };
}

/**
 * @param {Record<string, { xp: number }>} skills
 */
export function sumSkillXp(skills) {
  let total = 0;
  for (const skill of TRACKED_SKILLS) {
    const xp = skills?.[skill]?.xp;
    if (Number.isFinite(xp) && xp >= 0) total += xp;
  }
  return total;
}

/**
 * Normalize a stored snapshot (backwards compatible).
 * @param {any} raw
 */
export function normalizeProfileSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : null;
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;

  const skillsIn = raw.skills && typeof raw.skills === 'object' ? raw.skills : {};
  /** @type {Record<string, { xp: number }>} */
  const skills = {};
  for (const [key, val] of Object.entries(skillsIn)) {
    const xp = Number(val?.xp);
    if (!Number.isFinite(xp) || xp < 0) continue;
    skills[String(key).toLowerCase()] = { xp: Math.round(xp) };
  }

  let totalSkillXp =
    raw.totalSkillXp == null ? null : Number(raw.totalSkillXp);
  if (!Number.isFinite(totalSkillXp) || totalSkillXp < 0) {
    totalSkillXp = Object.keys(skills).length ? sumSkillXp(skills) : null;
  }

  let netWorth = raw.netWorth == null ? null : Number(raw.netWorth);
  if (!Number.isFinite(netWorth) || netWorth < 0) netWorth = null;

  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    timestamp,
    player: String(raw.player || ''),
    profile: String(raw.profile || ''),
    profileId: raw.profileId || null,
    netWorth,
    netWorthAvailable: netWorth != null ? true : Boolean(raw.netWorthAvailable),
    skills,
    totalSkillXp,
    skillsAvailable:
      Object.keys(skills).length > 0
        ? true
        : Boolean(raw.skillsAvailable),
    source: raw.source || raw.provider || null,
    provider: raw.provider || raw.source || null,
    fetchedAt: raw.fetchedAt || timestamp,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : undefined,
  };
}

/**
 * Fingerprint for duplicate detection (skills + net worth).
 * @param {any} snapshot
 */
export function snapshotFingerprint(snapshot) {
  const s = normalizeProfileSnapshot(snapshot) || snapshot;
  const skillParts = TRACKED_SKILLS.map((k) => {
    const xp = s?.skills?.[k]?.xp;
    return Number.isFinite(xp) ? `${k}:${xp}` : `${k}:-`;
  });
  const nw = Number.isFinite(s?.netWorth) ? String(s.netWorth) : 'null';
  return `${nw}|${skillParts.join(',')}`;
}

/**
 * @param {any} previous
 * @param {any} next
 * @param {{ minIntervalMs?: number, now?: number }} [opts]
 */
export function shouldSkipDuplicateSnapshot(previous, next, opts = {}) {
  if (!previous || !next) return false;
  const minIntervalMs = opts.minIntervalMs ?? 55 * 60 * 1000;
  const now =
    opts.now ??
    (Date.parse(next.timestamp || next.fetchedAt) || Date.now());
  const prevAt = Date.parse(previous.timestamp || previous.fetchedAt);
  if (!Number.isFinite(prevAt)) return false;
  if (now - prevAt > minIntervalMs) return false;
  return snapshotFingerprint(previous) === snapshotFingerprint(next);
}

/**
 * Per-skill and total XP deltas. Missing skills → change unavailable (null), not 0.
 * @param {any} previous
 * @param {any} current
 */
export function computeSkillChanges(previous, current) {
  const prev = normalizeProfileSnapshot(previous);
  const curr = normalizeProfileSnapshot(current);

  /** @type {Record<string, { xp: number|null, change: number|null, available: boolean }>} */
  const perSkill = {};
  let biggest = null;

  for (const skill of TRACKED_SKILLS) {
    const currXp = curr?.skills?.[skill]?.xp;
    const prevXp = prev?.skills?.[skill]?.xp;
    const currOk = Number.isFinite(currXp);
    const prevOk = Number.isFinite(prevXp);

    if (!currOk && !prevOk) {
      perSkill[skill] = { xp: null, change: null, available: false };
      continue;
    }
    if (!currOk || !prevOk) {
      perSkill[skill] = {
        xp: currOk ? currXp : null,
        change: null,
        available: currOk,
      };
      continue;
    }

    const change = currXp - prevXp;
    perSkill[skill] = { xp: currXp, change, available: true };
    if (!biggest || change > biggest.change) {
      biggest = { skill, change, xp: currXp };
    }
  }

  let totalChange = null;
  if (
    prev &&
    curr &&
    Number.isFinite(prev.totalSkillXp) &&
    Number.isFinite(curr.totalSkillXp)
  ) {
    totalChange = curr.totalSkillXp - prev.totalSkillXp;
  }

  return {
    perSkill,
    totalSkillXp: curr?.totalSkillXp ?? null,
    totalChange,
    biggestGain: biggest,
  };
}

/**
 * Net-worth absolute + percentage change. Missing → unavailable.
 * @param {any} previous
 * @param {any} current
 */
export function computeNetWorthChange(previous, current) {
  const prev = normalizeProfileSnapshot(previous);
  const curr = normalizeProfileSnapshot(current);
  const currNw = curr?.netWorth;
  const prevNw = prev?.netWorth;

  if (!Number.isFinite(currNw)) {
    return {
      netWorth: null,
      available: false,
      change: null,
      percentChange: null,
    };
  }

  if (!Number.isFinite(prevNw)) {
    return {
      netWorth: currNw,
      available: true,
      change: null,
      percentChange: null,
    };
  }

  const change = currNw - prevNw;
  const percentChange = prevNw === 0 ? null : (change / prevNw) * 100;
  return {
    netWorth: currNw,
    available: true,
    change,
    percentChange,
  };
}

/**
 * Build a progress summary for the dashboard from snapshot history.
 * @param {any[]} snapshots newest-last or unsorted
 */
export function buildProfileProgressSummary(snapshots) {
  const list = (snapshots || [])
    .map(normalizeProfileSnapshot)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const current = list.length ? list[list.length - 1] : null;
  const previous = list.length > 1 ? list[list.length - 2] : null;

  const skillChanges = computeSkillChanges(previous, current);
  const netWorth = computeNetWorthChange(previous, current);

  return {
    current,
    previous,
    netWorth,
    skills: skillChanges,
    lastUpdated: current?.fetchedAt || current?.timestamp || null,
    source: current?.provider || current?.source || null,
    snapshotCount: list.length,
  };
}

/**
 * Build analytics from a Hypixel member + profile meta.
 * @param {any} member
 * @param {{ provider?: string, player: string, profile: string, profileId?: string|null, fetchedAt?: string }} meta
 */
export function analyticsFromHypixelMember(member, meta) {
  const skills = extractHypixelSkills(member);
  return buildAnalyticsPayload({
    provider: meta.provider || 'hypixel',
    player: meta.player,
    profile: meta.profile,
    profileId: meta.profileId || null,
    skills: skills.skills,
    totalSkillXp: skills.totalSkillXp,
    skillsAvailable: skills.skillsAvailable,
    netWorth: null,
    netWorthAvailable: false,
    fetchedAt: meta.fetchedAt,
  });
}

/**
 * Build analytics from a SkyCrypt stats payload.
 * @param {any} data
 * @param {{ player: string, profile: string, fetchedAt?: string }} meta
 */
export function analyticsFromSkyCryptPayload(data, meta) {
  const skills = extractSkyCryptSkills(data);
  const nw = extractNetWorth(data);
  return buildAnalyticsPayload({
    provider: 'skycrypt',
    player: meta.player,
    profile: meta.profile,
    skills: skills.skills,
    totalSkillXp: skills.totalSkillXp,
    skillsAvailable: skills.skillsAvailable,
    netWorth: nw.netWorth,
    netWorthAvailable: nw.netWorthAvailable,
    fetchedAt: meta.fetchedAt,
  });
}

/**
 * Validate configured player/profile against analytics payload.
 * @param {any} analytics
 * @param {{ player: string, profile: string }} expected
 */
export function assertAnalyticsIdentity(analytics, expected) {
  if (!analytics) return { ok: false, reason: 'missing' };
  if (
    analytics.player &&
    String(analytics.player).toLowerCase() !== String(expected.player).toLowerCase()
  ) {
    return { ok: false, reason: 'wrong_player' };
  }
  if (
    analytics.profile &&
    String(analytics.profile).toLowerCase() !== String(expected.profile).toLowerCase()
  ) {
    return { ok: false, reason: 'wrong_profile' };
  }
  return { ok: true };
}
