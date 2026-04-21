// Reads claude.ai session cookies from Firefox or Chrome.
// Uses a Python subprocess to parse SQLite — no native npm deps needed.
// Chrome on Linux uses the well-known 'peanuts' default key for decryption.

const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PYTHON_SCRIPT = String.raw`
import sqlite3, shutil, os, json, tempfile, glob, sys, platform

def firefox_db():
    s = platform.system()
    if s == 'Linux':
        base = os.path.expanduser("~/.config/mozilla/firefox")
    elif s == 'Darwin':
        base = os.path.expanduser("~/Library/Application Support/Firefox")
    elif s == 'Windows':
        base = os.path.join(os.environ.get('APPDATA',''), 'Mozilla','Firefox')
    else:
        return None
    candidates = (
        glob.glob(os.path.join(base,"*.default-release")) +
        glob.glob(os.path.join(base,"*.default"))
    )
    for p in candidates:
        db = os.path.join(p,"cookies.sqlite")
        if os.path.exists(db): return db
    return None

def chrome_db():
    s = platform.system()
    if s == 'Linux':
        paths = [
            "~/.config/google-chrome/Default/Cookies",
            "~/.config/chromium/Default/Cookies",
        ]
    elif s == 'Darwin':
        paths = ["~/Library/Application Support/Google/Chrome/Default/Cookies"]
    elif s == 'Windows':
        local = os.environ.get('LOCALAPPDATA','')
        paths = [os.path.join(local,'Google','Chrome','User Data','Default','Cookies')]
    else:
        return None
    for p in paths:
        db = os.path.expanduser(p)
        if os.path.exists(db): return db
    return None

def read_sqlite(db, query):
    tmp = tempfile.mktemp(suffix=".sqlite")
    shutil.copy2(db, tmp)
    try:
        conn = sqlite3.connect(tmp)
        rows = conn.execute(query).fetchall()
        conn.close()
        return rows
    finally:
        try: os.unlink(tmp)
        except: pass

def decrypt_chrome(enc):
    if not enc: return ""
    if not (enc[:3] in (b'v10',b'v11')): return enc.decode('utf-8','ignore')
    try:
        from Crypto.Cipher import AES
        import hashlib
        key = hashlib.pbkdf2_hmac('sha1',b'peanuts',b'saltysalt',1,dklen=16)
        raw = AES.new(key, AES.MODE_CBC, IV=b' '*16).decrypt(enc[3:])
        return raw[:-raw[-1]].decode('utf-8','ignore')
    except:
        return ""

# --- Firefox (plaintext) ---
cookies = {}
ff = firefox_db()
if ff:
    try:
        rows = read_sqlite(ff, "SELECT name,value FROM moz_cookies WHERE host LIKE '%claude.ai%'")
        cookies = dict(rows)
    except: pass

# --- Chrome (encrypted, Linux peanuts key) ---
if not cookies.get('sessionKey'):
    ch = chrome_db()
    if ch:
        try:
            rows = read_sqlite(ch, "SELECT name,value,encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'")
            ch_cookies = {}
            for name,val,enc in rows:
                ch_cookies[name] = val if val else decrypt_chrome(enc)
            if ch_cookies.get('sessionKey'):
                cookies = ch_cookies
        except: pass

print(json.dumps(cookies))
`;

let scriptPath = null;

function getScriptPath() {
  if (!scriptPath) {
    scriptPath = path.join(os.tmpdir(), 'claude_usage_vsc_cookies.py');
    fs.writeFileSync(scriptPath, PYTHON_SCRIPT);
  }
  return scriptPath;
}

/** Returns { sessionKey, lastActiveOrg, cf_clearance, ... } or null */
function readCookies() {
  try {
    const out = execSync(`python3 "${getScriptPath()}"`, {
      timeout: 6000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(out.toString().trim());
    return data.sessionKey ? data : null;
  } catch {
    return null;
  }
}

/** True if Python 3 is available */
function hasPython() {
  try { execSync('python3 --version', { timeout: 3000, stdio: 'pipe' }); return true; }
  catch { return false; }
}

module.exports = { readCookies, hasPython };
