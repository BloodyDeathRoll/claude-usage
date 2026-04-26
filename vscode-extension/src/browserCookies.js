// Reads claude.ai session cookies from Firefox / Chrome / Brave / Edge / Vivaldi / Opera.
// Pure Node — no Python, no native modules. SQLite is read with sql.js (WASM).
//
// Decryption per platform:
//   Firefox            — plaintext (every OS)
//   Chromium / Linux   — AES-128-CBC, key = PBKDF2('peanuts','saltysalt',1,sha1,16)
//   Chromium / macOS   — AES-128-CBC, key = PBKDF2(<keychain pw>,'saltysalt',1003,sha1,16)
//   Chromium / Windows — AES-256-GCM, key = DPAPI-unwrapped key from `Local State`

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto       = require('crypto');
const { execSync } = require('child_process');

let SQL = null;
async function getSQL() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const distDir   = path.dirname(require.resolve('sql.js'));
  SQL = await initSqlJs({ locateFile: f => path.join(distDir, f) });
  return SQL;
}

// ── SQLite helper ────────────────────────────────────────────────────────────
// Always copy to a temp file before opening — the source DB may be locked by
// the running browser, and a copy is also safer (we never write to the original).
async function querySqlite(dbPath, query) {
  const tmp = path.join(
    os.tmpdir(),
    `claude_usage_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`
  );
  let buf;
  try {
    fs.copyFileSync(dbPath, tmp);
    buf = fs.readFileSync(tmp);
  } catch {
    try { buf = fs.readFileSync(dbPath); }
    catch { return []; }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  const sql = await getSQL();
  const db  = new sql.Database(buf);
  try {
    const res = db.exec(query);
    return res.length ? res[0].values : [];
  } catch {
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

// ── Profile / DB locations ───────────────────────────────────────────────────
function firefoxProfileBases() {
  const p = os.platform();
  if (p === 'linux') return [
    path.join(os.homedir(), '.mozilla', 'firefox'),
    path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
  ];
  if (p === 'darwin') return [
    path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles'),
  ];
  if (p === 'win32') return [
    path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles'),
  ];
  return [];
}

function findFirefoxDbs() {
  const out = [];
  for (const base of firefoxProfileBases()) {
    let entries;
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const e of entries) {
      if (!/\.default(-release|-esr)?$/.test(e) && !/\.default-/.test(e)) continue;
      const db = path.join(base, e, 'cookies.sqlite');
      if (fs.existsSync(db)) out.push(db);
    }
  }
  return out;
}

// Returns [{ browser, userDataDir }] for every Chromium-based browser we know about.
function chromiumLocations() {
  const p = os.platform();
  if (p === 'linux') {
    const cfg = path.join(os.homedir(), '.config');
    return [
      { browser: 'Chrome',    userDataDir: path.join(cfg, 'google-chrome') },
      { browser: 'Chrome',    userDataDir: path.join(cfg, 'google-chrome-beta') },
      { browser: 'Chrome',    userDataDir: path.join(cfg, 'google-chrome-unstable') },
      { browser: 'Chromium',  userDataDir: path.join(cfg, 'chromium') },
      { browser: 'Brave',     userDataDir: path.join(cfg, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Microsoft Edge', userDataDir: path.join(cfg, 'microsoft-edge') },
      { browser: 'Vivaldi',   userDataDir: path.join(cfg, 'vivaldi') },
      { browser: 'Opera',     userDataDir: path.join(cfg, 'opera') },
    ];
  }
  if (p === 'darwin') {
    const sup = path.join(os.homedir(), 'Library', 'Application Support');
    return [
      { browser: 'Chrome',         userDataDir: path.join(sup, 'Google', 'Chrome') },
      { browser: 'Chromium',       userDataDir: path.join(sup, 'Chromium') },
      { browser: 'Brave',          userDataDir: path.join(sup, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Microsoft Edge', userDataDir: path.join(sup, 'Microsoft Edge') },
      { browser: 'Vivaldi',        userDataDir: path.join(sup, 'Vivaldi') },
    ];
  }
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      { browser: 'Chrome',         userDataDir: path.join(local, 'Google',        'Chrome',        'User Data') },
      { browser: 'Chromium',       userDataDir: path.join(local, 'Chromium',                       'User Data') },
      { browser: 'Brave',          userDataDir: path.join(local, 'BraveSoftware', 'Brave-Browser','User Data') },
      { browser: 'Microsoft Edge', userDataDir: path.join(local, 'Microsoft',     'Edge',          'User Data') },
      { browser: 'Vivaldi',        userDataDir: path.join(local, 'Vivaldi',                        'User Data') },
    ];
  }
  return [];
}

// Cookies file moved from Default/Cookies → Default/Network/Cookies in newer Chromium.
function findChromiumCookiesDb(userDataDir) {
  for (const sub of ['Default']) {
    for (const tail of [['Network', 'Cookies'], ['Cookies']]) {
      const p = path.join(userDataDir, sub, ...tail);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ── Key derivation ───────────────────────────────────────────────────────────
function deriveLinuxKey() {
  return crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

const MAC_KEYCHAIN_ACCOUNTS = {
  'Chrome':         'Chrome',
  'Chromium':       'Chromium',
  'Brave':          'Brave',
  'Microsoft Edge': 'Microsoft Edge',
  'Vivaldi':        'Vivaldi',
};

function deriveMacKey(browser) {
  const account = MAC_KEYCHAIN_ACCOUNTS[browser];
  if (!account) return null;
  // Match by account AND service name. The service is "<Browser> Safe Storage".
  // Without -s we'd match any Keychain entry that happens to share the account.
  const service = `${account} Safe Storage`;
  let pw;
  try {
    pw = execSync(
      `security find-generic-password -w -a ${JSON.stringify(account)} -s ${JSON.stringify(service)}`,
      { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString().trim();
  } catch { return null; }
  if (!pw) return null;
  return crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

// Windows: pull `os_crypt.encrypted_key` from `Local State`, strip the 'DPAPI'
// magic, unprotect via PowerShell (no native module needed).
function getWindowsMasterKey(userDataDir) {
  const localState = path.join(userDataDir, 'Local State');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(localState, 'utf8')); }
  catch { return null; }
  const b64 = parsed?.os_crypt?.encrypted_key;
  if (!b64) return null;

  const blob = Buffer.from(b64, 'base64');
  if (blob.length < 5 || blob.slice(0, 5).toString() !== 'DPAPI') return null;
  const dpapi = blob.slice(5);

  const tmp = path.join(os.tmpdir(), `claude_usage_dpapi_${process.pid}_${Date.now()}.bin`);
  try {
    fs.writeFileSync(tmp, dpapi);
    // PowerShell single-quoted strings are literal — backslashes don't need
    // escaping. Double up any embedded single quotes (none expected in a
    // tmpdir path, but be safe).
    const psPath = `'${tmp.replace(/'/g, "''")}'`;
    const psSrc =
      `Add-Type -AssemblyName System.Security; ` +
      `$b = [IO.File]::ReadAllBytes(${psPath}); ` +
      `$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); ` +
      `[Convert]::ToBase64String($d)`;
    const encoded = Buffer.from(psSrc, 'utf16le').toString('base64');
    const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    return Buffer.from(out, 'base64');
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── Cookie value decryption ──────────────────────────────────────────────────
function decryptCbc(enc, key) {
  if (!enc || enc.length < 3) return '';
  const prefix = enc.slice(0, 3).toString('utf8');
  // Only v10/v11 are CBC. v20 (Chrome ≥127 app-bound encryption) and any
  // unknown prefix → skip; returning the raw bytes would masquerade as a
  // valid cookie and produce a 403 from the API.
  if (prefix !== 'v10' && prefix !== 'v11') return '';
  const ct = enc.slice(3);
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}

// Chrome on Windows >= ~80: v10 prefix, AES-256-GCM, [3..15)=nonce, last 16 = tag.
// Chromium on Linux v11 also uses GCM in some builds, but the existing extension's
// reference behaviour (and what the page actually uses) is CBC there. Stick with
// platform branching: Windows = GCM, others = CBC.
function decryptGcm(enc, key) {
  if (!enc || enc.length < 3 + 12 + 16) return '';
  const prefix = enc.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') return '';
  const nonce = enc.slice(3, 15);
  const ct    = enc.slice(15, enc.length - 16);
  const tag   = enc.slice(enc.length - 16);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ── Per-browser readers ──────────────────────────────────────────────────────
async function readFirefoxCookies() {
  // Firefox `moz_cookies.expiry` is UNIX seconds; 0 means session cookie.
  const nowSec = Math.floor(Date.now() / 1000);
  for (const db of findFirefoxDbs()) {
    const rows = await querySqlite(
      db,
      `SELECT name, value FROM moz_cookies
       WHERE host LIKE '%claude.ai%'
         AND (expiry = 0 OR expiry > ${nowSec})`
    );
    if (!rows.length) continue;
    const cookies = {};
    for (const [name, value] of rows) cookies[name] = value;
    if (cookies.sessionKey) return cookies;
  }
  return null;
}

async function readChromiumCookies() {
  const platform = os.platform();
  // Chromium `cookies.expires_utc` is microseconds since 1601-01-01 UTC.
  // Convert UNIX millis → Chrome epoch micros: (ms + 11644473600000) * 1000.
  const nowChromeUs = (Date.now() + 11644473600000) * 1000;
  for (const { browser, userDataDir } of chromiumLocations()) {
    if (!fs.existsSync(userDataDir)) continue;
    const dbPath = findChromiumCookiesDb(userDataDir);
    if (!dbPath) continue;

    let key = null;
    if      (platform === 'linux')  key = deriveLinuxKey();
    else if (platform === 'darwin') key = deriveMacKey(browser);
    else if (platform === 'win32')  key = getWindowsMasterKey(userDataDir);
    if (!key) continue;

    const rows = await querySqlite(
      dbPath,
      `SELECT name, value, encrypted_value FROM cookies
       WHERE host_key LIKE '%claude.ai%'
         AND (expires_utc = 0 OR expires_utc > ${nowChromeUs})`
    );
    if (!rows.length) continue;

    const cookies = {};
    for (const [name, value, encVal] of rows) {
      let v = value;
      if (!v && encVal) {
        const buf = Buffer.isBuffer(encVal) ? encVal : Buffer.from(encVal);
        v = platform === 'win32' ? decryptGcm(buf, key) : decryptCbc(buf, key);
      }
      cookies[name] = v;
    }
    if (cookies.sessionKey) return cookies;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────
/** Returns { sessionKey, lastActiveOrg, cf_clearance, ... } or null */
async function readCookies() {
  try {
    const ff = await readFirefoxCookies();
    if (ff && ff.sessionKey) return ff;
  } catch {}
  try {
    const ch = await readChromiumCookies();
    if (ch && ch.sessionKey) return ch;
  } catch {}
  return null;
}

module.exports = { readCookies };
