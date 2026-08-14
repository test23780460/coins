import { describe, it, expect } from 'vitest';
import {
  packEntriesIntoShards,
  nextShardPath,
  SHARD_SOFT_LIMIT_BYTES,
  SHARD_DIR,
} from './store.js';
import { jsonByteSize } from './github.js';

function makeEntries(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    coins: 1_000_000_000 + i,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

describe('nextShardPath', () => {
  it('increments from existing parts', () => {
    expect(nextShardPath([])).toBe(`${SHARD_DIR}/part-0001.json`);
    expect(nextShardPath([`${SHARD_DIR}/part-0001.json`])).toBe(
      `${SHARD_DIR}/part-0002.json`
    );
    expect(
      nextShardPath([`${SHARD_DIR}/part-0001.json`, `${SHARD_DIR}/part-0009.json`])
    ).toBe(`${SHARD_DIR}/part-0010.json`);
  });
});

describe('packEntriesIntoShards', () => {
  it('keeps small datasets in one shard', () => {
    const packs = packEntriesIntoShards(makeEntries(5), 1);
    expect(packs).toHaveLength(1);
    expect(packs[0].data.entries).toHaveLength(5);
    expect(jsonByteSize(packs[0].data)).toBeLessThan(SHARD_SOFT_LIMIT_BYTES);
  });

  it('splits when approaching soft limit', () => {
    // Roughly pad entries until packing needs multiple shards
    const big = makeEntries(1).map((e) => ({
      ...e,
      // inflate payload so fewer entries fill a shard
      note: 'x'.repeat(50_000),
    }));
    // Build many fat entries
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `fat-${i}`,
      coins: i,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      note: 'x'.repeat(40_000),
    }));
    const packs = packEntriesIntoShards(entries, 1);
    expect(packs.length).toBeGreaterThan(1);
    for (const pack of packs) {
      expect(jsonByteSize(pack.data)).toBeLessThanOrEqual(SHARD_SOFT_LIMIT_BYTES + 50_000);
      // soft limit check on packing uses >= so each pack except possibly last should be under limit when built incrementally
      expect(jsonByteSize(pack.data)).toBeLessThan(1_000_000);
    }
    const total = packs.reduce((n, p) => n + p.data.entries.length, 0);
    expect(total).toBe(entries.length);
    void big;
  });

  it('creates empty shard for empty history', () => {
    const packs = packEntriesIntoShards([], 1);
    expect(packs).toHaveLength(1);
    expect(packs[0].data.entries).toEqual([]);
  });
});
