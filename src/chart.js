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

// silence unused import warning in bundlers that tree-shake poorly
void formatDelta;
