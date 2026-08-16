import { describe, it, expect } from 'vitest';
import { computeStats, withChanges, filterByRange, sortChronological } from './time.js';
import { toCsv, validateImport, toJsonBackup } from './export.js';

const sample = [
  { id: '1', coins: 1000000000, timestamp: '2026-08-01T12:00:00.000Z' },
  { id: '2', coins: 1100000000, timestamp: '2026-08-10T12:00:00.000Z' },
  { id: '3', coins: 1050000000, timestamp: '2026-08-13T12:00:00.000Z' },
  { id: '4', coins: 1050000000, timestamp: '2026-08-13T18:00:00.000Z' },
];

describe('withChanges', () => {
  it('allows multiple same-day entries and computes deltas', () => {
    const rows = withChanges(sample);
    expect(rows[0].id).toBe('4');
    expect(rows[0].delta).toBe(0);
    expect(rows[1].delta).toBe(-50000000);
    expect(rows[2].delta).toBe(100000000);
  });
});

describe('computeStats', () => {
  it('computes all-time and previous', () => {
    const s = computeStats(sample);
    expect(s.current).toBe(1050000000);
    expect(s.previousChange.delta).toBe(0);
    expect(s.allTime.delta).toBe(50000000);
  });
});

describe('filterByRange', () => {
  it('filters without mutating', () => {
    const before = sample.length;
    const f = filterByRange(sample, '7D');
    expect(sample.length).toBe(before);
    expect(f.length).toBeGreaterThan(0);
    expect(filterByRange(sample, 'ALL')).toHaveLength(4);
  });
});

describe('export', () => {
  it('builds CSV with headers', () => {
    const csv = toCsv(sample);
    expect(csv.startsWith('Date,Time,Timestamp,Total Coins,Gain/Loss,Percentage Change,Note,Source')).toBe(
      true
    );
    expect(csv.split('\n').length).toBeGreaterThan(4);
  });
  it('validates import', () => {
    const backup = JSON.parse(toJsonBackup({ version: 1, entries: sample }));
    const r = validateImport(backup);
    expect(r.ok).toBe(true);
    expect(r.entryCount).toBe(4);
  });
  it('sorts chronological', () => {
    const s = sortChronological([{ timestamp: '2026-08-13T00:00:00Z' }, { timestamp: '2026-08-01T00:00:00Z' }]);
    expect(s[0].timestamp).toContain('08-01');
  });
});
