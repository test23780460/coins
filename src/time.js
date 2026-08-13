const TZ = 'America/New_York';

/**
 * Format a Date or ISO string for display in America/New_York.
 * @param {string|Date} input
 * @returns {{ date: string, time: string, dateShort: string, dateLong: string, timeShort: string }}
 */
export function formatNy(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    return {
      date: '—',
      time: '—',
      dateShort: '—',
      dateLong: '—',
      timeShort: '—',
    };
  }

  const dateLong = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);

  const dateShort = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);

  const timeShort = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);

  const dateIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

  return {
    date: dateIso,
    time: timeShort,
    dateShort,
    dateLong,
    timeShort,
  };
}

/**
 * Sort entries oldest → newest by timestamp.
 * @param {Array<{ timestamp: string }>} entries
 */
export function sortChronological(entries) {
  return [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * Enrich entries with delta/percent vs previous chronological entry.
 * Returns newest-first for display.
 * @param {Array<{ id: string, coins: number, timestamp: string }>} entries
 */
export function withChanges(entries) {
  const chrono = sortChronological(entries);
  const enriched = chrono.map((entry, i) => {
    const prev = i === 0 ? null : chrono[i - 1];
    const delta = prev == null ? null : entry.coins - prev.coins;
    const percent =
      prev == null || prev.coins === 0
        ? prev == null
          ? null
          : entry.coins === 0
            ? 0
            : null
        : ((entry.coins - prev.coins) / prev.coins) * 100;
    return { ...entry, delta, percent, previousCoins: prev?.coins ?? null };
  });
  return enriched.reverse();
}

/**
 * Stats for dashboard cards.
 * @param {Array<{ coins: number, timestamp: string }>} entries
 */
export function computeStats(entries) {
  const chrono = sortChronological(entries);
  if (chrono.length === 0) {
    return {
      current: null,
      previousChange: { delta: null, percent: null },
      last7Days: { delta: null, percent: null },
      allTime: { delta: null, percent: null },
    };
  }

  const latest = chrono[chrono.length - 1];
  const previous = chrono.length > 1 ? chrono[chrono.length - 2] : null;
  const first = chrono[0];

  const previousChange =
    previous == null
      ? { delta: null, percent: null }
      : {
          delta: latest.coins - previous.coins,
          percent:
            previous.coins === 0
              ? latest.coins === 0
                ? 0
                : null
              : ((latest.coins - previous.coins) / previous.coins) * 100,
        };

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const target = new Date(latest.timestamp).getTime() - sevenDaysMs;
  let baseline = chrono[0];
  let bestDiff = Math.abs(new Date(baseline.timestamp).getTime() - target);
  for (const e of chrono) {
    const diff = Math.abs(new Date(e.timestamp).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      baseline = e;
    }
  }
  // Prefer an entry at or before the 7-day mark when possible
  const beforeOrAt = [...chrono].reverse().find((e) => new Date(e.timestamp).getTime() <= target);
  if (beforeOrAt) baseline = beforeOrAt;

  const last7Days = {
    delta: latest.coins - baseline.coins,
    percent:
      baseline.coins === 0
        ? latest.coins === 0
          ? 0
          : null
        : ((latest.coins - baseline.coins) / baseline.coins) * 100,
  };

  const allTime = {
    delta: latest.coins - first.coins,
    percent:
      first.coins === 0
        ? latest.coins === 0
          ? 0
          : null
        : ((latest.coins - first.coins) / first.coins) * 100,
  };

  return {
    current: latest.coins,
    previousChange,
    last7Days,
    allTime,
  };
}

/**
 * Filter entries for chart range.
 * @param {Array<{ timestamp: string }>} entries
 * @param {'7D'|'30D'|'90D'|'ALL'} range
 */
export function filterByRange(entries, range) {
  if (range === 'ALL') return sortChronological(entries);
  const days = { '7D': 7, '30D': 30, '90D': 90 }[range] ?? 7;
  const chrono = sortChronological(entries);
  if (chrono.length === 0) return [];
  const latest = new Date(chrono[chrono.length - 1].timestamp).getTime();
  const cutoff = latest - days * 24 * 60 * 60 * 1000;
  return chrono.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

export { TZ };
