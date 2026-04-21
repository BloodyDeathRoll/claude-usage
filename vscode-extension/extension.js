const vscode = require('vscode');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { fetchUsage }  = require('./src/claudeApi');
const { getUsage }    = require('./src/usageParser');
const { hasPython }   = require('./src/browserCookies');

const OVERLAY_CONFIG_PATH = path.join(os.homedir(), '.claude-overlay-config.json');

function readOverlayConfig() {
  try { return JSON.parse(fs.readFileSync(OVERLAY_CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

const POLL_MS = 15_000;

let statusItem;
let timer;
let lastSource = null;   // 'api' | 'local' | null
let cfFailCount = 0;     // consecutive Cloudflare 403s → nudge user

// ── Activation ────────────────────────────────────────────────────────────────

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.command = 'claudeUsage.refresh';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    { dispose: () => clearInterval(timer) },
  );

  refresh(false);
  timer = setInterval(() => refresh(false), POLL_MS);
}

// ── Data ──────────────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), '.claude-usage-cache.json');
const CACHE_MAX_AGE_MS = 2 * 60 * 1000; // treat as fresh for up to 2 minutes

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(data.lastUpdated).getTime() <= CACHE_MAX_AGE_MS) return data;
  } catch {}
  return null;
}

async function refresh(manual) {
  const cfg = vscode.workspace.getConfiguration('claudeUsage');

  // 1. Prefer the cache written by the overlay app — exact API data, no Cloudflare issues
  const cached = readCache();
  if (cached) { cfFailCount = 0; render(cached); return; }

  // 2. Try live API directly via browser cookies
  const apiResult = await fetchUsage();

  if (apiResult.error) {
    if (apiResult.error === 'cloudflare') {
      cfFailCount++;
      if (cfFailCount === 3 || manual) {
        vscode.window.showInformationMessage(
          'Claude Usage: open claude.ai in your browser to refresh authentication.',
          'Open claude.ai'
        ).then(c => { if (c === 'Open claude.ai') vscode.env.openExternal(vscode.Uri.parse('https://claude.ai')); });
      }
    } else if (apiResult.error === 'no_cookies' && manual && !hasPython()) {
      vscode.window.showWarningMessage(
        'Claude Usage: Python 3 is required to read browser cookies. Showing local token counts only.'
      );
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
    return;
  }

  cfFailCount = 0;
  render(apiResult);
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

function buildTooltip(data) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;

  const sourceLabel = data.source === 'api' ? 'live' : 'local estimate';
  md.appendMarkdown(`### Claude Usage *(${sourceLabel})*\n\n`);

  if (data.session) {
    const pct = data.session.pct;
    const bar = miniBar(pct);
    const val = pct != null ? `**${Math.round(pct)}%**` : fmt(data.session.tokens ?? 0);
    md.appendMarkdown(`**Session** ${bar} ${val}`);
    if (data.session.resetsAt) {
      const ms   = new Date(data.session.resetsAt).getTime() - Date.now();
      md.appendMarkdown(`  *(resets ${ms > 0 ? fmtCountdown(ms) : 'soon'})*`);
    }
    md.appendMarkdown('\n\n');
  }

  if (data.allModels) {
    const pct = data.allModels.pct;
    const bar = miniBar(pct);
    const val = pct != null ? `**${Math.round(pct)}%**` : fmt(data.allModels.tokens ?? 0);
    md.appendMarkdown(`**Weekly** ${bar} ${val}\n\n`);
  }

  const ex = data.extraUsage;
  if (ex && (ex.enabled || (ex.pct != null && ex.pct > 0))) {
    const pct     = ex.pct ?? 0;
    const credits = ex.usedCredits != null ? `$${Number(ex.usedCredits).toFixed(2)}` : '$0.00';
    md.appendMarkdown(`**Extra** ${miniBar(pct)} ${credits} · **${Math.round(pct)}%**\n\n`);
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
