// Fetches real-time usage from claude.ai via a hidden Electron BrowserWindow.
// Chromium's network stack bypasses Cloudflare bot-detection transparently.
//
// Auth priority:
//   1. Claude Code OAuth token  (~/.claude/.credentials.json)  — no browser needed
//   2. Firefox session cookie   (fallback if credentials missing/expired)

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── OAuth credentials reader ──────────────────────────────────────────────────

const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');

function readOAuthToken() {
  try {
    const oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'))?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch { return null; }
}

// ── Firefox cookie reader (fallback) ─────────────────────────────────────────

const COOKIE_PY = `
import sqlite3, shutil, os, json, tempfile, glob

def find_db():
    bases = [
        os.path.expanduser("~/.config/mozilla/firefox"),
        os.path.expanduser("~/snap/firefox/common/.mozilla/firefox"),
        os.path.expanduser("~/.var/app/org.mozilla.firefox/.mozilla/firefox"),
    ]
    for base in bases:
        for p in glob.glob(os.path.join(base,"*.default-release")) + glob.glob(os.path.join(base,"*.default")):
            c = os.path.join(p, "cookies.sqlite")
            if os.path.exists(c): return c
    return None

db = find_db()
if not db: print("{}"); exit()
tmp = tempfile.mktemp(suffix=".sqlite")
shutil.copy2(db, tmp)
try:
    conn = sqlite3.connect(tmp)
    rows = dict(conn.execute(
        "SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'"
    ).fetchall())
    conn.close()
    print(json.dumps(rows))
finally:
    try: os.unlink(tmp)
    except: pass
`;

let cookiePyPath = null;

function getCookiePyPath() {
  if (!cookiePyPath) {
    cookiePyPath = path.join(os.tmpdir(), 'claude_usage_cookies.py');
    fs.writeFileSync(cookiePyPath, COOKIE_PY);
  }
  return cookiePyPath;
}

function readFirefoxCookies() {
  try {
    const out = execSync(`python3 ${getCookiePyPath()}`, { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out.toString().trim());
  } catch { return {}; }
}

// ── Hidden BrowserWindow fetcher ─────────────────────────────────────────────

let fetcherWin   = null;
let fetcherToken = null;   // OAuth Bearer token (null = using cookie auth)
let fetcherOrgId = null;   // resolved on first fetch when using OAuth
let fetcherReady = false;
let initPromise  = null;

function slot(s) {
  return s ? { pct: s.utilization ?? 0, resetsAt: s.resets_at ?? null } : null;
}

function parseFetchResult(data) {
  if (!data || !data.five_hour) return null;
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
      pct:          data.extra_usage.utilization,
      currency:     data.extra_usage.currency,
    } : null,
    lastUpdated: new Date(),
  };
}

async function initFetcher() {
  const { BrowserWindow } = require('electron');

  // ── Determine auth method ────────────────────────────────────────────────
  let cookieToInject = null;

  const oauthToken = readOAuthToken();
  if (oauthToken) {
    fetcherToken = oauthToken;
    fetcherOrgId = null;  // resolved lazily via /api/bootstrap on first fetchUsage()
  } else {
    // Fall back to Firefox session cookie
    const cookies   = readFirefoxCookies();
    const sessionKey = cookies['sessionKey'];
    const orgId      = cookies['lastActiveOrg'];
    if (!sessionKey || !orgId) return false;
    fetcherToken     = null;
    fetcherOrgId     = orgId;
    cookieToInject   = sessionKey;
  }

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

  if (cookieToInject) {
    await fetcherWin.webContents.session.cookies.set({
      url: 'https://claude.ai', name: 'sessionKey', value: cookieToInject,
      domain: 'claude.ai', path: '/', secure: true, httpOnly: true, sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
    });
  }

  // Load claude.ai — Chromium resolves any Cloudflare JS challenge automatically
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 30000);
    fetcherWin.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    fetcherWin.loadURL('https://claude.ai');
  });

  fetcherReady = true;
  return true;
}

async function fetchUsage() {
  if (!fetcherReady || !fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    const ok = await initPromise;
    if (!ok) return null;
  }

  if (!fetcherWin || fetcherWin.isDestroyed()) return null;

  try {
    // Pass auth context into page so we don't embed secrets in template literals
    await fetcherWin.webContents.executeJavaScript(
      `window.__ct = ${JSON.stringify(fetcherToken ?? null)};` +
      `window.__oi = ${JSON.stringify(fetcherOrgId ?? null)};`
    );

    // Resolve orgId via /api/bootstrap when using OAuth (only needed once)
    if (!fetcherOrgId) {
      const orgId = await fetcherWin.webContents.executeJavaScript(`
        (async () => {
          if (!window.__ct) return null;
          try {
            const r = await fetch('/api/bootstrap', {
              headers: { 'Authorization': 'Bearer ' + window.__ct, 'Accept': 'application/json' }
            });
            if (!r.ok) return null;
            const d = await r.json();
            // Try several known paths for the organisation UUID
            return d?.account?.memberships?.[0]?.organization?.uuid
                ?? d?.account?.memberships?.[0]?.organization?.id
                ?? d?.organizations?.[0]?.uuid
                ?? d?.organizations?.[0]?.id
                ?? null;
          } catch { return null; }
        })()
      `);
      if (!orgId) return null;
      fetcherOrgId = orgId;
      await fetcherWin.webContents.executeJavaScript(`window.__oi = ${JSON.stringify(orgId)};`);
    }

    const data = await fetcherWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const headers = { 'Accept': 'application/json' };
          if (window.__ct) headers['Authorization'] = 'Bearer ' + window.__ct;
          const r = await fetch('/api/organizations/' + window.__oi + '/usage', { headers });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })()
    `);
    return parseFetchResult(data);
  } catch { return null; }
}

module.exports = { fetchUsage };
