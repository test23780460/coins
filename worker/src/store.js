/**
 * Sharded long-term storage for coin history.
 *
 * GitHub Contents API hard-limits file reads/writes around 1 MB.
 * We keep each shard under SHARD_SOFT_LIMIT_BYTES and rotate to a new
 * file when the active shard gets close. The API always returns the
 * merged history from every shard.
 *
 * Layout in the private data repo:
 *   data/manifest.json
 *   data/shards/part-0001.json
 *   data/shards/part-0002.json
 *   data/skyblock-coins.json   (legacy single file — migrated automatically)
 */

import {
  readJsonFile,
  writeJsonFile,
  writeBackup,
  jsonByteSize,
  GithubError,
  ConflictError,
} from './github.js';
import { normalizeDatabase } from './validation.js';

export const MANIFEST_PATH = 'data/manifest.json';
export const SHARD_DIR = 'data/shards';
export const LEGACY_PATH = 'data/skyblock-coins.json';

/** Rotate before hitting GitHub Contents API ~1 MB limit. */
export const SHARD_SOFT_LIMIT_BYTES = 700_000;

/**
 * @typedef {{ path: string, entryCount: number, bytesApprox: number }} ShardMeta
 * @typedef {{
 *   version: number,
 *   activeShard: string,
 *   shards: ShardMeta[],
 * }} Manifest
 * @typedef {{
 *   version: number,
 *   entries: Array<{ id: string, coins: number, timestamp: string }>,
 *   manifest: Manifest,
 *   manifestSha: string|null,
 *   shardFiles: Map<string, { data: { version: number, entries: any[] }, sha: string|null, bytes: number }>,
 *   legacySha: string|null,
 * }} Store
 */

/**
 * Load every shard and merge into one logical database.
 * @param {any} env
 * @returns {Promise<Store>}
 */
export async function loadStore(env) {
  const legacyPath = env.GITHUB_DATA_PATH || LEGACY_PATH;
  const manifestFile = await readJsonFile(env, MANIFEST_PATH);

  if (!manifestFile.exists) {
    const legacy = await readJsonFile(env, legacyPath);
    if (!legacy.exists) {
      throw new GithubError('Data file not found in private repository', 502, 'GITHUB');
    }
    const db = normalizeDatabase(legacy.data);
    const shardPath = `${SHARD_DIR}/part-0001.json`;
    /** @type {Manifest} */
    const manifest = {
      version: 2,
      activeShard: shardPath,
      shards: [
        {
          path: shardPath,
          entryCount: db.entries.length,
          bytesApprox: jsonByteSize({ version: db.version, entries: db.entries }),
        },
      ],
    };
    const shardFiles = new Map([
      [
        shardPath,
        {
          data: { version: db.version, entries: db.entries },
          sha: null,
          bytes: jsonByteSize({ version: db.version, entries: db.entries }),
        },
      ],
    ]);
    return {
      version: db.version,
      entries: db.entries,
      manifest,
      manifestSha: null,
      shardFiles,
      legacySha: legacy.sha,
      needsLegacyMigration: true,
      legacyPath,
    };
  }

  const manifest = normalizeManifest(manifestFile.data);
  const shardFiles = new Map();
  const allEntries = [];
  const seen = new Set();

  for (const meta of manifest.shards) {
    const file = await readJsonFile(env, meta.path);
    if (!file.exists) {
      throw new GithubError(`Missing shard file: ${meta.path}`, 502, 'GITHUB');
    }
    const db = normalizeDatabase(file.data);
    shardFiles.set(meta.path, {
      data: { version: db.version, entries: db.entries },
      sha: file.sha,
      bytes: file.bytes,
    });
    for (const entry of db.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      allEntries.push(entry);
    }
  }

  return {
    version: Math.max(2, Number(manifestFile.data.version) || 2),
    entries: allEntries,
    manifest,
    manifestSha: manifestFile.sha,
    shardFiles,
    legacySha: null,
    needsLegacyMigration: false,
    legacyPath,
  };
}

