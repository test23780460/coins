import {
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  getBearerToken,
} from './auth.js';
import {
  validateEntryInput,
  validateImportPayload,
  newEntryId,
  compactCoins,
  formatCommitDate,
} from './validation.js';
import { loadStore, mutateStore, replaceStore, GithubError, ConflictError } from './store.js';
import {
  runScheduledAutoLog,
  recordManualActivity,
  suppressAutoAfterDelete,
  loadAutomationState,
  buildAutomationStatus,
  isAutoSource,
  SOURCE_MANUAL,
} from './automation.js';
import { getAutoConfig, fetchLiquidCoins } from './coins-provider.js';

/** @type {Map<string, { count: number, reset: number }>} */
const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, env) && origin) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';

      if (path === '/api/health' && request.method === 'GET') {
        const cfg = getAutoConfig(env);
        return json(
          {
            ok: true,
            service: 'skyblock-coin-tracker',
            automation: {
              enabled: cfg.enabled,
              player: cfg.player,
              profile: cfg.profile,
              hasHypixelKey: Boolean(env.HYPIXEL_API_KEY),
              hasSkyCryptToken: Boolean(env.SKYCRYPT_API_TOKEN),
            },
          },
          200,
          cors
        );
      }

      if (path === '/api/login' && request.method === 'POST') {
        return withCors(await handleLogin(request, env), cors);
      }

      if (origin && !isOriginAllowed(origin, env)) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }

      if (path === '/api/logout' && request.method === 'POST') {
        await requireAuth(request, env);
        return json({ ok: true }, 200, cors);
      }

      if (path === '/api/entries' && request.method === 'GET') {
        await requireAuth(request, env);
        return withCors(await handleList(env), cors);
      }

      if (path === '/api/entries' && request.method === 'POST') {
        await requireAuth(request, env);
        return withCors(await handleCreate(request, env), cors);
      }

      const entryMatch = path.match(/^\/api\/entries\/([^/]+)$/);
      if (entryMatch && request.method === 'PUT') {
        await requireAuth(request, env);
        return withCors(await handleUpdate(request, env, decodeURIComponent(entryMatch[1])), cors);
      }
      if (entryMatch && request.method === 'DELETE') {
        await requireAuth(request, env);
        return withCors(await handleDelete(env, decodeURIComponent(entryMatch[1])), cors);
      }

      if (path === '/api/import' && request.method === 'POST') {
        await requireAuth(request, env);
        return withCors(await handleImport(request, env), cors);
      }

      if (path === '/api/automation/status' && request.method === 'GET') {
        await requireAuth(request, env);
        return withCors(await handleAutomationStatus(env), cors);
      }

      if (path === '/api/automation/probe' && request.method === 'POST') {
        await requireAuth(request, env);
        return withCors(await handleAutomationProbe(env), cors);
      }

      if (path === '/api/automation/run' && request.method === 'POST') {
        await requireAuth(request, env);
        return withCors(await handleAutomationRun(env), cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return withCors(errorResponse(err), cors);
    }
  },

  /**
   * Cloudflare Cron Trigger — check 24h inactivity; create at most one auto entry.
   * @param {ScheduledController} controller
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduledAutoLog(env)
        .then((result) => {
          console.log('auto-log result', JSON.stringify(result));
        })
        .catch((err) => {
          console.error('auto-log crashed', err);
        })
    );
  },
};

async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return json(
      { error: 'Too many login attempts. Try again later.', code: 'RATE_LIMIT' },
      429
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const password = body?.password;
  if (typeof password !== 'string' || !password) {
    recordFailure(ip);
    return json({ error: 'Authentication failed', code: 'UNAUTHORIZED' }, 401);
  }

  if (!env.AUTH_PASSWORD_HASH || !env.SESSION_SECRET) {
    console.error('Auth secrets missing');
    return json({ error: 'Server authentication not configured', code: 'CONFIG' }, 500);
  }

  const ok = await verifyPassword(password, env.AUTH_PASSWORD_HASH);
  if (!ok) {
    recordFailure(ip);
    return json({ error: 'Authentication failed', code: 'UNAUTHORIZED' }, 401);
  }

  clearFailures(ip);
  const token = await createSessionToken(env.SESSION_SECRET);
  return json({ token, expiresInDays: 14 });
}

async function requireAuth(request, env) {
  if (!env.SESSION_SECRET) {
    throw Object.assign(new Error('Server authentication not configured'), {
      status: 500,
      code: 'CONFIG',
    });
  }
  const token = getBearerToken(request);
  const session = await verifySessionToken(token, env.SESSION_SECRET);
  if (!session) {
    throw Object.assign(new Error('Session expired or invalid'), {
      status: 401,
      code: 'UNAUTHORIZED',
    });
  }
  return session;
}

async function handleList(env) {
  const store = await loadStore(env);
  return json({ version: store.version, entries: store.entries });
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = validateEntryInput(body);
  if (!parsed.ok) return json({ error: parsed.error, code: 'VALIDATION' }, 400);

  const next = await mutateStore(env, async (store) => {
    const entries = [
      ...store.entries,
      {
        id: newEntryId(),
        coins: parsed.coins,
        timestamp: parsed.timestamp,
        source: SOURCE_MANUAL,
        ...(parsed.note ? { note: parsed.note } : {}),
      },
    ];
    return {
      entries,
      version: store.version,
      message: `Add balance: ${compactCoins(parsed.coins)}`,
    };
  });

  await recordManualActivity(env, parsed.timestamp);
  return json(next);
}

async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = validateEntryInput(body);
  if (!parsed.ok) return json({ error: parsed.error, code: 'VALIDATION' }, 400);

  let becameManual = false;
  const next = await mutateStore(env, async (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw Object.assign(new Error('Entry not found'), { status: 404, code: 'NOT_FOUND' });
    }
    const prev = store.entries[idx];
    const updated = {
      id: prev.id,
      coins: parsed.coins,
      timestamp: parsed.timestamp,
    };
    if (parsed.note) updated.note = parsed.note;
    // Preserve auto source metadata when editing an automatic entry
    if (isAutoSource(prev)) {
      updated.source = prev.source;
      if (prev.meta) updated.meta = prev.meta;
    } else {
      updated.source = SOURCE_MANUAL;
      becameManual = true;
    }
    const entries = store.entries.map((e, i) => (i === idx ? updated : e));
    return {
      entries,
      version: store.version,
      message: `Edit balance entry: ${formatCommitDate(parsed.timestamp)}`,
    };
  });

  if (becameManual || !isAutoSource(next.entries.find((e) => e.id === id))) {
    // Editing a manual entry (or timestamp) resets inactivity via manual activity stamp
    const edited = next.entries.find((e) => e.id === id);
    if (edited && !isAutoSource(edited)) {
      await recordManualActivity(env, edited.timestamp);
    }
  }
  return json(next);
}

async function handleDelete(env, id) {
  let removed = null;
  const next = await mutateStore(env, async (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw Object.assign(new Error('Entry not found'), { status: 404, code: 'NOT_FOUND' });
    }
    removed = store.entries[idx];
    const entries = store.entries.filter((e) => e.id !== id);
    return {
      entries,
      version: store.version,
      message: `Delete balance entry: ${formatCommitDate(removed.timestamp)}`,
    };
  });

  if (removed && isAutoSource(removed)) {
    await suppressAutoAfterDelete(env);
  }
  return json(next);
}

async function handleImport(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = validateImportPayload(body);
  if (!parsed.ok) return json({ error: parsed.error, code: 'VALIDATION' }, 400);

  try {
    const next = await replaceStore(
      env,
      { version: parsed.version, entries: parsed.entries },
      `Import backup: ${parsed.entries.length} entries`
    );
    return json(next);
  } catch (err) {
    if (err instanceof ConflictError) {
      return json(
        { error: 'Concurrent update conflict — retry import', code: 'CONFLICT' },
        409
      );
    }
    throw err;
  }
}

async function handleAutomationStatus(env) {
  const store = await loadStore(env);
  const { data } = await loadAutomationState(env);
  return json(buildAutomationStatus(env, store.entries, data));
}

async function handleAutomationProbe(env) {
  // Read-only: fetch current liquid coins without writing history.
  try {
    const fetched = await fetchLiquidCoins(env);
    return json({
      ok: true,
      provider: fetched.provider,
      player: fetched.player,
      profile: fetched.profileCuteName || fetched.profile,
      coins: fetched.coins,
      purse: fetched.purse,
      bank: fetched.bank,
      personalBank: fetched.personalBank,
      fetchedAt: fetched.fetchedAt,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err.message || 'Probe failed',
        code: err.code || 'PROBE',
        details: err.details || undefined,
      },
      502
    );
  }
}

/**
 * Manual trigger of the same auto-check the hourly cron uses.
 * Always probes live coins first so the button can verify Hypixel even when not eligible to write.
 */
