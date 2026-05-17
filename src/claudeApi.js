// Fetches real-time usage via two strategies, in priority order:
//
//   1. Electron BrowserWindow → claude.ai JSON API (full data: all rows)
//      Uses the sessionKey cookie stored in the Electron session.
//      The org ID comes from the lastActiveOrg cookie (NOT the bootstrap
//      memberships array, which returns a different org).
//
//   2. Inference API headers → api.anthropic.com (partial: 5h + 7d only)
//      Uses the Claude Code OAuth token with anthropic-beta: oauth-2025-04-20.
//      Falls back here when the stored session cookie is expired.

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
//
// Org ID resolution (in order):
//   1. lastActiveOrg cookie — fastest, set after the user has visited a workspace
//   2. /api/organizations probe — enumerates all orgs and tries each usage endpoint
//      until one returns data; works right after first login before any workspace visit
//
// Auth signal: sessionKey cookie (set immediately on login).
// lastActiveOrg is NOT used as the auth signal — it may not be set yet.

let fetcherWin   = null;
let fetcherReady = false;
let initPromise  = null;

function parseFetchResult(data) {
  if (!data || !data.five_hour) return null;
  // claude.ai returns utilization as 0–100 percentages
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

  fetcherWin = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  fetcherWin.on('closed', () => {
    fetcherWin   = null;
    fetcherReady = false;
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

// Read cookies from the Electron session directly — works for httpOnly cookies
// too, unlike document.cookie which only returns JS-accessible cookies.
async function getClaudeAiCookies() {
  if (!fetcherWin || fetcherWin.isDestroyed()) return [];
  try {
    return await fetcherWin.webContents.session.cookies.get({ url: 'https://claude.ai' });
  } catch { return []; }
}

// Probe each org from /api/organizations until we find one whose usage endpoint
// returns data. Used when lastActiveOrg cookie isn't set yet (right after login).
async function findOrgByProbe() {
  try {
    const orgs = await fetcherWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/organizations', { headers: { 'Accept': 'application/json' } });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })()
    `);
    if (!Array.isArray(orgs) || orgs.length === 0) return null;
    for (const org of orgs) {
      const id = org.id ?? org.uuid ?? null;
      if (!id) continue;
      await fetcherWin.webContents.executeJavaScript(`window.__probeId = ${JSON.stringify(id)};`);
      const data = await fetcherWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const r = await fetch('/api/organizations/' + window.__probeId + '/usage',
              { headers: { 'Accept': 'application/json' } });
            if (!r.ok) return null;
            const d = await r.json();
            return (d && d.five_hour) ? d : null;
          } catch { return null; }
        })()
      `);
      if (data) return { orgId: id, data };
    }
    return null;
  } catch { return null; }
}

async function fetchFromBrowserWindow() {
  if (!fetcherReady || !fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    const ok = await initPromise;
    if (!ok) return null;
  }
  if (!fetcherWin || fetcherWin.isDestroyed()) return null;

  try {
    const allCookies = await getClaudeAiCookies();
    const byName = Object.fromEntries(allCookies.map(c => [c.name, c.value]));

    // Require an active session
    if (!byName.sessionKey) return null;

    // Fast path: lastActiveOrg cookie is present
    if (byName.lastActiveOrg) {
      await fetcherWin.webContents.executeJavaScript(`window.__oi = ${JSON.stringify(byName.lastActiveOrg)};`);
      const data = await fetcherWin.webContents.executeJavaScript(`
        (async () => {
          try {
            const r = await fetch('/api/organizations/' + window.__oi + '/usage',
              { headers: { 'Accept': 'application/json' } });
            if (!r.ok) return null;
            return await r.json();
          } catch { return null; }
        })()
      `);
      const result = parseFetchResult(data);
      if (result) return result;
    }

    // Slow path: no lastActiveOrg yet — probe all orgs to find the right one
    const probed = await findOrgByProbe();
    return probed ? parseFetchResult(probed.data) : null;
  } catch { return null; }
}

// ── Strategy 2: Inference API headers (partial: 5h + 7d only) ────────────────
// Works whenever the OAuth token is valid, regardless of browser session.
// Headers are 0–1 fractions; convert to 0–100 to match the JSON API format.

function parseRateLimitHeaders(headers) {
  const h = name => headers[name.toLowerCase()] ?? null;
  const fiveHUtil   = h('anthropic-ratelimit-unified-5h-utilization');
  const sevenDUtil  = h('anthropic-ratelimit-unified-7d-utilization');
  const fiveHReset  = h('anthropic-ratelimit-unified-5h-reset');
  const sevenDReset = h('anthropic-ratelimit-unified-7d-reset');
  const overageSt   = h('anthropic-ratelimit-unified-overage-status');
  if (fiveHUtil == null && sevenDUtil == null) return null;
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
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(cached.lastUpdated).getTime() <= CACHE_MAX_MS) return cached;
  } catch {}

  if (_pending) return _pending;
  _pending = _doFetch().finally(() => { _pending = null; });
  return _pending;
}

async function _doFetch() {
  let full = null;
  try { full = await fetchFromBrowserWindow(); } catch {}
  if (full) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(full)); } catch {}
    return full;
  }

  const partial = await fetchFromInferenceHeaders();
  if (partial) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(partial)); } catch {}
  }
  return partial;
}

// Returns true if the Electron session has a valid claude.ai login (sessionKey
// present). Does NOT require lastActiveOrg — that cookie is only set after the
// user has visited a workspace, which may not have happened yet on first login.
async function hasBrowserSession() {
  if (!fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    await initPromise;
  }
  if (!fetcherWin || fetcherWin.isDestroyed()) return false;
  const cookies = await getClaudeAiCookies();
  return cookies.some(c => c.name === 'sessionKey');
}

// Opens the hidden BrowserWindow at a usable size so the user can log into
// claude.ai once. Detects login via sessionKey (set immediately on login —
// does not wait for lastActiveOrg). Cookies persist to disk so subsequent
// launches skip this entirely.
async function showAuthWindow(onLoggedIn) {
  if (!fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    await initPromise;
  }
  if (!fetcherWin || fetcherWin.isDestroyed()) return;

  fetcherWin.setSize(1000, 700);
  fetcherWin.center();
  fetcherWin.setAlwaysOnTop(true);
  fetcherWin.loadURL('https://claude.ai');
  fetcherWin.show();

  const poll = setInterval(async () => {
    if (!fetcherWin || fetcherWin.isDestroyed()) { clearInterval(poll); return; }
    const cookies = await getClaudeAiCookies();
    if (cookies.some(c => c.name === 'sessionKey')) {
      clearInterval(poll);
      fetcherWin.setAlwaysOnTop(false);
      fetcherWin.hide();
      fetcherReady = true;
      if (onLoggedIn) onLoggedIn();
    }
  }, 2000);
}

function clearCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

module.exports = { fetchUsage, showAuthWindow, hasBrowserSession, clearCache };
