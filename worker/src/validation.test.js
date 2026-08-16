import { describe, it, expect } from 'vitest';
import {
  validateEntryInput,
  validateCoins,
  validateImportPayload,
  normalizeDatabase,
  compactCoins,
} from '../../worker/src/validation.js';

describe('validateCoins', () => {
  it('accepts integers', () => {
    expect(validateCoins(0).ok).toBe(true);
    expect(validateCoins(1250000000).coins).toBe(1250000000);
  });
  it('rejects negatives and non-numbers', () => {
    expect(validateCoins(-1).ok).toBe(false);
    expect(validateCoins('abc').ok).toBe(false);
  });
});

describe('validateEntryInput', () => {
  it('defaults timestamp', () => {
    const r = validateEntryInput({ coins: 100 });
    expect(r.ok).toBe(true);
    expect(r.timestamp).toBeTruthy();
  });
  it('rejects bad timestamp', () => {
    expect(validateEntryInput({ coins: 1, timestamp: 'nope' }).ok).toBe(false);
  });
  it('accepts optional notes', () => {
    const r = validateEntryInput({ coins: 10, note: '  sold weapon  ' });
    expect(r.ok).toBe(true);
    expect(r.note).toBe('sold weapon');
  });
  it('rejects oversized notes', () => {
    expect(validateEntryInput({ coins: 1, note: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('validateImportPayload / normalizeDatabase', () => {
  it('imports valid entries', () => {
    const r = validateImportPayload({
      version: 1,
      entries: [{ coins: 10, timestamp: '2026-08-13T06:00:00.000Z' }],
    });
    expect(r.ok).toBe(true);
    expect(r.entries).toHaveLength(1);
  });
  it('normalizes database', () => {
    const db = normalizeDatabase({
      version: 1,
      entries: [
        { id: 'a', coins: 10, timestamp: '2026-08-13T06:00:00.000Z' },
        { coins: -5, timestamp: '2026-08-13T06:00:00.000Z' },
      ],
    });
    expect(db.entries).toHaveLength(1);
  });
  it('throws on malformed', () => {
    expect(() => normalizeDatabase(null)).toThrow();
    expect(() => normalizeDatabase({})).toThrow();
  });
});

describe('compactCoins', () => {
  it('abbreviates', () => {
    expect(compactCoins(1250000000)).toBe('1.25B');
    expect(compactCoins(850000000)).toBe('850M');
  });
});
