import { describe, it, expect } from 'vitest';
import {
  evaluateAutoEligibility,
  findLastManualAt,
  findLastAutoAt,
  isAutoSource,
  isManualSource,
} from './automation.js';
import { parseSkyCryptStatsPayload } from './skycrypt.js';
import { parseHypixelProfilesPayload } from './hypixel.js';

const HOUR = 3600000;

describe('source helpers', () => {
  it('treats missing source as manual', () => {
    expect(isManualSource({ timestamp: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isAutoSource({ source: 'manual' })).toBe(false);
    expect(isAutoSource({ source: 'auto-skycrypt' })).toBe(true);
  });
});

describe('findLastManualAt / findLastAutoAt', () => {
  const entries = [
    { id: '1', coins: 1, timestamp: '2026-08-10T00:00:00.000Z' },
    {
      id: '2',
      coins: 2,
      timestamp: '2026-08-11T00:00:00.000Z',
      source: 'auto-skycrypt',
    },
    {
      id: '3',
      coins: 3,
      timestamp: '2026-08-12T12:00:00.000Z',
      source: 'manual',
    },
    {
      id: '4',
      coins: 4,
      timestamp: '2026-08-13T00:00:00.000Z',
      source: 'auto-hypixel',
    },
  ];

  it('ignores auto when finding manual', () => {
    expect(findLastManualAt(entries)).toBe(Date.parse('2026-08-12T12:00:00.000Z'));
  });

  it('finds latest auto', () => {
    expect(findLastAutoAt(entries)).toBe(Date.parse('2026-08-13T00:00:00.000Z'));
  });
});

describe('evaluateAutoEligibility', () => {
  const base = {
    enabled: true,
    inactivityMs: 24 * HOUR,
    minIntervalMs: 24 * HOUR,
    lastManualAt: null,
    lastAutoAt: null,
    suppressAutoUntil: null,
  };

  it('blocks when disabled', () => {
    expect(
      evaluateAutoEligibility({ ...base, now: Date.now(), enabled: false }).eligible
    ).toBe(false);
  });

  it('manual entry less than 24h ago → not eligible', () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: now - 18 * HOUR,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('manual_recent');
  });

  it('manual entry over 24h ago → eligible', () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: now - 24 * HOUR,
    });
    expect(r.eligible).toBe(true);
  });

  it('auto entry less than 24h ago → no duplicate', () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: now - 48 * HOUR,
      lastAutoAt: now - 6 * HOUR,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('auto_recent');
  });

  it('manual after auto resets the timer', () => {
    const now = Date.parse('2026-08-15T14:00:00.000Z');
    // Manual Friday 2pm, previous auto Thursday — not eligible until Saturday 2pm
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: Date.parse('2026-08-15T14:00:00.000Z'),
      lastAutoAt: Date.parse('2026-08-14T20:00:00.000Z'),
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('manual_recent');
  });

  it('several days inactive → eligible once interval clears', () => {
    const now = Date.parse('2026-08-14T20:00:00.000Z');
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: Date.parse('2026-08-11T20:00:00.000Z'),
      lastAutoAt: Date.parse('2026-08-13T20:00:00.000Z'),
    });
    expect(r.eligible).toBe(true);
  });

  it('suppress after delete blocks immediate recreate', () => {
    const now = Date.now();
    const r = evaluateAutoEligibility({
      ...base,
      now,
      lastManualAt: now - 48 * HOUR,
      suppressAutoUntil: now + HOUR,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('suppressed_after_delete');
  });
});

describe('parseSkyCryptStatsPayload', () => {
  const good = {
    username: 'justiwantdreams',
    profile_cute_name: 'Raspberry',
    purse: 1000,
    bank: 500,
    personalBank: 50,
  };

  it('sums purse + bank + personalBank', () => {
    const r = parseSkyCryptStatsPayload(good, {
      player: 'justiwantdreams',
      profile: 'Raspberry',
    });
    expect(r.coins).toBe(1550);
    expect(r.provider).toBe('skycrypt');
  });

  it('rejects wrong player', () => {
    expect(() =>
      parseSkyCryptStatsPayload(
        { ...good, username: 'someoneelse' },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      )
    ).toThrow(/unexpected player/i);
  });

  it('rejects wrong profile', () => {
    expect(() =>
      parseSkyCryptStatsPayload(
        { ...good, profile_cute_name: 'Banana' },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      )
    ).toThrow(/unexpected profile/i);
  });

  it('rejects missing bank', () => {
    expect(() =>
      parseSkyCryptStatsPayload(
        { username: 'justiwantdreams', profile_cute_name: 'Raspberry', purse: 1 },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      )
    ).toThrow(/Missing bank/i);
  });

  it('rejects invalid balance', () => {
    expect(() =>
      parseSkyCryptStatsPayload(
        { ...good, purse: -1 },
        { player: 'justiwantdreams', profile: 'Raspberry' }
      )
    ).toThrow(/Invalid purse/i);
  });
});

describe('parseHypixelProfilesPayload', () => {
  const uuid = '82f8e698500d46c792ee93cd1ca7ad7a';
  const good = {
    success: true,
    profiles: [
      {
        profile_id: 'abc',
        cute_name: 'Raspberry',
        banking: { balance: 2_000_000 },
        members: {
          [uuid]: {
            coin_purse: 1_000_000,
            profile: { bank_account: 100_000 },
          },
        },
      },
      {
        cute_name: 'Other',
        banking: { balance: 1 },
        members: { [uuid]: { coin_purse: 1 } },
      },
    ],
  };

  it('selects Raspberry and sums liquid coins', () => {
    const r = parseHypixelProfilesPayload(good, {
      player: 'justiwantdreams',
      profile: 'Raspberry',
      uuid,
    });
    expect(r.coins).toBe(3_100_000);
    expect(r.profileCuteName).toBe('Raspberry');
  });

  it('rejects wrong profile', () => {
    expect(() =>
      parseHypixelProfilesPayload(good, {
        player: 'justiwantdreams',
        profile: 'NotAProfile',
        uuid,
      })
    ).toThrow(/not found/i);
  });

  it('treats missing bank API as zero with flag', () => {
    const noBank = {
      success: true,
      profiles: [
        {
          cute_name: 'Raspberry',
          members: { [uuid]: { coin_purse: 10 } },
        },
      ],
    };
    const r = parseHypixelProfilesPayload(noBank, {
      player: 'justiwantdreams',
      profile: 'Raspberry',
      uuid,
    });
    expect(r.coins).toBe(10);
    expect(r.bank).toBe(0);
    expect(r.bankApiUnavailable).toBe(true);
  });

  it('rejects missing member', () => {
    const bad = {
      success: true,
      profiles: [
        {
          cute_name: 'Raspberry',
          banking: { balance: 1 },
          members: { someoneelse: { coin_purse: 1 } },
        },
      ],
    };
    expect(() =>
      parseHypixelProfilesPayload(bad, {
        player: 'justiwantdreams',
        profile: 'Raspberry',
        uuid,
      })
    ).toThrow(/member data missing/i);
  });
});
