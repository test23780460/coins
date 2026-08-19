const TOKEN_KEY = 'sbct_session';

/**
 * Resolve API base URL.
 * Production: set VITE_API_BASE_URL at build time.
 * Dev fallback: local wrangler.
 */
export function getApiBase() {
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).replace(/\/$/, '');
  }
  if (import.meta.env.DEV) {
    return 'http://127.0.0.1:8787';
  }
  // Production Worker (also set via VITE_API_BASE_URL in GitHub Actions)
  return 'https://skyblock-coin-tracker.ptravis022.workers.dev';
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * @param {string} path
 * @param {RequestInit & { auth?: boolean, json?: unknown }} [opts]
 */
export async function api(path, opts = {}) {
  const { auth = true, json, headers: extraHeaders, ...rest } = opts;
  const headers = new Headers(extraHeaders || {});
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (auth) {
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let res;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    const err = new Error('Network error — check your connection or try again later');
    err.code = 'NETWORK';
    throw err;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code || (res.status === 401 ? 'UNAUTHORIZED' : 'API');
    err.details = data;
    if (res.status === 401) clearToken();
    throw err;
  }

  return data;
}

export async function login(password) {
  const data = await api('/api/login', {
    method: 'POST',
    auth: false,
    json: { password },
  });
  if (data?.token) setToken(data.token);
  return data;
}

export async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // ignore — clear local session anyway
  } finally {
    clearToken();
  }
}

export async function fetchEntries() {
  return api('/api/entries');
}

export async function createEntry({ coins, timestamp, note }) {
  return api('/api/entries', {
    method: 'POST',
    json: { coins, timestamp, note },
  });
}

export async function updateEntry(id, { coins, timestamp, note }) {
  return api(`/api/entries/${encodeURIComponent(id)}`, {
    method: 'PUT',
    json: { coins, timestamp, note },
  });
}

export async function deleteEntry(id) {
  return api(`/api/entries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function importBackup(payload) {
  return api('/api/import', {
    method: 'POST',
    json: payload,
  });
}

export async function fetchAutomationStatus() {
  return api('/api/automation/status');
}

export async function runAutomationCheck() {
  return api('/api/automation/run', { method: 'POST' });
}

export async function fetchProfileProgress() {
  return api('/api/profile/progress');
}

export async function fetchProfileSnapshots() {
  return api('/api/profile/snapshots');
}

export async function fetchApiKeyStatus() {
  return api('/api/settings/api-key');
}

export async function updateApiKey(apiKey) {
  return api('/api/settings/api-key', {
    method: 'PUT',
    json: { apiKey },
  });
}
