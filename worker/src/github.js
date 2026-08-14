/**
 * Low-level GitHub Contents API helpers.
 */

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
  constructor(message, fresh = null) {
    super(message);
    this.code = 'CONFLICT';
    this.status = 409;
    this.fresh = fresh;
  }
}

/**
 * @param {any} env
 */
export function repoMeta(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_DATA_REPO;
  if (!env.GITHUB_TOKEN) throw new GithubError('GitHub token not configured', 500, 'CONFIG');
  if (!owner || !repo) throw new GithubError('GitHub repo not configured', 500, 'CONFIG');
  return { owner, repo };
}

/**
 * @param {any} env
 * @param {string} path
 * @returns {Promise<{ exists: false } | { exists: true, data: any, sha: string, raw: string, bytes: number }>}
 */
export async function readJsonFile(env, path) {
  const { owner, repo } = repoMeta(env);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}`;
  const res = await githubFetch(env, url);
  if (res.status === 404) {
    return { exists: false };
  }
  if (!res.ok) {
    const text = await res.text();
    console.error('GitHub read failed', path, res.status, text);
    throw new GithubError('GitHub error while reading data', 502, 'GITHUB');
  }
  const json = await res.json();
  if (!json.content || !json.sha) {
    throw new GithubError('Unexpected GitHub response', 502, 'GITHUB');
  }
  let raw;
  let parsed;
  try {
    raw = decodeBase64Utf8(json.content.replace(/\n/g, ''));
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('Malformed data file', path, e);
    throw new GithubError('Malformed data file', 502, 'MALFORMED');
  }
  return {
    exists: true,
    data: parsed,
    sha: json.sha,
    raw,
    bytes: new TextEncoder().encode(raw).length,
  };
}

/**
 * Create or update a JSON file.
 * @param {any} env
 * @param {string} path
 * @param {object} data
 * @param {string|null} sha  null = create new file
 * @param {string} message
 */
export async function writeJsonFile(env, path, data, sha, message) {
  const { owner, repo } = repoMeta(env);
  const content = encodeBase64Utf8(JSON.stringify(data, null, 2) + '\n');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}`;
  const body = {
    message,
    content,
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const res = await githubFetch(env, url, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    throw new ConflictError('Concurrent update conflict');
  }
  if (!res.ok) {
    const text = await res.text();
    console.error('GitHub write failed', path, res.status, text);
    throw new GithubError('GitHub error while saving data', 502, 'GITHUB');
  }
  return res.json();
}

/**
 * @param {any} env
 * @param {object} data
 * @param {string} message
 */
export async function writeBackup(env, data, message) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `data/backups/skyblock-coins-${stamp}.json`;
  await writeJsonFile(env, path, data, null, message);
  return path;
}

/**
 * Byte size of pretty-printed JSON (matches what we write).
 * @param {object} data
 */
export function jsonByteSize(data) {
  return new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n').length;
}

export async function githubFetch(env, url, init = {}) {
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

function encodePath(path) {
  return path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
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