/**
 * Apply a mutation and persist shards + manifest.
 * @param {any} env
 * @param {(store: Store) => { entries: any[], version?: number, message: string } | Promise<{ entries: any[], version?: number, message: string }>} mutator
 */
export async function mutateStore(env, mutator) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await loadStore(env);
    const result = await mutator(structuredClone(store));
    const nextEntries = result.entries;
    const version = result.version ?? store.version;
    const message = result.message;

    try {
      await persistEntries(env, store, nextEntries, version, message);
      return { version, entries: nextEntries };
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      throw err;
    }
  }
  throw new ConflictError('Could not save after conflict');
}

/**
 * Replace entire history (import), with backup first.
 * @param {any} env
 * @param {{ version: number, entries: any[] }} next
 * @param {string} message
 */
export async function replaceStore(env, next, message) {
  const store = await loadStore(env);
  await writeBackup(
    env,
    { version: store.version, entries: store.entries },
    `Backup before import (${store.entries.length} entries)`
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = attempt === 0 ? store : await loadStore(env);
    try {
      await persistEntries(env, fresh, next.entries, next.version, message, {
        redistribute: true,
      });
      return { version: next.version, entries: next.entries };
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      throw err;
    }
  }
  throw new ConflictError('Could not save after conflict');
}

/**
 * Persist entries across shards, rotating when close to the soft limit.
 * @param {any} env
 * @param {Store} previous
 * @param {any[]} nextEntries
 * @param {number} version
 * @param {string} message
 * @param {{ redistribute?: boolean }} [opts]
 */
async function persistEntries(env, previous, nextEntries, version, message, opts = {}) {
  if (opts.redistribute || previous.needsLegacyMigration) {
    const packs = packEntriesIntoShards(nextEntries, version);
    await writeShardSet(env, previous, packs, version, message);
    return;
  }

  const nextById = new Map(nextEntries.map((e) => [e.id, e]));

  /** @type {Map<string, any[]>} */
  const shardEntryMap = new Map();
  for (const [path, file] of previous.shardFiles.entries()) {
    shardEntryMap.set(
      path,
      file.data.entries
        .filter((e) => nextById.has(e.id))
        .map((e) => ({ ...nextById.get(e.id) }))
    );
  }

  const knownIds = new Set();
  for (const list of shardEntryMap.values()) {
    for (const e of list) knownIds.add(e.id);
  }
  const brandNew = nextEntries.filter((e) => !knownIds.has(e.id));

  let activePath = previous.manifest.activeShard;
  if (!shardEntryMap.has(activePath)) {
    shardEntryMap.set(activePath, []);
  }

  for (const entry of brandNew) {
    const activeList = shardEntryMap.get(activePath) || [];
    const candidate = { version, entries: [...activeList, entry] };
    if (
      activeList.length > 0 &&
      jsonByteSize(candidate) >= SHARD_SOFT_LIMIT_BYTES
    ) {
      activePath = nextShardPath([...shardEntryMap.keys()]);
      shardEntryMap.set(activePath, [entry]);
    } else {
      activeList.push(entry);
      shardEntryMap.set(activePath, activeList);
    }
  }

  /** @type {Array<{ path: string, data: { version: number, entries: any[] } }>} */
  const finalPacks = [];
  const usedPaths = new Set();
  for (const [path, entries] of shardEntryMap.entries()) {
    // Drop emptied historical shards from the manifest; keep active even if empty.
    if (entries.length === 0 && path !== activePath) continue;
    finalPacks.push({ path, data: { version, entries } });
    usedPaths.add(path);
  }
  if (!usedPaths.has(activePath)) {
    finalPacks.push({ path: activePath, data: { version, entries: [] } });
  }

  let nextActive = activePath;
  const activePack = finalPacks.find((p) => p.path === activePath);
  if (activePack && jsonByteSize(activePack.data) >= SHARD_SOFT_LIMIT_BYTES) {
    nextActive = nextShardPath(finalPacks.map((p) => p.path));
    finalPacks.push({ path: nextActive, data: { version, entries: [] } });
  }

  await writeShardSet(env, previous, finalPacks, version, message, nextActive);
}

