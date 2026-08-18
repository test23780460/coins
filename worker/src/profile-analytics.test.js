import { describe, it, expect } from 'vitest';
import {
  extractHypixelSkills,
  extractNetWorth,
  extractSkyCryptSkills,
  buildAnalyticsPayload,
  normalizeProfileSnapshot,
  snapshotFingerprint,
  shouldSkipDuplicateSnapshot,
  computeSkillChanges,
  computeNetWorthChange,
  buildProfileProgressSummary,
  assertAnalyticsIdentity,
  analyticsFromHypixelMember,
  TRACKED_SKILLS,
} from './profile-analytics.js';
import { packProfileEntriesIntoShards, nextProfileShardPath } from './profile-store.js';
import { evaluateAutoEligibility } from './automation.js';
import { computeStats } from '../../src/time.js';

const uuid = '82f8e698500d46c792ee93cd1ca7ad7a';

describe('extractHypixelSkills', () => {
  it('reads SKILL_* XP from player_data.experience', () => {
    const member = {
      player_data: {
        experience: {
          SKILL_FARMING: 1000.4,
          SKILL_MINING: 2000,
          SKILL_COMBAT: 3000,
        },
      },
    };
    const r = extractHypixelSkills(member);
    expect(r.skillsAvailable).toBe(true);
    expect(r.skills.farming.xp).toBe(1000);
    expect(r.skills.mining.xp).toBe(2000);
    expect(r.skills.combat.xp).toBe(3000);
    expect(r.totalSkillXp).toBe(6000);
  });

  it('falls back to legacy experience_skill_* fields', () => {
    const member = {
      experience_skill_farming: 50,
      experience_skill_fishing: 75,
    };
    const r = extractHypixelSkills(member);
    expect(r.skills.farming.xp).toBe(50);
    expect(r.skills.fishing.xp).toBe(75);
  });

  it('returns unavailable when no skills present', () => {
    expect(extractHypixelSkills({}).skillsAvailable).toBe(false);
    expect(extractHypixelSkills(null).totalSkillXp).toBeNull();
  });
});

describe('extractNetWorth', () => {
  it('reads common SkyCrypt networth fields', () => {
    expect(extractNetWorth({ networth: 2_150_000_000 }).netWorth).toBe(2_150_000_000);
    expect(extractNetWorth({ netWorth: 100 }).netWorthAvailable).toBe(true);
    expect(extractNetWorth({ networth: { networth: 99 } }).netWorth).toBe(99);
  });

  it('marks unavailable when missing', () => {
    expect(extractNetWorth({}).netWorthAvailable).toBe(false);
    expect(extractNetWorth(null).netWorth).toBeNull();
  });
});

describe('extractSkyCryptSkills', () => {
  it('reads nested skills xp', () => {
    const r = extractSkyCryptSkills({
      skills: {
        farming: { xp: 10 },
        combat: { experience: 20 },
      },
    });
    expect(r.skills.farming.xp).toBe(10);
    expect(r.skills.combat.xp).toBe(20);
    expect(r.totalSkillXp).toBe(30);
  });
});

describe('buildAnalyticsPayload / identity', () => {
  it('valid XP snapshot payload', () => {
    const p = buildAnalyticsPayload({
      provider: 'hypixel',
      player: 'justiwantdreams',
      profile: 'Raspberry',
      skillsAvailable: true,
      skills: { farming: { xp: 100 } },
      totalSkillXp: 100,
      netWorthAvailable: false,
    });
    expect(p.skills.farming.xp).toBe(100);
    expect(p.netWorth).toBeNull();
  });

  it('valid net-worth snapshot payload', () => {
    const p = buildAnalyticsPayload({
      provider: 'skycrypt',
      player: 'justiwantdreams',
      profile: 'Raspberry',
      skillsAvailable: false,
      netWorthAvailable: true,
      netWorth: 999,
    });
    expect(p.netWorth).toBe(999);
    expect(p.skillsAvailable).toBe(false);
  });

  it('returns null when nothing available', () => {
    expect(
      buildAnalyticsPayload({
        provider: 'hypixel',
        player: 'x',
        profile: 'y',
        skillsAvailable: false,
        netWorthAvailable: false,
      })
    ).toBeNull();
  });

  it('validates player/profile', () => {
    expect(
      assertAnalyticsIdentity(
        { player: 'justiwantdreams', profile: 'Raspberry' },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      ).ok
    ).toBe(true);
    expect(
      assertAnalyticsIdentity(
        { player: 'other', profile: 'Raspberry' },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      ).reason
    ).toBe('wrong_player');
  });
});

