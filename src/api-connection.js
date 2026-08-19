/**
 * Header API Key controls (next to Export / Logout).
 */

import { formatNy } from './time.js';

/**
 * @param {any} status from GET /api/settings/api-key
 */
export function renderApiConnectionHtml(status) {
  const s = status || {};
  const state = s.status || (s.configured ? 'connected' : 'needs_key');

  let badge = 'Needs key';
  let badgeClass = 'api-header-badge api-header-badge--warn';
  let btnLabel = 'API Key';
  if (state === 'connected') {
    badge = 'Connected';
    badgeClass = 'api-header-badge api-header-badge--ok';
  } else if (state === 'invalid') {
    badge = 'Invalid';
    badgeClass = 'api-header-badge api-header-badge--bad';
    btnLabel = 'API Key ⚠';
  }

  const masked = s.lastFour
    ? `••••••••••••${escapeHtml(String(s.lastFour))}`
    : s.configured
      ? '••••••••••••••••'
      : 'Not set';

  const updated = s.updatedAt
    ? `${formatNy(s.updatedAt).dateShort} · ${formatNy(s.updatedAt).timeShort} ET`
    : 'Never via website';

  const ageNote =
    s.mayNeedRotation && state === 'connected'
      ? `<p class="api-menu-note">Updated ${Number(s.ageDays) || 6}+ days ago — you may need a new key soon.</p>`
      : '';

  const alert =
    state === 'invalid'
      ? `<p class="api-menu-alert">API key expired. Paste a new one to resume automatic tracking.</p>`
      : state === 'needs_key'
        ? `<p class="api-menu-alert">Paste your Hypixel API key to enable automatic tracking.</p>`
        : '';

  return `
    <button type="button" class="btn btn-ghost" id="btn-api-menu" aria-haspopup="true" aria-expanded="false">
      ${escapeHtml(btnLabel)}
      <span class="${badgeClass}" id="api-status-badge">${escapeHtml(badge)}</span>
    </button>
    <div class="menu-panel api-menu-panel" id="api-menu-panel" role="menu">
      <div class="api-menu-body">
        <div class="api-menu-title">Hypixel API Key</div>
        ${alert}
        <div class="api-menu-row">
          <span class="stat-label">Current</span>
          <span class="api-masked" id="api-last-four">${masked}</span>
        </div>
        <div class="api-menu-row">
          <span class="stat-label">Updated</span>
          <span class="api-updated" id="api-updated">${escapeHtml(updated)}</span>
        </div>
        ${ageNote}
        <div class="api-input-wrap">
          <input
            type="password"
            id="api-key-input"
            class="balance-input"
            autocomplete="off"
            spellcheck="false"
            placeholder="Paste new API key…"
            aria-label="New Hypixel API key"
          />
          <button type="button" class="btn btn-ghost api-toggle" id="api-key-toggle" aria-label="Show API key">Show</button>
        </div>
        <button type="button" class="btn btn-primary api-update-btn" id="btn-update-api-key">Update API Key</button>
        <p class="api-msg" id="api-msg" hidden></p>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
