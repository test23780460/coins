/**
 * Number formatting & coin-balance parsing utilities.
 */

const SUFFIXES = [
  { value: 1e12, symbol: 'T' },
  { value: 1e9, symbol: 'B' },
  { value: 1e6, symbol: 'M' },
  { value: 1e3, symbol: 'K' },
];

/**
 * Format a coin amount with K/M/B/T abbreviation.
 * @param {number|bigint|string} value
 * @param {{ digits?: number }} [opts]
 * @returns {string}
 */
export function formatCompact(value, opts = {}) {
  const digits = opts.digits ?? 2;
  const n = toSafeNumber(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) {
    return formatExact(n);
  }
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  for (const { value: div, symbol } of SUFFIXES) {
    if (abs >= div) {
      const scaled = abs / div;
      const rounded = Number(scaled.toFixed(digits));
      const text = Number.isInteger(rounded)
        ? String(rounded)
        : String(rounded).replace(/\.?0+$/, '');
      return `${sign}${text}${symbol}`;
    }
  }
  return `${sign}${formatExact(abs)}`;
}

/**
 * Format with thousands separators.
 * @param {number|bigint|string} value
 * @returns {string}
 */
export function formatExact(value) {
  const n = toSafeNumber(value);
  if (!Number.isFinite(n)) return '—';
  return Math.trunc(n).toLocaleString('en-US');
}

/**
 * Format a signed change with +/− prefix and compact form.
 * @param {number} delta
 * @returns {string}
 */
export function formatDelta(delta) {
  if (!Number.isFinite(delta)) return '—';
  if (delta === 0) return '0';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatCompact(delta)}`;
}

/**
 * Format percentage change.
 * @param {number} pct
 * @returns {string}
 */
export function formatPercent(pct) {
  if (!Number.isFinite(pct)) return '—';
  if (pct === 0) return '0%';
  const sign = pct > 0 ? '+' : '';
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 2;
  return `${sign}${pct.toFixed(digits)}%`;
}

/**
 * Parse coin input supporting commas, decimals, and K/M/B/T suffixes.
 * @param {string} input
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseCoinInput(input) {
  if (input == null) {
    return { ok: false, error: 'Enter a coin balance' };
  }
  let raw = String(input).trim();
  if (!raw) {
    return { ok: false, error: 'Enter a coin balance' };
  }

  raw = raw.replace(/,/g, '').replace(/\s+/g, '');
  const match = raw.match(/^([+-]?)(\d*\.?\d+)([kKmMbBtT])?$/);
  if (!match) {
    return { ok: false, error: 'Invalid format. Try 1.25b, 850m, or 1,250,000' };
  }

  const sign = match[1] === '-' ? -1 : 1;
  const num = Number(match[2]);
  if (!Number.isFinite(num)) {
    return { ok: false, error: 'Invalid number' };
  }

  const mult =
    {
      k: 1e3,
      K: 1e3,
      m: 1e6,
      M: 1e6,
      b: 1e9,
      B: 1e9,
      t: 1e12,
      T: 1e12,
    }[match[3]] ?? 1;

  const value = sign * num * mult;
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'Balance must be zero or greater' };
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: 'Balance is too large' };
  }

  // Store as integer coins
  const intValue = Math.round(value);
  return { ok: true, value: intValue };
}

/**
 * Compute gain/loss and percentage vs previous.
 * @param {number} current
 * @param {number|null|undefined} previous
 * @returns {{ delta: number|null, percent: number|null }}
 */
export function computeChange(current, previous) {
  if (previous == null || !Number.isFinite(previous)) {
    return { delta: null, percent: null };
  }
  const delta = current - previous;
  const percent = previous === 0 ? (current === 0 ? 0 : null) : (delta / previous) * 100;
  return { delta, percent };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toSafeNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value.replace(/,/g, ''));
  return Number(value);
}

/**
 * Change tone for CSS classes.
 * @param {number|null|undefined} delta
 * @returns {'positive'|'negative'|'neutral'}
 */
export function changeTone(delta) {
  if (delta == null || delta === 0 || !Number.isFinite(delta)) return 'neutral';
  return delta > 0 ? 'positive' : 'negative';
}