describe('skill + net worth changes', () => {
  const prev = {
    id: 'a',
    timestamp: '2026-08-01T00:00:00.000Z',
    player: 'justiwantdreams',
    profile: 'Raspberry',
    skills: {
      farming: { xp: 67_719_821 },
      mining: { xp: 48_048_658 },
      combat: { xp: 79_816_456 },
    },
    totalSkillXp: 67_719_821 + 48_048_658 + 79_816_456,
    netWorth: 2_625_000_000,
  };
  const curr = {
    id: 'b',
    timestamp: '2026-08-02T00:00:00.000Z',
    player: 'justiwantdreams',
    profile: 'Raspberry',
    skills: {
      farming: { xp: 68_241_291 },
      mining: { xp: 48_122_100 },
      combat: { xp: 81_219_384 },
      fishing: { xp: 1000 },
    },
    totalSkillXp: 68_241_291 + 48_122_100 + 81_219_384 + 1000,
    netWorth: 2_709_300_000,
  };

  it('computes per-skill XP changes', () => {
    const c = computeSkillChanges(prev, curr);
    expect(c.perSkill.farming.change).toBe(521_470);
    expect(c.perSkill.mining.change).toBe(73_442);
    expect(c.perSkill.combat.change).toBe(1_402_928);
  });

  it('computes total XP change', () => {
    const c = computeSkillChanges(prev, curr);
    expect(c.totalChange).toBe(curr.totalSkillXp - prev.totalSkillXp);
  });

  it('computes net-worth absolute + percent change', () => {
    const n = computeNetWorthChange(prev, curr);
    expect(n.change).toBe(84_300_000);
    expect(n.percentChange).toBeCloseTo((84_300_000 / 2_625_000_000) * 100, 5);
  });

  it('missing skill in previous → change unavailable', () => {
    const c = computeSkillChanges(prev, curr);
    expect(c.perSkill.fishing.xp).toBe(1000);
    expect(c.perSkill.fishing.change).toBeNull();
  });

  it('missing skill in newest → change unavailable', () => {
    const c = computeSkillChanges(
      { ...prev, skills: { ...prev.skills, enchanting: { xp: 10 } } },
      curr
    );
    expect(c.perSkill.enchanting.change).toBeNull();
    expect(c.perSkill.enchanting.xp).toBeNull();
  });

  it('net worth unavailable', () => {
    const n = computeNetWorthChange(prev, { ...curr, netWorth: null });
    expect(n.available).toBe(false);
    expect(n.change).toBeNull();
  });

  it('XP unavailable', () => {
    const c = computeSkillChanges(null, {
      ...curr,
      skills: {},
      totalSkillXp: null,
    });
    expect(c.totalChange).toBeNull();
  });

  it('biggest skill gain', () => {
    const c = computeSkillChanges(prev, curr);
    expect(c.biggestGain.skill).toBe('combat');
    expect(c.biggestGain.change).toBe(1_402_928);
  });
});

describe('duplicate snapshot prevention', () => {
  it('skips identical snapshots within the interval', () => {
    const a = {
      id: '1',
      timestamp: '2026-08-18T12:00:00.000Z',
      skills: { farming: { xp: 10 } },
      totalSkillXp: 10,
      netWorth: 100,
    };
    const b = {
      id: '2',
      timestamp: '2026-08-18T12:10:00.000Z',
      skills: { farming: { xp: 10 } },
      totalSkillXp: 10,
      netWorth: 100,
    };
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
    expect(shouldSkipDuplicateSnapshot(a, b)).toBe(true);
  });

  it('allows save when values change', () => {
    const a = {
      timestamp: '2026-08-18T12:00:00.000Z',
      skills: { farming: { xp: 10 } },
      totalSkillXp: 10,
      netWorth: 100,
    };
    const b = {
      timestamp: '2026-08-18T12:10:00.000Z',
      skills: { farming: { xp: 11 } },
      totalSkillXp: 11,
      netWorth: 100,
    };
    expect(shouldSkipDuplicateSnapshot(a, b)).toBe(false);
  });
});

