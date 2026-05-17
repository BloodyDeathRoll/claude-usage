const vscode = require('vscode');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const https  = require('https');
const { spawn } = require('child_process');
const { getUsage } = require('./src/usageParser');

// ── OAuth fetch via inference API headers ─────────────────────────────────────

const CLAUDE_CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

function readOAuthToken() {
  try {
    const oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDS_PATH, 'utf8'))?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch { return null; }
}

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
      enabled: overageSt === 'allowed',
      usedCredits: null, monthlyLimit: null, pct: null, currency: null,
    } : null,
    lastUpdated: new Date(),
  };
}

async function fetchWithOAuth() {
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

// ── Overlay management ────────────────────────────────────────────────────────
// The overlay source files are bundled inside this extension (overlay-src/).
// On first launch they are extracted to ~/.claude-usage-overlay and
// `npm install` is run automatically. No manual steps required on any OS.

const OVERLAY_BUNDLED_SRC = path.join(__dirname, 'overlay-src');
const OVERLAY_MANAGED_DIR = path.join(os.homedir(), '.claude-usage-overlay');

function getOverlayDir() {
  // 1. Explicit user override
  const cfg = vscode.workspace.getConfiguration('claudeUsage').get('overlayPath');
  if (cfg && fs.existsSync(path.join(cfg, 'main.js'))) return cfg;

  // 2. Auto-managed install location (written by this extension)
  if (fs.existsSync(path.join(OVERLAY_MANAGED_DIR, 'main.js'))) return OVERLAY_MANAGED_DIR;

  // 3. Dev / manual clone locations (checked for convenience on dev machines)
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Projects', 'claude-usage'),
    path.join(home, 'Projects', 'usage'),
    path.join(home, 'Documents', 'Projects', 'claude-usage'),
    path.join(home, 'OneDrive', 'Documents', 'Projects', 'claude-usage'),
    path.join(home, 'OneDrive', 'Documents', 'Projects', 'usage'),
    path.join(home, 'OneDrive', 'Projects', 'claude-usage'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'main.js'))) return p;
  }

  // 4. Fall through to managed dir (will be set up by ensureOverlayReady)
  return OVERLAY_MANAGED_DIR;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function electronBinPath(dir) {
  const name = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(dir, 'node_modules', '.bin', name);
}

// npm/npm.cmd location — prefer the one on PATH, but also probe beside node
function npmCommand() {
  if (process.platform === 'win32') return 'npm.cmd';
  return 'npm';
}

function runNpmInstall(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand(), ['install'], {
      cwd: dir,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(new Error(`npm not found: ${err.message}`)));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed (code ${code})\n${stderr.slice(-500)}`));
    });
  });
}

// Returns the overlay directory, setting it up automatically if needed.
// Shows a VS Code progress notification during the first-time npm install.
async function ensureOverlayReady() {
  const overlayDir = getOverlayDir();

  // Extract bundled source files if the managed dir doesn't exist yet
  const needsExtract = overlayDir === OVERLAY_MANAGED_DIR &&
                       !fs.existsSync(path.join(overlayDir, 'main.js'));
  if (needsExtract) {
    copyDirSync(OVERLAY_BUNDLED_SRC, overlayDir);
  }

  // Install npm deps if Electron binary is missing
  if (!fs.existsSync(electronBinPath(overlayDir))) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title:    'Claude Usage: setting up overlay (first time, ~1 min)…',
      cancellable: false,
    }, () => runNpmInstall(overlayDir));
  }

  return overlayDir;
}

// ── Overlay launch ────────────────────────────────────────────────────────────

async function openOverlay() {
  let overlayDir;
  try {
    overlayDir = await ensureOverlayReady();
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Usage: overlay setup failed — ${err.message}`);
    return;
  }

  const electronBin = electronBinPath(overlayDir);
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const child = spawn(electronBin, [overlayDir], {
    detached: true,
    shell:    process.platform === 'win32',
    stdio:    ['ignore', 'pipe', 'pipe'],
    cwd:      overlayDir,
    env:      childEnv,
  });

  const logPath = path.join(os.tmpdir(), 'claude-usage-overlay.log');
  let output = '';
  child.stdout?.on('data', d => { output += d.toString(); });
  child.stderr?.on('data', d => { output += d.toString(); });
  child.on('error', err => {
    try { fs.writeFileSync(logPath, `spawn error: ${err.stack}\n`); } catch {}
    vscode.window.showErrorMessage(`Claude Usage: failed to launch overlay — ${err.message}`);
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      try { fs.writeFileSync(logPath, output || '<no output>'); } catch {}
      vscode.window.showErrorMessage(`Claude Usage: overlay exited (code=${code}). Log: ${logPath}`);
    }
  });
  child.unref();
}

// ── Overlay config (shared settings file) ────────────────────────────────────

const OVERLAY_CONFIG_PATH = path.join(os.homedir(), '.claude-overlay-config.json');

function readOverlayConfig() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

// ── Polling ───────────────────────────────────────────────────────────────────

const POLL_MS           = 15_000;
const WATCH_DEBOUNCE_MS = 750;
const WATCH_MIN_GAP_MS  = 2_000;

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

let statusItem;
let timer;
let watcher;
let watchDebounce;
let lastWatchRefresh = 0;

// ── Activation ────────────────────────────────────────────────────────────────

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'claudeUsage.openOverlay';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeUsage.openOverlay', openOverlay),
    vscode.commands.registerCommand('claudeUsage.refresh',     () => refresh(true)),
    { dispose: () => clearInterval(timer) },
    { dispose: () => { try { watcher?.close(); } catch {} } },
  );

  refresh(false);
  timer = setInterval(() => refresh(false), POLL_MS);
  startClaudeWatcher();
}