/**
 * @param {any[]} entries
 * @param {number} version
 */
export function packEntriesIntoShards(entries, version = 1) {
  const packs = [];
  let current = [];
  let index = 1;

  const flush = () => {
    if (current.length === 0 && packs.length > 0) return;
    const path = `${SHARD_DIR}/part-${String(index).padStart(4, '0')}.json`;
    packs.push({ path, data: { version, entries: current } });
    index += 1;
    current = [];
  };

  for (const entry of entries) {
    const candidate = [...current, entry];
    if (
      current.length > 0 &&
      jsonByteSize({ version, entries: candidate }) >= SHARD_SOFT_LIMIT_BYTES
    ) {
      flush();
    }
    current.push(entry);
  }
  flush();
  if (packs.length === 0) {
    packs.push({
      path: `${SHARD_DIR}/part-0001.json`,
      data: { version, entries: [] },
    });
  }
  return packs;
}

/**
 * @param {string[]} existingPaths
 */
export function nextShardPath(existingPaths) {
  let max = 0;
  for (const p of existingPaths) {
    const m = String(p).match(/part-(\d+)\.json$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${SHARD_DIR}/part-${String(max + 1).padStart(4, '0')}.json`;
}

/**
 * @param {any} env
 * @param {Store} previous
 * @param {Array<{ path: string, data: { version: number, entries: any[] } }>} packs
 * @param {number} version
 * @param {string} message
 * @param {string} [activeOverride]
 */
async function writeShardSet(env, previous, packs, version, message, activeOverride) {
  const activeShard =
    activeOverride || packs[packs.length - 1]?.path || `${SHARD_DIR}/part-0001.json`;

  /** @type {Manifest} */
  const manifest = {
    version: 2,
    activeShard,
    shards: packs.map((p) => ({
      path: p.path,
      entryCount: p.data.entries.length,
      bytesApprox: jsonByteSize(p.data),
    })),
  };

  // Write changed shards first, then manifest (source of truth last)
  for (const pack of packs) {
    const prev = previous.shardFiles.get(pack.path);
    const prevJson = prev ? JSON.stringify(prev.data) : null;
    const nextJson = JSON.stringify(pack.data);
    if (prev && prevJson === nextJson && prev.sha) continue;
    await writeJsonFile(
      env,
      pack.path,
      pack.data,
      prev?.sha || null,
      `${message} [${pack.path.split('/').pop()}]`
    );
  }

  // Drop shards removed from manifest? Leave orphan files (safe). Manifest defines truth.

  await writeJsonFile(
    env,
    MANIFEST_PATH,
    manifest,
    previous.manifestSha,
    `${message} [manifest]`
  );

  // After successful migration from legacy, leave legacy file untouched as extra backup.
  void previous.legacySha;
  void previous.needsLegacyMigration;
  void previous.legacyPath;
  void version;
}

/**
 * @param {any} raw
 * @returns {Manifest}
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new GithubError('Malformed manifest', 502, 'MALFORMED');
  }
  if (!Array.isArray(raw.shards) || raw.shards.length === 0) {
    throw new GithubError('Manifest has no shards', 502, 'MALFORMED');
  }
  const shards = raw.shards.map((s, i) => {
    if (!s || typeof s.path !== 'string') {
      throw new GithubError(`Manifest shard ${i} missing path`, 502, 'MALFORMED');
    }
    return {
      path: s.path,
      entryCount: Number(s.entryCount) || 0,
      bytesApprox: Number(s.bytesApprox) || 0,
    };
  });
  const activeShard =
    typeof raw.activeShard === 'string' && raw.activeShard
      ? raw.activeShard
      : shards[shards.length - 1].path;
  return {
    version: Number(raw.version) > 0 ? Number(raw.version) : 2,
    activeShard,
    shards,
  };
}

export { writeBackup, GithubError, ConflictError };
