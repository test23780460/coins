import { toast } from './toast.js';
import {
  fetchEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  importBackup,
  logout as apiLogout,
} from './api.js';
import {
  formatCompact,
  formatExact,
  formatDelta,
  formatPercent,
  parseCoinInput,
  changeTone,
} from './formatting.js';
import { formatNy, withChanges, computeStats } from './time.js';
import { renderChart, destroyChart } from './chart.js';
import { toCsv, toJsonBackup, validateImport, downloadBlob } from './export.js';

/**
 * @param {HTMLElement} root
 * @param {{ onLogout: () => void }} opts
 */
export function mountDashboard(root, opts) {
  let entries = [];
  let version = 1;
  let range = 'ALL';
  let busy = false;

  root.innerHTML = `
    <header class="app-header">
      <div class="brand">
        <strong>SkyBlock Coin Tracker</strong>
        <small>Personal Tracker</small>
      </div>
      <div class="header-actions">
        <div class="menu" id="export-menu">
          <button type="button" class="btn btn-ghost" id="btn-export" aria-haspopup="true" aria-expanded="false">Export</button>
          <div class="menu-panel" id="export-panel" role="menu">
            <button type="button" data-action="csv">Export CSV</button>
            <button type="button" data-action="json">Export JSON Backup</button>
            <button type="button" data-action="import">Import JSON</button>
          </div>
        </div>
        <button type="button" class="btn btn-ghost" id="btn-logout">Logout</button>
      </div>
    </header>
    <main class="main">
      <section class="stat-grid" id="stats"></section>

      <section class="panel">
        <h2>Current Coin Balance</h2>
        <p class="panel-desc">Enter your total coins. Supports 1.25b, 850m, 750k, and commas.</p>
        <div class="balance-row">
          <div>
            <input class="balance-input" id="balance-input" type="text" inputmode="text" autocomplete="off" placeholder="e.g. 1.25b" aria-label="Current Coin Balance" />
            <div class="parse-preview" id="parse-preview"></div>
            <label class="note-label" for="note-input">Note <span>(optional)</span></label>
            <textarea class="note-input" id="note-input" rows="2" maxlength="500" placeholder="Why did it go up or down? e.g. sold Hyperion, bazaar flip, died in dungeon…" aria-label="Balance change note"></textarea>
          </div>
          <button type="button" class="btn btn-primary save-btn" id="btn-save">Save Balance</button>
        </div>
      </section>

      <section class="panel">
        <div class="chart-head">
          <h2 style="margin:0">Coin Progress</h2>
          <div class="range-tabs" id="range-tabs" role="tablist">
            <button type="button" data-range="7D">7D</button>
            <button type="button" data-range="30D">30D</button>
            <button type="button" data-range="90D">90D</button>
            <button type="button" data-range="ALL" class="active">ALL</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="coin-chart" aria-label="Coin Progress chart"></canvas></div>
      </section>

      <section class="panel">
        <h2>Balance History</h2>
        <p class="panel-desc">Newest entries first. Unlimited entries per day.</p>
        <div id="history"></div>
      </section>
    </main>
    <input type="file" id="import-file" accept="application/json,.json" hidden />
  `;

  const els = {
    stats: root.querySelector('#stats'),
    history: root.querySelector('#history'),
    input: root.querySelector('#balance-input'),
    note: root.querySelector('#note-input'),
    preview: root.querySelector('#parse-preview'),
    save: root.querySelector('#btn-save'),
    chart: root.querySelector('#coin-chart'),
    rangeTabs: root.querySelector('#range-tabs'),
    exportBtn: root.querySelector('#btn-export'),
    exportPanel: root.querySelector('#export-panel'),
    logout: root.querySelector('#btn-logout'),
    importFile: root.querySelector('#import-file'),
  };

  function setBusy(v) {
    busy = v;
    els.save.disabled = v;
    els.save.textContent = v ? 'Saving…' : 'Save Balance';
  }

  function updatePreview() {
    const parsed = parseCoinInput(els.input.value);
    if (!els.input.value.trim()) {
      els.preview.textContent = '';
      return;
    }
    if (!parsed.ok) {
      els.preview.innerHTML = `<span class="tone-negative">${escapeHtml(parsed.error)}</span>`;
      return;
    }
    const shown = els.input.value.trim();
    els.preview.innerHTML = `<strong>${escapeHtml(shown)}</strong> → ${formatExact(parsed.value)} coins`;
  }

  function renderStats() {
    const s = computeStats(entries);
    const cards = [
      {
        hero: true,
        label: 'Current Coins',
        value: s.current == null ? '—' : formatCompact(s.current),
        sub: s.current == null ? 'No entries yet' : formatExact(s.current),
        change: null,
      },
      {
        label: 'Previous Change',
        value: formatDelta(s.previousChange.delta ?? 0),
        sub: null,
        change: s.previousChange,
        empty: s.previousChange.delta == null,
      },
      {
        label: 'Last 7 Days',
        value: formatDelta(s.last7Days.delta ?? 0),
        sub: null,
        change: s.last7Days,
        empty: s.last7Days.delta == null || entries.length < 2,
      },
      {
        label: 'All-Time Gain',
        value: formatDelta(s.allTime.delta ?? 0),
        sub: null,
        change: s.allTime,
        empty: s.allTime.delta == null || entries.length < 2,
      },
    ];

    els.stats.innerHTML = cards
      .map((c, i) => {
        if (i === 0) {
          return `<article class="stat-card stat-card--hero">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
            <div class="stat-sub">${c.sub}</div>
          </article>`;
        }
        if (c.empty) {
          return `<article class="stat-card">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value tone-neutral">—</div>
            <div class="stat-change tone-neutral">Need more entries</div>
          </article>`;
        }
        const tone = changeTone(c.change.delta);
        return `<article class="stat-card">
          <div class="stat-label">${c.label}</div>
          <div class="stat-value tone-${tone}">${formatDelta(c.change.delta)}</div>
          <div class="stat-change tone-${tone}">${formatPercent(c.change.percent)}</div>
        </article>`;
      })
      .join('');
  }

  function renderHistory() {
    if (entries.length === 0) {
      els.history.innerHTML = `
        <div class="empty-state">
          <h3>Start Tracking Your Coins</h3>
          <p>You haven't recorded a balance yet. Enter your current SkyBlock coin balance above to begin tracking your progress.</p>
        </div>`;
      return;
    }

    const rows = withChanges(entries);
    els.history.innerHTML = `
      <div class="table-wrap">
        <table class="history">
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th>Total Coins</th>
              <th>Gain/Loss</th>
              <th>% Change</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((e) => {
                const ny = formatNy(e.timestamp);
                const tone = changeTone(e.delta);
                const delta =
                  e.delta == null ? '—' : formatDelta(e.delta);
                const pct =
                  e.percent == null ? '—' : formatPercent(e.percent);
                const note = typeof e.note === 'string' && e.note.trim() ? e.note.trim() : '';
                return `<tr data-id="${escapeAttr(e.id)}">
                  <td>${escapeHtml(ny.dateShort)}</td>
                  <td>${escapeHtml(ny.timeShort)}</td>
                  <td class="mono" title="${formatExact(e.coins)}">${formatCompact(e.coins)}</td>
                  <td class="mono tone-${tone}">${delta}</td>
                  <td class="mono tone-${tone}">${pct}</td>
                  <td>
                    <div class="row-actions">
                      <button type="button" class="btn btn-ghost" data-edit="${escapeAttr(e.id)}">Edit</button>
                      <button type="button" class="btn btn-danger" data-delete="${escapeAttr(e.id)}">Delete</button>
                    </div>
                  </td>
                </tr>
                ${
                  note
                    ? `<tr class="history-note-row" data-note-for="${escapeAttr(e.id)}">
                        <td colspan="6"><div class="entry-note">${escapeHtml(note)}</div></td>
                      </tr>`
                    : ''
                }`;
              })
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  function refreshChart() {
    if (entries.length === 0) {
      destroyChart();
      const ctx = els.chart.getContext('2d');
      ctx.clearRect(0, 0, els.chart.width, els.chart.height);
      return;
    }
    renderChart(els.chart, entries, range);
  }

  function refreshAll() {
    renderStats();
    renderHistory();
    refreshChart();
  }

  async function load() {
    const data = await fetchEntries();
    entries = data.entries || [];
    version = data.version ?? 1;
    refreshAll();
  }

  async function saveBalance() {
    const parsed = parseCoinInput(els.input.value);
    if (!parsed.ok) {
      toast(parsed.error, 'error');
      return;
    }
    setBusy(true);
    try {
      const note = els.note.value.trim();
      const data = await createEntry({
        coins: parsed.value,
        timestamp: new Date().toISOString(),
        note: note || undefined,
      });
      entries = data.entries || [];
      version = data.version ?? version;
      els.input.value = '';
      els.note.value = '';
      updatePreview();
      refreshAll();
      toast('Balance saved successfully', 'success');
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  }

  function openModal({ title, bodyHtml, confirmText, danger, onConfirm }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('[data-cancel]').addEventListener('click', close);
    backdrop.querySelector('[data-confirm]').addEventListener('click', async () => {
      const btn = backdrop.querySelector('[data-confirm]');
      btn.disabled = true;
      try {
        await onConfirm(backdrop);
        close();
      } catch (err) {
        btn.disabled = false;
        handleApiError(err);
      }
    });
    return backdrop;
  }

  function editEntry(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    const ny = formatNy(entry.timestamp);
    // datetime-local in local browser TZ — convert from ISO
    const localValue = toDatetimeLocalValue(entry.timestamp);

    openModal({
      title: 'Edit Balance Entry',
      confirmText: 'Save Changes',
      bodyHtml: `
        <div class="field">
          <label for="edit-coins">Coin value</label>
          <input id="edit-coins" class="balance-input" value="${escapeAttr(String(entry.coins))}" />
          <div class="parse-preview" id="edit-preview"></div>
        </div>
        <div class="field">
          <label for="edit-time">Timestamp (local)</label>
          <input id="edit-time" type="datetime-local" class="balance-input" value="${escapeAttr(localValue)}" />
        </div>
        <div class="field">
          <label for="edit-note">Note</label>
          <textarea id="edit-note" class="note-input" rows="3" maxlength="500" placeholder="Why did it change?">${escapeHtml(entry.note || '')}</textarea>
        </div>
        <p style="font-size:0.85rem;color:var(--text-dim);margin:0">Originally ${escapeHtml(ny.dateLong)} · ${escapeHtml(ny.timeShort)} ET</p>
      `,
      onConfirm: async (backdrop) => {
        const coinInput = backdrop.querySelector('#edit-coins').value;
        const parsed = parseCoinInput(coinInput);
        if (!parsed.ok) throw Object.assign(new Error(parsed.error), { code: 'VALIDATION' });
        const dt = backdrop.querySelector('#edit-time').value;
        if (!dt) throw Object.assign(new Error('Timestamp required'), { code: 'VALIDATION' });
        const iso = new Date(dt).toISOString();
        const note = backdrop.querySelector('#edit-note').value.trim();
        const data = await updateEntry(id, {
          coins: parsed.value,
          timestamp: iso,
          note: note || undefined,
        });
        entries = data.entries || [];
        version = data.version ?? version;
        refreshAll();
        toast('Entry updated', 'success');
      },
    });

    const editInput = document.getElementById('edit-coins');
    const editPreview = document.getElementById('edit-preview');
    const sync = () => {
      const p = parseCoinInput(editInput.value);
      editPreview.innerHTML = p.ok
        ? `<strong>${escapeHtml(editInput.value.trim())}</strong> → ${formatExact(p.value)} coins`
        : `<span class="tone-negative">${escapeHtml(p.error)}</span>`;
    };
    editInput?.addEventListener('input', sync);
    sync();
  }

  function confirmDelete(id) {
    openModal({
      title: 'Delete Entry',
      confirmText: 'Delete',
      danger: true,
      bodyHtml: `<p>Are you sure you want to delete this balance entry?</p>`,
      onConfirm: async () => {
        const data = await deleteEntry(id);
        entries = data.entries || [];
        version = data.version ?? version;
        refreshAll();
        toast('Entry deleted', 'success');
      },
    });
  }

  function handleApiError(err) {
    console.error(err);
    if (err.code === 'UNAUTHORIZED' || err.status === 401) {
      toast('Session expired — please log in again', 'error');
      opts.onLogout();
      return;
    }
    if (err.code === 'NETWORK') {
      toast(err.message, 'error');
      return;
    }
    toast(err.message || 'Something went wrong', 'error');
  }

  // Events
  els.input.addEventListener('input', updatePreview);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBalance();
  });
  els.save.addEventListener('click', saveBalance);

  els.rangeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    range = btn.dataset.range;
    els.rangeTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    refreshChart();
  });

  els.history.addEventListener('click', (e) => {
    const editId = e.target.closest('[data-edit]')?.dataset?.edit;
    const delId = e.target.closest('[data-delete]')?.dataset?.delete;
    if (editId) editEntry(editId);
    if (delId) confirmDelete(delId);
  });

  els.exportBtn.addEventListener('click', () => {
    const open = els.exportPanel.classList.toggle('open');
    els.exportBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (e) => {
    if (!root.querySelector('#export-menu')?.contains(e.target)) {
      els.exportPanel.classList.remove('open');
      els.exportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  els.exportPanel.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset?.action;
    if (!action) return;
    els.exportPanel.classList.remove('open');
    if (action === 'csv') {
      const csv = toCsv(entries);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(`skyblock-coins-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
      toast('CSV exported', 'success');
    } else if (action === 'json') {
      const json = toJsonBackup({ version, entries });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(`skyblock-coins-backup-${stamp}.json`, json, 'application/json');
      toast('JSON backup exported', 'success');
    } else if (action === 'import') {
      els.importFile.click();
    }
  });

  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files?.[0];
    els.importFile.value = '';
    if (!file) return;
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      toast('Invalid JSON file', 'error');
      return;
    }
    const result = validateImport(raw);
    if (!result.ok) {
      toast(result.error, 'error');
      return;
    }

    openModal({
      title: 'Import JSON Backup',
      confirmText: 'Import & Replace',
      danger: true,
      bodyHtml: `
        <p>Found <strong>${result.entryCount}</strong> valid entr${result.entryCount === 1 ? 'y' : 'ies'}${
          result.invalidCount ? ` and <strong>${result.invalidCount}</strong> invalid` : ''
        }.</p>
        <p>This will replace your current history (${entries.length} entries). A backup commit will be created first on the server.</p>
      `,
      onConfirm: async () => {
        const data = await importBackup({
          version: result.version,
          entries: result.valid,
        });
        entries = data.entries || [];
        version = data.version ?? version;
        refreshAll();
        toast('Import completed', 'success');
      },
    });
  });

  els.logout.addEventListener('click', async () => {
    try {
      await apiLogout();
    } finally {
      opts.onLogout();
    }
  });

  return {
    async start() {
      root.querySelector('.main')?.insertAdjacentHTML(
        'afterbegin',
        `<div id="boot-status" class="panel" style="padding:14px 18px;color:var(--text-muted)">Loading data…</div>`
      );
      try {
        await load();
      } catch (err) {
        handleApiError(err);
        if (err.code !== 'UNAUTHORIZED' && err.status !== 401) {
          els.stats.innerHTML = `<div class="panel"><p class="tone-negative">${escapeHtml(err.message || 'Failed to load data')}</p></div>`;
        }
      } finally {
        root.querySelector('#boot-status')?.remove();
      }
    },
    destroy() {
      destroyChart();
    },
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function toDatetimeLocalValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
