// Fetches real-time usage from claude.ai via a hidden Electron BrowserWindow.
// Using a real Chromium window solves Cloudflare bot-detection transparently;
// raw Node.js https requests fail because their TLS fingerprint doesn't match.

const fs  = require('fs');
const os  = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── Firefox cookie reader ────────────────────────────────────────────────────

const COOKIE_PY = `
import sqlite3, shutil, os, json, tempfile, glob
base = os.path.expanduser("~/.config/mozilla/firefox")
if not os.path.exists(base): print("{}"); exit()
candidates = (
    glob.glob(os.path.join(base, "*.default-release")) +
    glob.glob(os.path.join(base, "*.default"))
)
db = None
for p in candidates:
    c = os.path.join(p, "cookies.sqlite")
    if os.path.exists(c):
        db = c
        break
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

let fetcherWin = null;
let fetcherOrgId = null;
let fetcherReady = false;
let initPromise = null;

function parseFetchResult(data) {
  if (!data || !data.five_hour) return null;
  return {
    source:      'api',
    session:     data.five_hour     ? { pct: data.five_hour.utilization     ?? 0, resetsAt: data.five_hour.resets_at     } : null,
    allModels:   data.seven_day     ? { pct: data.seven_day.utilization     ?? 0, resetsAt: data.seven_day.resets_at     } : null,
    claudeDesign: data.seven_day_omelette ? { pct: data.seven_day_omelette.utilization ?? 0, resetsAt: data.seven_day_omelette.resets_at } : null,
    extraUsage:  data.extra_usage
      ? { enabled: data.extra_usage.is_enabled, usedCredits: data.extra_usage.used_credits,
          pct: data.extra_usage.utilization, currency: data.extra_usage.currency,
          monthlyLimit: data.extra_usage.monthly_limit }
      : null,
    lastUpdated: new Date(),
  };
}

async function initFetcher() {
  const { BrowserWindow } = require('electron');

  const cookies = readFirefoxCookies();
  const sessionKey = cookies['sessionKey'];
  const orgId      = cookies['lastActiveOrg'];
  if (!sessionKey || !orgId) return false;
  fetcherOrgId = orgId;

  if (fetcherWin && !fetcherWin.isDestroyed() && fetcherReady) return true;

  if (fetcherWin && !fetcherWin.isDestroyed()) fetcherWin.destroy();
  fetcherReady = false;

  fetcherWin = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  fetcherWin.on('closed', () => { fetcherWin = null; fetcherReady = false; initPromise = null; });

  // Inject the session key so claude.ai knows who the user is
  await fetcherWin.webContents.session.cookies.set({
    url: 'https://claude.ai', name: 'sessionKey', value: sessionKey,
    domain: 'claude.ai', path: '/', secure: true, httpOnly: true, sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
  });

  // Load claude.ai — Chromium solves any Cloudflare JS challenge automatically
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 30000);
    fetcherWin.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    fetcherWin.loadURL('https://claude.ai');
  });

  fetcherReady = true;
  return true;
}

async function fetchUsage() {
  // Serialise init calls so we don't spin up multiple windows in parallel
  if (!fetcherReady || !fetcherWin || fetcherWin.isDestroyed()) {
    if (!initPromise) initPromise = initFetcher().finally(() => { initPromise = null; });
    const ok = await initPromise;
    if (!ok) return null;
  }

  if (!fetcherWin || fetcherWin.isDestroyed()) return null;

  try {
    const data = await fetcherWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/organizations/${fetcherOrgId}/usage', {
            headers: { 'Accept': 'application/json' }
          });
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      })()
    `);
    return parseFetchResult(data);
  } catch { return null; }
}

module.exports = { fetchUsage };
