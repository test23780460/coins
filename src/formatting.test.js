import { describe, it, expect } from 'vitest';
import {
  formatCompact,
  formatExact,
  formatDelta,
  formatPercent,
  parseCoinInput,
  computeChange,
  changeTone,
} from './formatting.js';

describe('formatCompact', () => {
  it('formats small numbers exactly', () => {
    expect(formatCompact(999)).toBe('999');
  });
  it('formats K/M/B/T', () => {
    expect(formatCompact(1500)).toBe('1.5K');
    expect(formatCompact(1500000)).toBe('1.5M');
    expect(formatCompact(1250000000)).toBe('1.25B');
    expect(formatCompact(1250000000000)).toBe('1.25T');
  });
});

describe('formatExact', () => {
  it('adds commas', () => {
    expect(formatExact(1250000000)).toBe('1,250,000,000');
  });
});

describe('formatDelta / formatPercent', () => {
  it('prefixes signs', () => {
    expect(formatDelta(52400000)).toBe('+52.4M');
    expect(formatDelta(-1000)).toBe('-1K');
    expect(formatDelta(0)).toBe('0');
    expect(formatPercent(4.37)).toBe('+4.37%');
    expect(formatPercent(-2.5)).toBe('-2.50%');
  });
});

describe('parseCoinInput', () => {
  it('parses plain, commas, and suffixes', () => {
    expect(parseCoinInput('1250000000').value).toBe(1250000000);
    expect(parseCoinInput('1,250,000,000').value).toBe(1250000000);
    expect(parseCoinInput('1.25b').value).toBe(1250000000);
    expect(parseCoinInput('1.25B').value).toBe(1250000000);
    expect(parseCoinInput('850m').value).toBe(850000000);
    expect(parseCoinInput('850M').value).toBe(850000000);
    expect(parseCoinInput('750k').value).toBe(750000);
    expect(parseCoinInput('2.43b').value).toBe(2430000000);
  });
  it('rejects invalid', () => {
    expect(parseCoinInput('').ok).toBe(false);
    expect(parseCoinInput('abc').ok).toBe(false);
    expect(parseCoinInput('-1').ok).toBe(false);
  });
});

describe('computeChange / changeTone', () => {
  it('computes deltas', () => {
    expect(computeChange(110, 100)).toEqual({ delta: 10, percent: 10 });
    expect(computeChange(100, 100)).toEqual({ delta: 0, percent: 0 });
    expect(computeChange(90, 100)).toEqual({ delta: -10, percent: -10 });
    expect(computeChange(100, null).delta).toBeNull();
  });
  it('tones', () => {
    expect(changeTone(1)).toBe('positive');
    expect(changeTone(-1)).toBe('negative');
    expect(changeTone(0)).toBe('neutral');
  });
});