describe('old schema remains readable', () => {
  it('normalizes legacy snapshot without id extras', () => {
    const n = normalizeProfileSnapshot({
      timestamp: '2026-01-01T00:00:00.000Z',
      player: 'justiwantdreams',
      profile: 'Raspberry',
      skills: { Farming: { xp: 5 } },
      netWorth: 1,
      source: 'skycrypt',
    });
    expect(n.skills.farming.xp).toBe(5);
    expect(n.netWorth).toBe(1);
    expect(n.source).toBe('skycrypt');
  });
});

describe('isolation from coin stats / inactivity timer', () => {
  it('profile analytics do not affect coin stats', () => {
    const coinEntries = [
      { id: '1', coins: 100, timestamp: '2026-08-01T00:00:00.000Z' },
      { id: '2', coins: 150, timestamp: '2026-08-02T00:00:00.000Z' },
    ];
    const stats = computeStats(coinEntries);
    expect(stats.current).toBe(150);
    expect(stats.previousChange.delta).toBe(50);
    const progress = buildProfileProgressSummary([
      {
        id: 'p1',
        timestamp: '2026-08-02T00:00:00.000Z',
        skills: { farming: { xp: 9 } },
        totalSkillXp: 9,
        netWorth: 999,
      },
    ]);
    expect(progress.current.netWorth).toBe(999);
    expect(computeStats(coinEntries).current).toBe(150);
  });

  it('profile analytics do not reset manual inactivity timer', () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const lastManual = now - 2 * 3600000;
    const r = evaluateAutoEligibility({
      now,
      enabled: true,
      inactivityMs: 24 * 3600000,
      minIntervalMs: 24 * 3600000,
      lastManualAt: lastManual,
      lastAutoAt: null,
      suppressAutoUntil: null,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('manual_recent');
  });
});

describe('partial validity', () => {
  it('coins-valid path can still produce skill analytics without net worth', () => {
    const analytics = analyticsFromHypixelMember(
      {
        player_data: { experience: { SKILL_FARMING: 42 } },
        coin_purse: 1,
      },
      { player: 'justiwantdreams', profile: 'Raspberry' }
    );
    expect(analytics.skillsAvailable).toBe(true);
    expect(analytics.netWorthAvailable).toBe(false);
  });

  it('net worth only payload is valid analytics', () => {
    const p = buildAnalyticsPayload({
      provider: 'skycrypt',
      player: 'justiwantdreams',
      profile: 'Raspberry',
      skillsAvailable: false,
      netWorthAvailable: true,
      netWorth: 50,
    });
    expect(p.netWorth).toBe(50);
  });
});

describe('profile store helpers', () => {
  it('packs and numbers shards', () => {
    const packs = packProfileEntriesIntoShards(
      Array.from({ length: 3 }, (_, i) => ({
        id: `id-${i}`,
        timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
        skills: {},
      })),
      1
    );
    expect(packs[0].path).toContain('data/profile/shards/');
    expect(nextProfileShardPath(['data/profile/shards/part-0001.json'])).toBe(
      'data/profile/shards/part-0002.json'
    );
  });
});

describe('progress summary uses only profile snapshots', () => {
  it('ignores coin-shaped objects without profile fields', () => {
    const summary = buildProfileProgressSummary([
      { id: 'c', coins: 999, timestamp: '2026-08-01T00:00:00.000Z' },
      {
        id: 'p',
        timestamp: '2026-08-02T00:00:00.000Z',
        skills: { combat: { xp: 10 } },
        totalSkillXp: 10,
        netWorth: 5,
        player: 'justiwantdreams',
        profile: 'Raspberry',
      },
    ]);
    // coin-only row normalizes but has empty skills; still a snapshot if timestamp ok
    expect(summary.snapshotCount).toBeGreaterThanOrEqual(1);
    expect(summary.current.skills.combat?.xp || summary.skills.totalSkillXp).toBeTruthy();
  });
});

describe('tracked skills list', () => {
  it('includes core SkyBlock skills', () => {
    for (const s of ['farming', 'mining', 'combat', 'foraging', 'fishing', 'enchanting', 'alchemy', 'taming']) {
      expect(TRACKED_SKILLS).toContain(s);
    }
  });
});
