/**
 * Input validation for coin entries and imports.
 */

const MAX_ENTRIES = 50000;

/**
 * @param {unknown} body
 * @returns {{ ok: true, coins: number, timestamp: string } | { ok: false, error: string }}
 */
export function validateEntryInput(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid request body' };
  }

  const coinsResult = validateCoins(body.coins);
  if (!coinsResult.ok) return coinsResult;

  let timestamp = body.timestamp;
  if (timestamp == null || timestamp === '') {
    timestamp = new Date().toISOString();
  }
  if (typeof timestamp !== 'string') {
    return { ok: false, error: 'Timestamp must be a string' };
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return { ok: false, error: 'Invalid timestamp' };
  }
  // Reject absurdly far future (> 1 day) or pre-2000
  if (ms > Date.now() + 86400000) {
    return { ok: false, error: 'Timestamp is too far in the future' };
  }
  if (ms < Date.parse('2000-01-01T00:00:00Z')) {
    return { ok: false, error: 'Timestamp is too far in the past' };
  }

  return {
    ok: true,
    coins: coinsResult.coins,
    timestamp: new Date(ms).toISOString(),
  };
}

/**
 * @param {unknown} value
 */
export function validateCoins(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    value = Number(value.replace(/,/g, ''));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: 'Coins must be a number' };
  }
  if (!Number.isInteger(value)) {
    if (!Number.isInteger(Math.round(value))) {
      return { ok: false, error: 'Coins must be an integer' };
    }
    value = Math.round(value);
  }
  if (value < 0) {
    return { ok: false, error: 'Coins must be >= 0' };
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: 'Coins value is too large' };
  }
  return { ok: true, coins: value };
}

/**
 * @param {unknown} body
 */
export function validateImportPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid import payload' };
  }
  if (!Array.isArray(body.entries)) {
    return { ok: false, error: 'entries must be an array' };
  }
  if (body.entries.length > MAX_ENTRIES) {
    return { ok: false, error: `Too many entries (max ${MAX_ENTRIES})` };
  }

  const entries = [];
  for (let i = 0; i < body.entries.length; i++) {
    const e = body.entries[i];
    const coinsResult = validateCoins(e?.coins);
    if (!coinsResult.ok) {
      return { ok: false, error: `Entry ${i}: ${coinsResult.error}` };
    }
    if (typeof e?.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) {
      return { ok: false, error: `Entry ${i}: invalid timestamp` };
    }
    const id =
      typeof e.id === 'string' && e.id.length > 0 && e.id.length < 80
        ? e.id
        : crypto.randomUUID();
    entries.push({
      id,
      coins: coinsResult.coins,
      timestamp: new Date(e.timestamp).toISOString(),
    });
  }

  return {
    ok: true,
    version: Number(body.version) > 0 ? Number(body.version) : 1,
    entries,
  };
}

/**
 * Ensure database shape is safe. Never invent empty DB on corrupt partial reads.
 * @param {unknown} data
 */
export function normalizeDatabase(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Malformed data file: expected object');
  }
  if (!Array.isArray(data.entries)) {
    throw new Error('Malformed data file: missing entries array');
  }
  const entries = [];
  for (const e of data.entries) {
    const coins = Number(e?.coins);
    if (!Number.isFinite(coins) || coins < 0 || !Number.isSafeInteger(coins)) continue;
    if (typeof e?.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) continue;
    entries.push({
      id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
      coins,
      timestamp: new Date(e.timestamp).toISOString(),
    });
  }
  return {
    version: Number(data.version) > 0 ? Number(data.version) : 1,
    entries,
  };
}

export function newEntryId() {
  return crypto.randomUUID();
}

/**
 * Compact coin label for commit messages.
 * @param {number} coins
 */
export function compactCoins(coins) {
  const abs = Math.abs(coins);
  const sign = coins < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2).replace(/\.?0+$/, '')}K`;
  return `${sign}${abs}`;
}

export function formatCommitDate(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}
