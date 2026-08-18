/**
 * Profile progress display helpers (net worth / skill XP) — not coin metrics.
 */

import { formatCompact, formatDelta, formatPercent, changeTone } from './formatting.js';
import { formatNy } from './time.js';

const SKILL_LABELS = {
  farming: 'Farming',
  mining: 'Mining',
  combat: 'Combat',
  foraging: 'Foraging',
  fishing: 'Fishing',
  enchanting: 'Enchanting',
  alchemy: 'Alchemy',
  taming: 'Taming',
  carpentry: 'Carpentry',
  runecrafting: 'Runecrafting',
  social: 'Social',
};

export function skillLabel(id) {
  return SKILL_LABELS[id] || String(id).replace(/_/g, ' ');
}

/**
 * @param {any} progress from GET /api/profile/progress
 */
export function renderProfileProgressHtml(progress) {
  if (!progress?.current) {
    return `
      <div class="profile-empty">
        <p class="panel-desc" style="margin:0">
          No profile snapshots yet. Snapshots are saved automatically when Hypixel/SkyCrypt profile data is fetched
          (hourly check or Run Auto Check). Skill XP comes from Hypixel; estimated net worth appears when SkyCrypt provides it.
        </p>
      </div>`;
  }

  const nw = progress.netWorth || {};
  const skills = progress.skills || {};
  const biggest = skills.biggestGain;
  const last = progress.lastUpdated
    ? `${formatNy(progress.lastUpdated).dateShort} · ${formatNy(progress.lastUpdated).timeShort} ET`
    : '—';
  const source = progress.source ? String(progress.source) : '—';

  const nwChange =
    nw.available && nw.change != null
      ? `<div class="profile-delta tone-${changeTone(nw.change)}">${formatDelta(nw.change)}${
          nw.percentChange != null ? ` · ${formatPercent(nw.percentChange)}` : ''
        }</div>
         <div class="profile-sub">since last snapshot · estimated</div>`
      : `<div class="profile-sub">${
          nw.available ? 'No prior snapshot to compare' : 'Unavailable from current source'
        }</div>`;

  const totalChange =
    skills.totalChange != null
      ? `<div class="profile-delta tone-${changeTone(skills.totalChange)}">${formatDelta(skills.totalChange)} XP</div>
         <div class="profile-sub">since last snapshot</div>`
      : `<div class="profile-sub">No prior snapshot to compare</div>`;

  const biggestHtml = biggest
    ? `<div class="profile-card">
        <div class="stat-label">Biggest Skill Gain</div>
        <div class="profile-value">${escapeHtml(skillLabel(biggest.skill))}</div>
        <div class="profile-delta tone-${changeTone(biggest.change)}">${formatDelta(biggest.change)} XP</div>
      </div>`
      : `<div class="profile-card">
        <div class="stat-label">Biggest Skill Gain</div>
        <div class="profile-value">—</div>
        <div class="profile-sub">Need two snapshots</div>
      </div>`;

  const rows = Object.entries(skills.perSkill || {})
    .filter(([, v]) => v && v.available)
    .map(([id, v]) => {
      const changeCell =
        v.change == null
          ? `<span class="tone-neutral">—</span>`
          : `<span class="tone-${changeTone(v.change)}">${formatDelta(v.change)}</span>`;
      return `<tr>
        <td>${escapeHtml(skillLabel(id))}</td>
        <td class="num">${formatCompact(v.xp)}</td>
        <td class="num">${changeCell}</td>
      </tr>`;
    })
    .join('');

  return `
    <div class="profile-meta">
      <span>Last updated <strong>${escapeHtml(last)}</strong></span>
      <span>Source <strong>${escapeHtml(source)}</strong></span>
    </div>
    <div class="profile-cards">
      <div class="profile-card">
        <div class="stat-label">Estimated Net Worth</div>
        <div class="profile-value">${nw.available ? formatCompact(nw.netWorth) : '—'}</div>
        ${nwChange}
      </div>
      <div class="profile-card">
        <div class="stat-label">Total Skill XP</div>
        <div class="profile-value">${
          skills.totalSkillXp != null ? formatCompact(skills.totalSkillXp) : '—'
        }</div>
        ${totalChange}
      </div>
      ${biggestHtml}
    </div>
    <details class="profile-details">
      <summary>Skill details</summary>
      <div class="table-wrap">
        <table class="data-table profile-skill-table">
          <thead>
            <tr><th>Skill</th><th class="num">XP</th><th class="num">Change</th></tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="3" class="tone-neutral">No skill XP in latest snapshot</td></tr>`}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