function startClaudeWatcher() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    try { fs.mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true }); } catch { return; }
  }
  try {
    watcher = fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename?.toString().endsWith('.jsonl')) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        const now = Date.now();
        if (now - lastWatchRefresh < WATCH_MIN_GAP_MS) return;
        lastWatchRefresh = now;
        refresh(false);
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => {});
  } catch {}
}

// ── Data ──────────────────────────────────────────────────────────────────────

const CACHE_PATH       = path.join(os.homedir(), '.claude-usage-cache.json');
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(data.lastUpdated).getTime() <= CACHE_MAX_AGE_MS) return data;
  } catch {}
  return null;
}

let lastApiResult = null;
let lastApiTime   = 0;
const API_MEM_CACHE_MS = 2 * 60 * 1000;

async function refresh(manual) {
  const cfg = vscode.workspace.getConfiguration('claudeUsage');

  // 1. Overlay cache — full per-model data
  const cached = readCache();
  if (cached) { render(cached); return; }

  // 2. OAuth inference headers — kept in memory so we never overwrite the
  //    overlay's richer cache with the partial (no Sonnet/Design) result
  const now = Date.now();
  if (manual || !lastApiResult || (now - lastApiTime) > API_MEM_CACHE_MS) {
    lastApiResult = await fetchWithOAuth();
    lastApiTime   = now;
  }
  if (lastApiResult) { render(lastApiResult); return; }

  // 3. Local JSONL fallback
  const overlayCfg = readOverlayConfig();
  const localData  = await getUsage({
    sessionLimitTokens: cfg.get('sessionLimitTokens') || overlayCfg?.sessionLimitTokens || 320000,
    weeklyLimitTokens:  cfg.get('weeklyLimitTokens')  || overlayCfg?.weeklyLimitTokens  || 461000,
    weeklyModelLimits:  cfg.get('weeklyModelLimits')  || overlayCfg?.weeklyModelLimits  || { sonnet: 436000, haiku: 25000, opus: 0 },
  });

  if (!localData) {
    statusItem.text    = '$(cloud-offline) Claude: —';
    statusItem.color   = undefined;
    statusItem.tooltip = 'Claude Usage: no data yet.\nMake sure Claude Code has been used recently.';
    return;
  }

  render(localData);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function fmtVal(pct, tokens) {
  if (pct != null)    return `${Math.round(pct)}%`;
  if (tokens != null) return fmt(tokens);
  return '—';
}

function render(data) {
  const sPct = data.session?.pct   ?? null;
  const wPct = data.allModels?.pct ?? null;
  const ex   = data.extraUsage;
  const ePct = (ex?.enabled || ex?.pct != null) ? (ex?.pct ?? 0) : null;

  const parts = [
    `Session: ${fmtVal(sPct, data.session?.tokens)}`,
    `Weekly: ${fmtVal(wPct, data.allModels?.tokens)}`,
  ];
  if (ePct != null) parts.push(`Extra: ${Math.round(ePct)}%`);

  statusItem.text    = `$(cloud) ${parts.join(' · ')}`;
  statusItem.color   = themeColor(Math.max(sPct ?? 0, wPct ?? 0, ePct ?? 0));
  statusItem.tooltip = buildTooltip(data);
}

function themeColor(pct) {
  if (pct >= 85) return new vscode.ThemeColor('statusBarItem.errorForeground');
  if (pct >= 60) return new vscode.ThemeColor('statusBarItem.warningForeground');
  return undefined;
}

function usageRow(label, slot) {
  if (!slot) return '';
  const pct = slot.pct;
  const bar = miniBar(pct);
  const val = pct != null ? `**${Math.round(pct)}%**` : fmt(slot.tokens ?? 0);
  let line  = `${label} ${bar} ${val}`;
  if (slot.resetsAt) {
    const ms = new Date(slot.resetsAt).getTime() - Date.now();
    line += `  *(resets ${ms > 0 ? fmtCountdown(ms) : 'soon'})*`;
  }
  return line + '\n\n';
}

function buildTooltip(data) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;

  const sourceLabel = data.source === 'api' ? 'live' : 'local estimate';
  md.appendMarkdown(`### Claude Usage *(${sourceLabel})*\n\n`);

  md.appendMarkdown(usageRow('**Current session**', data.session));

  if (data.allModels || data.sonnetOnly || data.claudeDesign) {
    md.appendMarkdown('**Weekly limits**\n\n');
    md.appendMarkdown(usageRow('↳ All models',    data.allModels));
    md.appendMarkdown(usageRow('↳ Sonnet only',   data.sonnetOnly));
    md.appendMarkdown(usageRow('↳ Claude Design', data.claudeDesign));
  }

  const ex = data.extraUsage;
  if (ex && (ex.enabled || (ex.usedCredits != null && ex.usedCredits > 0))) {
    const credits = ex.usedCredits != null ? `$${Number(ex.usedCredits).toFixed(2)}` : '$0.00';
    const limit   = ex.monthlyLimit != null ? ` / $${Number(ex.monthlyLimit).toFixed(2)}` : '';
    md.appendMarkdown(`**Extra usage** ${miniBar(ex.pct)} ${credits}${limit}\n\n`);
  }

  md.appendMarkdown(`---\n*${fmtAgo(data.lastUpdated)}*`);
  return md;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function miniBar(pct) {
  if (pct == null) return '`░░░░░░░░░░`';
  const filled = Math.round(Math.min(100, pct) / 10);
  return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '`';
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtCountdown(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function fmtAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Deactivation ──────────────────────────────────────────────────────────────

function deactivate() { clearInterval(timer); }

module.exports = { activate, deactivate };
