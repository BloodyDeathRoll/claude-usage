const vscode = require('vscode');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const https  = require('https');
const { spawn } = require('child_process');
const { getUsage } = require('./src/usageParser');

// ── OAuth fetch via inference API headers ─────────────────────────────────────
// Reads the Claude Code OAuth token and pings api.anthropic.com/v1/messages.
// Usage percentages come back in rate-limit response headers — no browser,
// no cookies, no Cloudflare bypass needed.

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

// ── Detail panel (webview) ────────────────────────────────────────────────────
// Self-contained VS Code webview panel — no Electron overlay, no npm install,
// works on every machine the moment the extension is installed.

let panelInstance = null;

function openDetailPanel() {
  if (panelInstance) {
    panelInstance.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'claudeUsageDetail',
    'Claude Usage',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: false }
  );

  panelInstance = panel;
  panel.onDidDispose(() => { panelInstance = null; });
  panel.webview.html = getDetailHtml(currentData);
}

function updatePanel() {
  if (panelInstance) panelInstance.webview.html = getDetailHtml(currentData);
}

function getDetailHtml(data) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function colorClass(pct) {
    if (pct == null) return 'normal';
    if (pct >= 85) return 'error';
    if (pct >= 60) return 'warn';
    return 'normal';
  }

  function barHtml(pct) {
    const cls = colorClass(pct);
    const w   = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
    return `<div class="bar-track"><div class="bar-fill ${cls}" style="width:${w}%"></div></div>`;
  }

  function fmtReset(resetsAt) {
    if (!resetsAt) return '';
    const ms = new Date(resetsAt).getTime() - Date.now();
    if (ms <= 0) return 'resets soon';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) { const d = Math.floor(h / 24); return `resets in ${d}d ${h % 24}h`; }
    if (h > 0)   return `resets in ${h}h ${String(m).padStart(2, '0')}m`;
    return `resets in ${m}m`;
  }

  function rowHtml(label, slot) {
    if (!slot) return '';
    const pct = slot.pct;
    const cls = colorClass(pct);
    const val = pct != null ? `${Math.round(pct)}%` : '—';
    const rst = fmtReset(slot.resetsAt);
    return `<div class="row">
  <div class="row-hd"><span>${esc(label)}</span><span class="val ${cls}">${val}</span></div>
  ${barHtml(pct)}
  ${rst ? `<div class="rst">${esc(rst)}</div>` : ''}
</div>`;
  }

  function fmtAgo(date) {
    if (!date) return '';
    const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 5)    return 'just now';
    if (s < 60)   return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  const css = `
* { box-sizing:border-box; margin:0; padding:0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px 24px;
  max-width: 440px;
}
h1 { font-size:1.1em; font-weight:600; margin-bottom:2px; }
.sub { font-size:.82em; color:var(--vscode-descriptionForeground); margin-bottom:22px; }
.sec { margin-bottom:20px; }
.sec-t {
  font-size:.72em; text-transform:uppercase; letter-spacing:.06em;
  color:var(--vscode-descriptionForeground);
  margin-bottom:10px; padding-bottom:5px;
  border-bottom:1px solid var(--vscode-panel-border,#333);
}
.row { margin-bottom:10px; }
.row-hd { display:flex; justify-content:space-between; margin-bottom:5px; font-size:.9em; }
.val { font-weight:600; font-variant-numeric:tabular-nums; min-width:3.2em; text-align:right; }
.val.warn  { color:var(--vscode-statusBarItem-warningForeground,#c8a400); }
.val.error { color:var(--vscode-statusBarItem-errorForeground,#f14c4c); }
.bar-track { height:4px; background:var(--vscode-editorWidget-border,#454545); border-radius:2px; overflow:hidden; }
.bar-fill { height:100%; border-radius:2px; }
.bar-fill.normal { background:var(--vscode-progressBar-background,#0078d4); }
.bar-fill.warn   { background:var(--vscode-statusBarItem-warningForeground,#c8a400); }
.bar-fill.error  { background:var(--vscode-statusBarItem-errorForeground,#f14c4c); }
.rst { font-size:.78em; color:var(--vscode-descriptionForeground); margin-top:3px; }
.footer { font-size:.78em; color:var(--vscode-descriptionForeground); margin-top:8px; }
`;

  if (!data) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${css}</style></head>
<body><h1>Claude Usage</h1><div class="sub">Loading…</div></body></html>`;
  }

  const sourceLabel = data.source === 'api' ? 'Live data' : 'Local estimate';
  const ago = fmtAgo(data.lastUpdated);

  const hasWeekly = data.allModels || data.sonnetOnly || data.claudeDesign;
  const weeklyHtml = hasWeekly ? `<div class="sec">
  <div class="sec-t">Weekly Limits</div>
  ${rowHtml('All models (7d)', data.allModels)}
  ${data.sonnetOnly   ? rowHtml('Sonnet only',    data.sonnetOnly)   : ''}
  ${data.claudeDesign ? rowHtml('Claude Design',  data.claudeDesign) : ''}
</div>` : '';

  const ex = data.extraUsage;
  const extraHtml = (ex && (ex.enabled || (ex.usedCredits != null && ex.usedCredits > 0))) ? (() => {
    const credits = ex.usedCredits != null ? `$${Number(ex.usedCredits).toFixed(2)}` : '$0.00';
    const limit   = ex.monthlyLimit != null ? ` / $${Number(ex.monthlyLimit).toFixed(2)}` : '';
    return `<div class="sec">
  <div class="sec-t">Extra Usage</div>
  <div class="row">
    <div class="row-hd"><span>Credits used</span><span class="val">${esc(credits + limit)}</span></div>
    ${ex.pct != null ? barHtml(ex.pct) : ''}
  </div>