async function handleAutomationRun(env) {
  let probe = null;
  try {
    const fetched = await fetchLiquidCoins(env);
    probe = {
      ok: true,
      provider: fetched.provider,
      player: fetched.player,
      profile: fetched.profileCuteName || fetched.profile,
      coins: fetched.coins,
      purse: fetched.purse,
      bank: fetched.bank,
      personalBank: fetched.personalBank,
      fetchedAt: fetched.fetchedAt,
    };
  } catch (err) {
    return json(
      {
        ok: false,
        probe: {
          ok: false,
          error: err.message || 'Probe failed',
          code: err.code || 'PROBE',
          details: err.details || undefined,
        },
        run: null,
      },
      502
    );
  }

  const run = await runScheduledAutoLog(env);
  return json({
    ok: true,
    probe,
    run,
  });
}

function errorResponse(err) {
  if (err instanceof GithubError || err instanceof ConflictError) {
    return json({ error: err.message, code: err.code }, err.status || 502);
  }
  const status = err.status || 500;
  const code = err.code || 'ERROR';
  if (status >= 500) console.error(err);
  return json({ error: err.message || 'Server error', code }, status);
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function allowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

function corsHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (now > entry.reset) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.reset) {
    loginAttempts.set(ip, { count: 1, reset: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(ip) {
  loginAttempts.delete(ip);
}
