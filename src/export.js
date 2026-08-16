import { formatCompact, formatExact, formatDelta, formatPercent, changeTone } from './formatting.js';
import { formatNy, withChanges, computeStats, filterByRange, sortChronological } from './time.js';

/**
 * Build CSV string for all entries (newest first with changes).
 * @param {Array} entries
 */
export function toCsv(entries) {
  const rows = withChanges(entries);
  const header = [
    'Date',
    'Time',
    'Timestamp',
    'Total Coins',
    'Gain/Loss',
    'Percentage Change',
    'Note',
    'Source',
  ];
  const lines = [header.join(',')];
  for (const e of rows) {
    const ny = formatNy(e.timestamp);
    const pct =
      e.percent == null || !Number.isFinite(e.percent) ? '' : e.percent.toFixed(2);
    const delta = e.delta == null ? '' : String(e.delta);
    lines.push(
      [
        csvEscape(ny.date),
        csvEscape(ny.time),
        csvEscape(e.timestamp),
        String(e.coins),
        delta,
        pct,
        csvEscape(e.note || ''),
        csvEscape(sourceLabel(e.source)),
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Full JSON backup of the database.
 * @param {{ version?: number, entries: Array }} data
 */
export function toJsonBackup(data) {
  return JSON.stringify(
    {
      version: data.version ?? 1,
      exportedAt: new Date().toISOString(),
      entries: sortChronological(data.entries || []),
    },
    null,
    2
  );
}

/**
 * Validate an imported JSON backup.
 * @param {unknown} raw
 */
export function validateImport(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'File must contain a JSON object' };
  }
  const entries = raw.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, error: 'Missing entries array' };
  }

  const valid = [];
  const invalid = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const coins = Number(e?.coins);
    const ts = e?.timestamp;
    const id = e?.id;
    if (
      !Number.isFinite(coins) ||
      coins < 0 ||
      !Number.isSafeInteger(coins) ||
      typeof ts !== 'string' ||
      Number.isNaN(Date.parse(ts))
    ) {
      invalid.push({ index: i, entry: e });
      continue;
    }
    valid.push({
      id: typeof id === 'string' && id ? id : undefined,
      coins,
      timestamp: new Date(ts).toISOString(),
      note:
        typeof e?.note === 'string' && e.note.trim()
          ? e.note.trim().slice(0, 500)
          : undefined,
      source:
        typeof e?.source === 'string' &&
        ['manual', 'auto-skycrypt', 'auto-hypixel'].includes(e.source)
          ? e.source
          : undefined,
      meta: e?.meta && typeof e.meta === 'object' ? e.meta : undefined,
    });
  }

  return {
    ok: true,
    version: Number(raw.version) || 1,
    valid,
    invalid,
    entryCount: valid.length,
    invalidCount: invalid.length,
  };
}

export function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function sourceLabel(source) {
  if (source === 'auto-skycrypt' || source === 'auto-hypixel') return 'SkyCrypt Auto';
  return 'Manual';
}

export {
  formatCompact,
  formatExact,
  formatDelta,
  formatPercent,
  changeTone,
  formatNy,
  withChanges,
  computeStats,
  filterByRange,
};
