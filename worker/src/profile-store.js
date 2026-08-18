/**
 * Sharded storage for profile analytics snapshots (skill XP / net worth).
 * Completely separate from coin history in data/shards/.
 *
 * Layout:
 *   data/profile/manifest.json
 *   data/profile/shards/part-0001.json
 */

import {
  readJsonFile,
  writeJsonFile,
  jsonByteSize,
  GithubError,
  ConflictError,
} from './github.js';
import { normalizeProfileSnapshot } from './profile-analytics.js';
import { newEntryId } from './validation.js';

export const PROFILE_MANIFEST_PATH = 'data/profile/manifest.json';
export const PROFILE_SHARD_DIR = 'data/profile/shards';
export const PROFILE_SHARD_SOFT_LIMIT_BYTES = 700_000;

/**
 * @param {any} env
 */
export async function loadProfileStore(env) {
  const manifestFile = await readJsonFile(env, PROFILE_MANIFEST_PATH);
  if (!manifestFile.exists) {
    const shardPath = `${PROFILE_SHARD_DIR}/part-0001.json`;
    return {
      version: 1,
      entries: [],
      manifest: {
        version: 1,
        activeShard: shardPath,
        shards: [{ path: shardPath, entryCount: 0, bytesApprox: 2 }],
      },
      manifestSha: null,
      shardFiles: new Map([
        [
          shardPath,
          {
            data: { version: 1, entries: [] },
            sha: null,
            bytes: 2,
          },
        ],
      ]),
      empty: true,
    };
  }

  const manifest = normalizeManifest(manifestFile.data);
  const shardFiles = new Map();
  const allEntries = [];
  const seen = new Set();

  for (const meta of manifest.shards) {
    const file = await readJsonFile(env, meta.path);
    if (!file.exists) {
      throw new GithubError(`Missing profile shard: ${meta.path}`, 502, 'GITHUB');
    }
    const entries = normalizeSnapshotList(file.data?.entries);
    shardFiles.set(meta.path, {
      data: { version: Number(file.data?.version) || 1, entries },
      sha: file.sha,
      bytes: file.bytes,
    });
    for (const entry of entries) {
      if (!entry.id || seen.has(entry.id)) continue;
      seen.add(entry.id);
      allEntries.push(entry);
    }
  }

  return {
    version: Math.max(1, Number(manifestFile.data.version) || 1),
    entries: allEntries,
    manifest,
    manifestSha: manifestFile.sha,
    shardFiles,
    empty: false,
  };
}

/**
 * @param {any} env
 * @param {(store: any) => { entries: any[], version?: number, message: string } | Promise<any>} mutator
 */
export async function mutateProfileStore(env, mutator) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await loadProfileStore(env);
    const result = await mutator(structuredClone({
      version: store.version,
      entries: store.entries,
    }));
    const nextEntries = result.entries;
    const version = result.version ?? store.version;
    const message = result.message;
    try {
      await persistProfileEntries(env, store, nextEntries, version, message);
      return { version, entries: nextEntries };
    } catch (err) {
      if (err instanceof ConflictError && attempt === 0) continue;
      throw err;
    }
  }
  throw new ConflictError('Could not save profile snapshots after conflict');
}

/**
 * Append one snapshot (caller handles dedupe).
 * @param {any} env
 * @param {any} snapshot
 * @param {string} [message]
 */
export async function appendProfileSnapshot(env, snapshot, message) {
  const entry = {
    ...snapshot,
    id: snapshot.id || newEntryId(),
  };
  return mutateProfileStore(env, (s) => ({
    entries: [...s.entries, entry],
    version: s.version,
    message: message || `Profile snapshot ${entry.timestamp}`,
  }));
}

/**
 * @param {any[]} raw
 */
export function normalizeSnapshotList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const n = normalizeProfileSnapshot(item);
    if (!n || !n.id) continue;
    out.push(n);
  }
  return out;
}

/**
 * @param {any} data
 */
function normalizeManifest(data) {
  const shards = Array.isArray(data?.shards) ? data.shards : [];
  const activeShard =
    data?.activeShard ||
    shards[0]?.path ||
    `${PROFILE_SHARD_DIR}/part-0001.json`;
  return {
    version: Number(data?.version) || 1,
    activeShard,
    shards: shards.length
      ? shards
      : [{ path: activeShard, entryCount: 0, bytesApprox: 2 }],
  };
}

/**
 * @param {string[]} existingPaths
 */
export function nextProfileShardPath(existingPaths) {
  let max = 0;
  for (const p of existingPaths) {
    const m = String(p).match(/part-(\d+)\.json$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${PROFILE_SHARD_DIR}/part-${String(max + 1).padStart(4, '0')}.json`;
}

/**
 * @param {any[]} entries
 * @param {number} version
 */
export function packProfileEntriesIntoShards(entries, version = 1) {
  const packs = [];
  let current = [];
  let index = 1;

  const flush = () => {
    if (current.length === 0 && packs.length > 0) return;
    const path = `${PROFILE_SHARD_DIR}/part-${String(index).padStart(4, '0')}.json`;
    packs.push({ path, data: { version, entries: current } });
    index += 1;
    current = [];
  };

  for (const entry of entries) {
    const candidate = [...current, entry];
    if (
      current.length > 0 &&
      jsonByteSize({ version, entries: candidate }) >= PROFILE_SHARD_SOFT_LIMIT_BYTES
    ) {
      flush();
    }
    current.push(entry);
  }
  flush();
  if (packs.length === 0) {
    packs.push({
      path: `${PROFILE_SHARD_DIR}/part-0001.json`,
      data: { version, entries: [] },
    });
  }
  return packs;
}

async function persistProfileEntries(env, previous, nextEntries, version, message) {
  // Always redistribute for simplicity — snapshot volume is low vs coin history.
  const packs = packProfileEntriesIntoShards(nextEntries, version);
  const activePath = packs[packs.length - 1].path;

  for (const pack of packs) {
    const prevFile = previous.shardFiles.get(pack.path);
    await writeJsonFile(env, pack.path, pack.data, prevFile?.sha || null, message);
  }

  // Remove obsolete shards from manifest bookkeeping (leave orphan files harmless)
  const manifest = {
    version,
    activeShard: activePath,
    shards: packs.map((p) => ({
      path: p.path,
      entryCount: p.data.entries.length,
      bytesApprox: jsonByteSize(p.data),
    })),
  };
  await writeJsonFile(
    env,
    PROFILE_MANIFEST_PATH,
    manifest,
    previous.manifestSha,
    message
  );
}
