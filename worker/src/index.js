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
        return json({ ok: true, service: 'skyblock-coin-tracker' }, 200, cors);
      }

      if (path === '/api/login' && request.method === 'POST') {
        return withCors(await handleLogin(request, env), cors);
      }

      // All routes below require allowed origin for browser calls
      // (non-browser tools may omit Origin)
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

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return withCors(errorResponse(err), cors);
    }
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
      },
    ];
    return {
      entries,
      version: store.version,
      message: `Add balance: ${compactCoins(parsed.coins)}`,
    };
  });
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

  const next = await mutateStore(env, async (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw Object.assign(new Error('Entry not found'), { status: 404, code: 'NOT_FOUND' });
    }
    const entries = store.entries.map((e, i) =>
      i === idx
        ? { ...e, coins: parsed.coins, timestamp: parsed.timestamp }
        : e
    );
    return {
      entries,
      version: store.version,
      message: `Edit balance entry: ${formatCommitDate(parsed.timestamp)}`,
    };
  });
  return json(next);
}

async function handleDelete(env, id) {
  const next = await mutateStore(env, async (store) => {
    const idx = store.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw Object.assign(new Error('Entry not found'), { status: 404, code: 'NOT_FOUND' });
    }
    const removed = store.entries[idx];
    const entries = store.entries.filter((e) => e.id !== id);
    return {
      entries,
      version: store.version,
      message: `Delete balance entry: ${formatCommitDate(removed.timestamp)}`,
    };
  });
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
