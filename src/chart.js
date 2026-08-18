import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import { formatCompact, formatExact, formatDelta } from './formatting.js';
import { formatNy, filterByRange, withChanges, sortChronological } from './time.js';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend
);

let chartInstance = null;
let profileChartInstances = { netWorth: null, skillXp: null };

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array} entries
 * @param {'7D'|'30D'|'90D'|'ALL'} range
 */
export function renderChart(canvas, entries, range = 'ALL') {
  const filtered = filterByRange(entries, range);
  const chrono = sortChronological(filtered);
  const enrichedMap = new Map(
    withChanges(entries).map((e) => [e.id, e])
  );

  const labels = chrono.map((e) => {
    const ny = formatNy(e.timestamp);
    return `${ny.dateShort}\n${ny.timeShort}`;
  });
  const data = chrono.map((e) => e.coins);

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Coins',
          data,
          borderColor: '#e8b84a',
          backgroundColor: 'rgba(232, 184, 74, 0.12)',
          borderWidth: 2.5,
          pointRadius: chrono.length > 40 ? 2 : 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#e8b84a',
          pointBorderColor: '#0b1220',
          pointBorderWidth: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 22, 36, 0.95)',
          titleColor: '#f2f5fa',
          bodyColor: '#c5cedd',
          borderColor: 'rgba(232, 184, 74, 0.35)',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            title(items) {
              const i = items[0]?.dataIndex ?? 0;
              const e = chrono[i];
              if (!e) return '';
              const ny = formatNy(e.timestamp);
              return `${ny.dateLong}\n${ny.timeShort}`;
            },
            label(item) {
              const e = chrono[item.dataIndex];
              const full = enrichedMap.get(e.id) || e;
              const lines = [
                `Balance: ${formatExact(e.coins)}`,
              ];
              if (full.delta != null) {
                lines.push(`Change: ${full.delta >= 0 ? '+' : ''}${formatExact(full.delta)}`);
              }
              if (typeof e.note === 'string' && e.note.trim()) {
                lines.push(`Note: ${e.note.trim()}`);
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#8b97ab',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            font: { family: "'DM Sans', sans-serif", size: 11 },
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#8b97ab',
            callback: (v) => formatCompact(v),
            font: { family: "'JetBrains Mono', monospace", size: 11 },
          },
        },
      },
    },
  };

  if (chartInstance) {
    chartInstance.data = cfg.data;
    chartInstance.options = cfg.options;
    chartInstance.update();
    return chartInstance;
  }

  chartInstance = new Chart(canvas, cfg);
  return chartInstance;
}

export function destroyChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}

/**
 * Secondary profile analytics charts — never mixes into the coin chart.
 * @param {'netWorth'|'skillXp'} kind
 * @param {HTMLCanvasElement} canvas
 * @param {Array} snapshots
 * @param {'7D'|'30D'|'90D'|'ALL'} range
 */
export function renderProfileChart(kind, canvas, snapshots, range = 'ALL') {
  if (!canvas) return null;
  const filtered = filterByRange(snapshots || [], range);
  const chrono = sortChronological(filtered).filter((s) => {
    if (kind === 'netWorth') return Number.isFinite(s.netWorth);
    return Number.isFinite(s.totalSkillXp);
  });

  const labels = chrono.map((e) => {
    const ny = formatNy(e.timestamp);
    return `${ny.dateShort}\n${ny.timeShort}`;
  });
  const data = chrono.map((e) => (kind === 'netWorth' ? e.netWorth : e.totalSkillXp));
  const label = kind === 'netWorth' ? 'Estimated Net Worth' : 'Total Skill XP';
  const color = kind === 'netWorth' ? '#7eb6ff' : '#9ad27a';

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor: color,
          backgroundColor:
            kind === 'netWorth' ? 'rgba(126, 182, 255, 0.12)' : 'rgba(154, 210, 122, 0.12)',
          borderWidth: 2,
          pointRadius: chrono.length > 40 ? 2 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: '#0b1220',
          pointBorderWidth: 2,
          tension: 0.25,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 22, 36, 0.95)',
          titleColor: '#f2f5fa',
          bodyColor: '#c5cedd',
          borderColor: 'rgba(232, 184, 74, 0.25)',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label(item) {
              return `${label}: ${formatExact(item.raw)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#8b97ab',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 5,
            font: { family: "'DM Sans', sans-serif", size: 10 },
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#8b97ab',
            callback: (v) => formatCompact(v),
            font: { family: "'JetBrains Mono', monospace", size: 10 },
          },
        },
      },
    },
  };

  const existing = profileChartInstances[kind];
  if (existing) {
    existing.data = cfg.data;
    existing.options = cfg.options;
    existing.update();
    return existing;
  }
  profileChartInstances[kind] = new Chart(canvas, cfg);
  return profileChartInstances[kind];
}

export function destroyProfileCharts() {
  for (const key of Object.keys(profileChartInstances)) {
    if (profileChartInstances[key]) {
      profileChartInstances[key].destroy();
      profileChartInstances[key] = null;
    }
  }
}

// silence unused import warning in bundlers that tree-shake poorly
void formatDelta;
