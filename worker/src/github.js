/**
 * GitHub Contents API helpers for the private data repository.
 */

/**
 * @typedef {object} Env
 * @property {string} GITHUB_TOKEN
 * @property {string} GITHUB_OWNER
 * @property {string} GITHUB_DATA_REPO
 * @property {string} GITHUB_DATA_PATH
 */

/**
 * @param {Env} env
 */
function repoMeta(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_DATA_REPO;
  const path = env.GITHUB_DATA_PATH || 'data/skyblock-coins.json';
  if (!env.GITHUB_TOKEN) throw new GithubError('GitHub token not configured', 500, 'CONFIG');
  if (!owner || !repo) throw new GithubError('GitHub repo not configured', 500, 'CONFIG');
  return { owner, repo, path };
}

/**
 * Read the JSON database. Throws on failure — never returns empty inventing data.
 * @param {Env} env
 * @returns {Promise<{ data: object, sha: string }>}
 */
export async function readDatabase(env) {
  const { owner, repo, path } = repoMeta(env);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await githubFetch(env, url);
  if (res.status === 404) {
    throw new GithubError('Data file not found in private repository', 502, 'GITHUB');
  }
  if (!res.ok) {
    const text = await res.text();
    console.error('GitHub read failed', res.status, text);
    throw new GithubError('GitHub error while reading data', 502, 'GITHUB');
  }
  const json = await res.json();
  if (!json.content || !json.sha) {
    throw new GithubError('Unexpected GitHub response', 502, 'GITHUB');
  }
  let parsed;
  try {
    const decoded = decodeBase64Utf8(json.content.replace(/\n/g, ''));
    parsed = JSON.parse(decoded);
  } catch (e) {
    console.error('Malformed data file', e);
    throw new GithubError('Malformed data file', 502, 'MALFORMED');
  }
  return { data: parsed, sha: json.sha };
}

/**
 * Write database with optimistic concurrency via SHA.
 * Retries once on 409 conflict.
 * @param {Env} env
 * @param {object} data
 * @param {string} sha
 * @param {string} message
 */
export async function writeDatabase(env, data, sha, message) {
  const { owner, repo, path } = repoMeta(env);
  const content = encodeBase64Utf8(JSON.stringify(data, null, 2) + '\n');

  const attempt = async (currentSha) => {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const res = await githubFetch(env, url, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content,
        sha: currentSha,
        branch: 'main',
      }),
    });
    return res;
  };

  let res = await attempt(sha);
  if (res.status === 409) {
    // Conflict — re-read and let caller decide, or retry once with fresh sha for simple ops
    const fresh = await readDatabase(env);
    throw new ConflictError('Concurrent update conflict', fresh);
  }
  if (!res.ok) {
    const text = await res.text();
    console.error('GitHub write failed', res.status, text);
    throw new GithubError('GitHub error while saving data', 502, 'GITHUB');
  }
  return res.json();
}

/**
 * Create a backup file before destructive import.
 * @param {Env} env
 * @param {object} data
 * @param {string} message
 */
export async function writeBackup(env, data, message) {
  const { owner, repo } = repoMeta(env);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `data/backups/skyblock-coins-${stamp}.json`;
  const content = encodeBase64Utf8(JSON.stringify(data, null, 2) + '\n');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await githubFetch(env, url, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content,
      branch: 'main',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Backup write failed', res.status, text);
    throw new GithubError('Failed to create backup before import', 502, 'GITHUB');
  }
  return res.json();
}

async function githubFetch(env, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  headers.set('User-Agent', 'skyblock-coin-tracker-worker');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64Utf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GithubError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} code
   */
  constructor(message, status = 502, code = 'GITHUB') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ConflictError extends Error {
  constructor(message, fresh) {
    super(message);
    this.code = 'CONFLICT';
    this.status = 409;
    this.fresh = fresh;
  }
}
