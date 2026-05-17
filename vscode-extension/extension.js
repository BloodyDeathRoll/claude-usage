const vscode = require('vscode');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const https  = require('https');
const { spawn } = require('child_process');
const { getUsage } = require('./src/usageParser');

// ── OAuth direct fetch via inference API headers ──────────────────────────────
// api.anthropic.com/v1/messages accepts the Claude Code OAuth token with the
// oauth-2025-04-20 beta header. Rate-limit utilization comes back in the
// response headers — no browser session or Cloudflare bypass needed.

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
  // Headers are 0–1 fractions; renderer/tooltip expects 0–100 percentages.
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

function getOverlayDir() {
  const cfg = vscode.workspace.getConfiguration('claudeUsage').get('overlayPath');
  if (cfg) return cfg;
  for (const candidate of ['claude-usage', 'usage']) {
    const p = path.join(os.homedir(), 'Projects', candidate);
    if (fs.existsSync(path.join(p, 'main.js'))) return p;
  }
  return path.join(os.homedir(), 'Projects', 'claude-usage');
}

function openOverlay() {
  const OVERLAY_DIR      = getOverlayDir();
  const OVERLAY_ELECTRON = path.join(OVERLAY_DIR, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(OVERLAY_ELECTRON)) {
    vscode.window.showWarningMessage(`Claude Usage overlay not found at ${OVERLAY_DIR}.`);
    return;
  }
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(OVERLAY_ELECTRON, [OVERLAY_DIR], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: OVERLAY_DIR,
    env: childEnv,
  });
  const logPath = path.join(os.tmpdir(), 'claude-usage-overlay.log');
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdout.on('data', d => { stderr += d.toString(); });
  child.on('error', err => {
    fs.writeFileSync(logPath, `spawn error: ${err.stack || err.message}\n`);
    vscode.window.showErrorMessage(`Claude Usage: failed to spawn Electron — ${err.message} (log: ${logPath})`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      try { fs.writeFileSync(logPath, stderr || '<no output>'); } catch {}
      vscode.window.showErrorMessage(
        `Claude Usage: Electron exited (code=${code}, signal=${signal}). Log: ${logPath}`
      );
    }
  });
  child.unref();
}

const OVERLAY_CONFIG_PATH = path.join(os.homedir(), '.claude-overlay-config.json');

function readOverlayConfig() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

const POLL_MS         = 15_000;
const WATCH_DEBOUNCE_MS = 750;
const WATCH_MIN_GAP_MS  = 2_000;  // don't refresh more than once per 2s from the watcher

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

let statusItem;
let timer;
let watcher;
let watchDebounce;
let lastWatchRefresh = 0;
let lastSource = null;   // 'api' | 'local' | null

// ── Activation ────────────────────────────────────────────────────────────────

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'claudeUsage.openOverlay';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeUsage.openOverlay', openOverlay),
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    { dispose: () => clearInterval(timer) },
    { dispose: () => { try { watcher?.close(); } catch {} } },
  );

  refresh(false);
  timer = setInterval(() => refresh(false), POLL_MS);
  startClaudeWatcher();
}

// Watch ~/.claude/projects/ for JSONL writes so we refresh the moment a
// `claude` session starts producing data — instead of waiting up to 15s for
// the next poll. Heavily debounced because JSONL grows on every message.
function startClaudeWatcher() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    try { fs.mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true }); } catch { return; }
  }
  try {
    watcher = fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.endsWith('.jsonl')) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        const now = Date.now();
        if (now - lastWatchRefresh < WATCH_MIN_GAP_MS) return;
        lastWatchRefresh = now;
        refresh(false);
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', () => {});  // swallow — poll still runs
  } catch {
    // recursive fs.watch not supported on this platform/Node — fall through;
    // the 15s poll still covers us.
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), '.claude-usage-cache.json');
const CACHE_MAX_AGE_MS = 10 * 60 * 1000; // use overlay's full data for up to 10 minutes

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(data.lastUpdated).getTime() <= CACHE_MAX_AGE_MS) return data;
  } catch {}
  return null;
}

let lastApiResult = null;
let lastApiTime   = 0;
const API_MEM_CACHE_MS = 2 * 60 * 1000; // keep in-memory API result for 2 minutes

async function refresh(manual) {
  const cfg = vscode.workspace.getConfiguration('claudeUsage');

  // 1. Prefer the cache written by the overlay app — full per-model data
  const cached = readCache();
  if (cached) { render(cached); return; }

  // 2. Direct OAuth fetch (works without a browser session).
  //    Result is kept in memory only — never written to disk so we don't
  //    overwrite the overlay's richer cache with partial (no Sonnet/Design) data.
  const now = Date.now();
  if (manual || !lastApiResult || (now - lastApiTime) > API_MEM_CACHE_MS) {
    lastApiResult = await fetchWithOAuth();
    lastApiTime   = now;
  }
  if (lastApiResult) {
    render(lastApiResult);
    return;
  }

  // 3. Fall back to JSONL local counting
  const overlayCfg = readOverlayConfig();
  const localData = await getUsage({
    sessionLimitTokens: cfg.get('sessionLimitTokens') || overlayCfg?.sessionLimitTokens || 320000,
    weeklyLimitTokens:  cfg.get('weeklyLimitTokens')  || overlayCfg?.weeklyLimitTokens  || 461000,
    weeklyModelLimits:  cfg.get('weeklyModelLimits')  || overlayCfg?.weeklyModelLimits  || { sonnet: 436000, haiku: 25000, opus: 0 },
  });

  if (!localData) {
    statusItem.text    = '$(cloud-offline) Claude: —';
    statusItem.color   = undefined;
    statusItem.tooltip = 'Claude Usage: no data found.\nMake sure Claude Code has been used recently.';
    return;
  }

  render(localData);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function fmtVal(pct, tokens) {
  if (pct != null) return `${Math.round(pct)}%`;
  if (tokens != null) return fmt(tokens);
  return '—';
}

function render(data) {
  lastSource = data.source;

  const sPct = data.session?.pct    ?? null;
  const wPct = data.allModels?.pct  ?? null;
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

function usageRow(label, slot, extra) {
  if (!slot) return '';
  const pct = slot.pct;
  const bar = miniBar(pct);
  const val = pct != null ? `**${Math.round(pct)}%**` : fmt(slot.tokens ?? 0);
  let line = `${label} ${bar} ${val}`;
  if (extra) line += extra;
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
    md.appendMarkdown(usageRow('↳ All models', data.allModels));
    md.appendMarkdown(usageRow('↳ Sonnet only', data.sonnetOnly));
    md.appendMarkdown(usageRow('↳ Claude Design', data.claudeDesign));
  }

  const ex = data.extraUsage;
  if (ex) {
    if (ex.enabled || (ex.usedCredits != null && ex.usedCredits > 0)) {
      const credits = ex.usedCredits != null ? `$${Number(ex.usedCredits).toFixed(2)}` : '$0.00';
      const limit   = ex.monthlyLimit  != null ? ` / $${Number(ex.monthlyLimit).toFixed(2)}` : '';
      md.appendMarkdown(`**Extra usage** ${miniBar(ex.pct)} ${credits}${limit}\n\n`);
    }
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
