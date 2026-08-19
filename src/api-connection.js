/**
 * Compact homepage API Connection card helpers.
 */

import { formatNy } from './time.js';

/**
 * @param {any} status from GET /api/settings/api-key
 */
export function renderApiConnectionHtml(status) {
  const s = status || {};
  const state = s.status || (s.configured ? 'connected' : 'needs_key');
  const needsAttention = state === 'invalid' || state === 'needs_key';

  let badge = 'Needs API Key';
  let badgeClass = 'api-badge api-badge--warn';
  if (state === 'connected') {
    badge = 'Connected';
    badgeClass = 'api-badge api-badge--ok';
  } else if (state === 'invalid') {
    badge = 'API Key Invalid';
    badgeClass = 'api-badge api-badge--bad';
  }

  const masked = s.lastFour
    ? `••••••••••••${escapeHtml(String(s.lastFour))}`
    : s.configured
      ? '••••••••••••••••'
      : 'Not set';

  const updated = s.updatedAt
    ? `${formatNy(s.updatedAt).dateShort} · ${formatNy(s.updatedAt).timeShort} ET`
    : '—';

  const ageNote =
    s.mayNeedRotation && state === 'connected'
      ? `<div class="api-hint">Key updated ${Number(s.ageDays) || 6}+ days ago — you may need to replace it soon.</div>`
      : '';

  const alert =
    state === 'invalid'
      ? `<div class="api-alert">⚠ API key expired. Update it below to resume automatic tracking. Manual coin logging still works.</div>`
      : state === 'needs_key'
        ? `<div class="api-alert">Add a Hypixel API key to enable automatic SkyBlock tracking.</div>`
        : '';

  return `
    <div class="api-card ${needsAttention ? 'api-card--attention' : ''}">
      <div class="api-card-head">
        <h2 style="margin:0">API Connection</h2>
        <span class="${badgeClass}" id="api-status-badge">${escapeHtml(badge)}</span>
      </div>
      ${alert}
      <div class="api-card-meta">
        <div>
          <div class="stat-label">Current key</div>
          <div class="api-masked" id="api-last-four">${masked}</div>
        </div>
        <div>
          <div class="stat-label">Last updated</div>
          <div class="api-updated" id="api-updated">${escapeHtml(updated)}</div>
        </div>
      </div>
      ${ageNote}
      <div class="api-form">
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
        <button type="button" class="btn btn-primary" id="btn-update-api-key">Update API Key</button>
      </div>
      <p class="api-msg" id="api-msg" hidden></p>
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