</div>`;
  })() : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${css}</style>
</head>
<body>
<h1>Claude Usage</h1>
<div class="sub">${esc(sourceLabel)} · updated ${esc(ago)}</div>

<div class="sec">
  <div class="sec-t">Current Session (5h)</div>
  ${rowHtml('Session usage', data.session)}
</div>

${weeklyHtml}
${extraHtml}

<div class="footer">Refreshes every 15 s · Run "Claude Usage: Refresh Now" to force update</div>
</body>
</html>`;
}

// ── External Electron overlay (optional) ──────────────────────────────────────
// Launched via "Claude Usage: Open External Overlay" from the command palette.
// Not required for any core functionality — the webview panel above covers
// everything the overlay shows, without any external dependencies.

function getOverlayDir() {
  const cfg = vscode.workspace.getConfiguration('claudeUsage').get('overlayPath');
  if (cfg) return cfg;

  const home = os.homedir();
  const candidates = [
    // Linux / macOS
    path.join(home, 'Projects', 'claude-usage'),
    path.join(home, 'Projects', 'usage'),
    path.join(home, 'Documents', 'Projects', 'claude-usage'),
    // Windows standard Documents
    path.join(home, 'Documents', 'Projects', 'claude-usage'),
    // Windows OneDrive-redirected Documents (default on Windows 11)
    path.join(home, 'OneDrive', 'Documents', 'Projects', 'claude-usage'),
    path.join(home, 'OneDrive', 'Documents', 'Projects', 'usage'),
    path.join(home, 'OneDrive', 'Projects', 'claude-usage'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'main.js'))) return p;
  }
  return null;
}

function launchExternalOverlay() {
  const OVERLAY_DIR = getOverlayDir();
  if (!OVERLAY_DIR) {
    vscode.window.showWarningMessage(
      'Claude Usage: overlay repo not found. Set "claudeUsage.overlayPath" in VS Code settings to the folder containing main.js.',
      'Open Settings'
    ).then(sel => {
      if (sel === 'Open Settings')
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsage.overlayPath');
    });
    return;
  }

  // npm creates electron.cmd on Windows; Unix gets a plain shell shim.
  const binName       = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  const OVERLAY_ELECTRON = path.join(OVERLAY_DIR, 'node_modules', '.bin', binName);

  if (!fs.existsSync(OVERLAY_ELECTRON)) {
    vscode.window.showWarningMessage(
      `Claude Usage: Electron not installed in ${OVERLAY_DIR}. Run "npm install" in that folder first.`,
      'Copy Command'
    ).then(sel => {
      if (sel === 'Copy Command')
        vscode.env.clipboard.writeText(`cd "${OVERLAY_DIR}" && npm install`);
    });
    return;
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(OVERLAY_ELECTRON, [OVERLAY_DIR], {
    detached: true,
    shell: process.platform === 'win32', // .cmd files require a shell on Windows
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: OVERLAY_DIR,
    env: childEnv,
  });
  const logPath = path.join(os.tmpdir(), 'claude-usage-overlay.log');
  let output = '';
  child.stdout?.on('data', d => { output += d.toString(); });
  child.stderr?.on('data', d => { output += d.toString(); });
  child.on('error', err => {
    try { fs.writeFileSync(logPath, `spawn error: ${err.stack || err.message}\n`); } catch {}
    vscode.window.showErrorMessage(`Claude Usage: failed to launch overlay — ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      try { fs.writeFileSync(logPath, output || '<no output>'); } catch {}
      vscode.window.showErrorMessage(
        `Claude Usage: overlay exited (code=${code}). Log: ${logPath}`
      );
    }
  });
  child.unref();
}

// ── Overlay config (shared with the Electron overlay) ────────────────────────

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
  statusItem.command = 'claudeUsage.openPanel';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeUsage.openPanel',           openDetailPanel),
    vscode.commands.registerCommand('claudeUsage.openExternalOverlay', launchExternalOverlay),
    vscode.commands.registerCommand('claudeUsage.refresh',             () => refresh(true)),
    { dispose: () => clearInterval(timer) },
    { dispose: () => { try { watcher?.close(); } catch {} } },
  );

  refresh(false);
  timer = setInterval(() => refresh(false), POLL_MS);
  startClaudeWatcher();
}

// Watch ~/.claude/projects/ for JSONL writes — refreshes the moment a Claude
// session starts producing data instead of waiting up to 15 s for the poll.
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
    watcher.on('error', () => {}); // swallow — poll still covers us
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

let currentData   = null;
let lastApiResult = null;
let lastApiTime   = 0;
const API_MEM_CACHE_MS = 2 * 60 * 1000;

async function refresh(manual) {
  const cfg = vscode.workspace.getConfiguration('claudeUsage');

  // 1. Overlay cache — full per-model data, written by the Electron overlay
  const cached = readCache();
  if (cached) { render(cached); return; }

  // 2. OAuth inference headers — works anywhere Claude Code is installed.
  //    Kept in memory only so we never overwrite the overlay's richer cache.
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
  currentData = data;

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

  updatePanel();
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
