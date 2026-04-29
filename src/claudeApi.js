// Fetches real-time usage via two strategies, in priority order:
//
//   1. Electron BrowserWindow → claude.ai JSON API (full data: all rows)
//      Uses the sessionKey cookie stored in the Electron session.
//      No Bearer token is sent — the cookie authenticates the request.
//
//   2. Inference API headers  → api.anthropic.com (partial: 5h + 7d only)
//      Uses the Claude Code OAuth token with anthropic-beta: oauth-2025-04-20.
//      Falls back to this when the stored session cookie is expired.

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_PATH   = path.join(os.homedir(), '.claude-usage-cache.json');
const CACHE_MAX_MS = 2 * 60 * 1000;

// ── Shared helpers ────────────────────────────────────────────────────────────

function readOAuthToken() {
  try {
    const oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'))?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch { return null; }
}

// ── Strategy 1: BrowserWindow + claude.ai JSON API (full data) ────────────────
// claude.ai's /api/organizations/{id}/usage returns all rate-limit slots
// including per-model (sonnet, design). Auth via stored session cookie.

let fetcherWin   = null;
let fetcherReady = false;
let fetcherOrgId = null;
let initPromise  = null;

function parseFetchResult(data) {
  if (!data || !data.five_hour) return null;
  // claude.ai returns utilization as 0–100 percentages already
  const slot = s => s ? { pct: s.utilization ?? 0, resetsAt: s.resets_at ?? null } : null;
  return {
    source:           'api',
    session:          slot(data.five_hour),
    allModels:        slot(data.seven_day),
    sonnetOnly:       slot(data.seven_day_sonnet),
    claudeDesign:     slot(data.seven_day_cowork) ?? slot(data.seven_day_omelette),
    dailyRoutineRuns: data.iguana_necktie ?? null,
    extraUsage: data.extra_usage ? {
      enabled:      data.extra_usage.is_enabled,
      usedCredits:  data.extra_usage.used_credits,
      monthlyLimit: data.extra_usage.monthly_limit,
      pct:          data.extra_usage.utilization ?? null,
      currency:     data.extra_usage.currency,
    } : null,
    lastUpdated: new Date(),
  };
}

async function initFetcher() {
  const { BrowserWindow } = require('electron');

  if (fetcherWin && !fetcherWin.isDestroyed() && fetcherReady) return true;
  if (fetcherWin && !fetcherWin.isDestroyed()) fetcherWin.destroy();
  fetcherReady = false;
  fetcherOrgId = null;

  fetcherWin = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  fetcherWin.on('closed', () => {
    fetcherWin   = null;
    fetcherReady = false;
    fetcherOrgId = null;
    initPromise  = null;
  });

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 30000);
    fetcherWin.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    fetcherWin.loadURL('https://claude.ai');
  });

  fetcherReady = true;
  return true;
}

async function fetchFromBrowserWindow() {
  if (!fetcherReady || !fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    const ok = await initPromise;
    if (!ok) return null;
  }
  if (!fetcherWin || fetcherWin.isDestroyed()) return null;

  try {
    // Resolve org ID via /api/bootstrap — NO Bearer token, rely on stored sessionKey cookie
    if (!fetcherOrgId) {
      fetcherOrgId = await fetcherWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const r = await fetch('/api/bootstrap', { headers: { 'Accept': 'application/json' } });
            if (!r.ok) return null;
            const d = await r.json();
            if (!d?.account) return null;
            return d.account.memberships?.[0]?.organization?.uuid
                ?? d.account.memberships?.[0]?.organization?.id
                ?? d.organizations?.[0]?.uuid
                ?? d.organizations?.[0]?.id
                ?? null;
          } catch { return null; }
        })()
      `);
    }
    if (!fetcherOrgId) return null;

    await fetcherWin.webContents.executeJavaScript(
      `window.__oi = ${JSON.stringify(fetcherOrgId)};`
    );

    const data = await fetcherWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/organizations/' + window.__oi + '/usage', {
            headers: { 'Accept': 'application/json' }
          });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })()
    `);

    return parseFetchResult(data);
  } catch {
    fetcherOrgId = null;
    return null;
  }
}

// ── Strategy 2: Inference API headers (partial: 5h + 7d only) ────────────────
// Works whenever the OAuth token is valid, regardless of browser session.

function parseRateLimitHeaders(headers) {
  const h = name => headers[name.toLowerCase()] ?? null;
  const fiveHUtil   = h('anthropic-ratelimit-unified-5h-utilization');
  const sevenDUtil  = h('anthropic-ratelimit-unified-7d-utilization');
  const fiveHReset  = h('anthropic-ratelimit-unified-5h-reset');
  const sevenDReset = h('anthropic-ratelimit-unified-7d-reset');
  const overageSt   = h('anthropic-ratelimit-unified-overage-status');
  if (fiveHUtil == null && sevenDUtil == null) return null;
  // Headers are 0–1 fractions; convert to 0–100 percentages to match the JSON API format
  const slot = (utilStr, resetStr) => utilStr == null ? null : {
    pct:      parseFloat(utilStr) * 100,
    resetsAt: resetStr ? new Date(parseInt(resetStr, 10) * 1000).toISOString() : null,
  };
  return {
    source:       'api',
    session:      slot(fiveHUtil,  fiveHReset),
    allModels:    slot(sevenDUtil, sevenDReset),
    sonnetOnly:   null,
    claudeDesign: null,
    extraUsage: overageSt != null ? {
      enabled:      overageSt === 'allowed',
      usedCredits:  null,
      monthlyLimit: null,
      pct:          null,
      currency:     null,
    } : null,
    lastUpdated: new Date(),
  };
}

async function fetchFromInferenceHeaders() {
  const token = readOAuthToken();
  if (!token) return null;

  const body = Buffer.from(JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  }));

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Authorization':     `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'oauth-2025-04-20',
        'Content-Type':      'application/json',
        'Content-Length':    body.length,
      },
      timeout: 10000,
    }, (res) => {
      res.resume();
      resolve(parseRateLimitHeaders(res.headers));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

let _pending = null;

async function fetchUsage() {
  // Serve from cache if still fresh
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(cached.lastUpdated).getTime() <= CACHE_MAX_MS) return cached;
  } catch {}

  if (_pending) return _pending;
  _pending = _doFetch().finally(() => { _pending = null; });
  return _pending;
}

async function _doFetch() {
  // Try full data first (BrowserWindow + stored session cookie)
  let full = null;
  try { full = await fetchFromBrowserWindow(); } catch {}
  if (full) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(full)); } catch {}
    return full;
  }

  // Session expired or BrowserWindow unavailable — fall back to inference headers
  const partial = await fetchFromInferenceHeaders();
  if (partial) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(partial)); } catch {}
  }
  return partial;
}

module.exports = { fetchUsage };
