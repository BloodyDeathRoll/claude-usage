// ── State ─────────────────────────────────────────────────────────────────────

let config   = null;
let resetAt  = null; // Date — when current session resets
let lastData = null;
let pendingPlan = null;

// ── Elements ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const elNoData        = $('no-data');
const elBodyRows      = $('body');
const elFooter        = $('footer');
const elSessionValue  = $('session-value');
const elSessionLimit  = $('session-limit');
const elSessionBar    = $('session-bar');
const elRowExtra      = $('row-extra');
const elExtraValue    = $('extra-value');
const elExtraBar      = $('extra-bar');
const elWeeklyValue   = $('weekly-value');
const elWeeklyLimit   = $('weekly-limit');
const elWeeklyBar     = $('weekly-bar');
const elResetTimer    = $('reset-timer');
const elLastSync      = $('last-sync');
const elSettings      = $('settings-panel');
const elCustomRow     = $('custom-row');
const elCustomSession = $('custom-session');

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'resetting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `↺ ${h}h ${String(m).padStart(2,'0')}m`;
  if (m > 0) return `↺ ${m}m ${String(s).padStart(2,'0')}s`;
  return `↺ ${s}s`;
}

function fmtAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function barClass(pct) {
  if (pct >= 85) return 'danger';
  if (pct >= 60) return 'warn';
  return '';
}

// ── Countdown ticker (runs every second) ─────────────────────────────────────

setInterval(() => {
  if (!resetAt) { elResetTimer.textContent = ''; return; }
  const ms = new Date(resetAt).getTime() - Date.now();
  elResetTimer.textContent = fmtCountdown(ms);
  elResetTimer.className   = (ms > 0 && ms < 10 * 60 * 1000) ? 'urgent' : '';

  // Refresh "updated X ago" text too
  if (lastData) elLastSync.textContent = fmtAgo(lastData.lastUpdated);
}, 1000);

// ── UI update ─────────────────────────────────────────────────────────────────

function applyUsage(data) {
  lastData = data;
  if (data.resetAt) resetAt = data.resetAt;

  elNoData.style.display  = 'none';
  elBodyRows.style.display = 'flex';
  elFooter.style.display   = 'flex';

  const sessionLimit = config?.sessionLimitTokens ?? null;
  const weeklyLimit  = config?.weeklyLimitTokens  ?? null;
  const sessionTotal = data.session.total;

  // ── Base vs extra ──────────────────────────────────────────────────────────
  let baseUsed  = sessionTotal;
  let extraUsed = 0;
  if (sessionLimit && sessionTotal > sessionLimit) {
    baseUsed  = sessionLimit;
    extraUsed = sessionTotal - sessionLimit;
  }

  // Session bar
  if (sessionLimit) {
    const pct = Math.min(100, (baseUsed / sessionLimit) * 100);
    elSessionLimit.textContent = ' / ' + fmt(sessionLimit);
    elSessionBar.style.width   = pct + '%';
    elSessionBar.className     = 'progress-fill ' + barClass(pct);
    elSessionBar.style.opacity = '';
    elSessionValue.textContent = fmt(baseUsed);
  } else {
    elSessionLimit.textContent = '';
    elSessionValue.textContent = fmt(sessionTotal);
    elSessionBar.style.width   = '100%';
    elSessionBar.className     = 'progress-fill no-limit';
    elSessionBar.style.opacity = '0.35';
  }

  // Extra usage row — show only when there is extra
  if (extraUsed > 0) {
    elRowExtra.style.display    = '';
    elExtraValue.textContent    = fmt(extraUsed);
    // Bar width relative to the session limit (extra = how much over)
    const extraPct = sessionLimit ? Math.min(100, (extraUsed / sessionLimit) * 100) : 30;
    elExtraBar.style.width = extraPct + '%';
  } else {
    elRowExtra.style.display = 'none';
  }

  // Weekly bar
  const wv = data.weekly.total;
  elWeeklyValue.textContent = fmt(wv);
  if (weeklyLimit) {
    const pct = Math.min(100, (wv / weeklyLimit) * 100);
    elWeeklyLimit.textContent = ' / ' + fmt(weeklyLimit);
    elWeeklyBar.style.width   = pct + '%';
    elWeeklyBar.className     = 'progress-fill ' + barClass(pct);
    elWeeklyBar.style.opacity = '';
  } else {
    elWeeklyLimit.textContent = '';
    elWeeklyBar.style.width   = '100%';
    elWeeklyBar.className     = 'progress-fill no-limit';
    elWeeklyBar.style.opacity = '0.35';
  }

  elLastSync.textContent = fmtAgo(data.lastUpdated);
}

function showNoData() {
  elBodyRows.style.display = 'none';
  elFooter.style.display   = 'none';
  elNoData.style.display   = 'flex';
}

// ── Settings panel ────────────────────────────────────────────────────────────

function openSettings() {
  pendingPlan = config?.plan ?? null;
  document.querySelectorAll('.plan-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.plan === pendingPlan);
  });
  elCustomRow.style.display = pendingPlan === 'custom' ? 'flex' : 'none';
  if (pendingPlan === 'custom' && config?.sessionLimitTokens) {
    elCustomSession.value = config.sessionLimitTokens;
  }
  elSettings.classList.add('visible');
}

function closeSettings() {
  elSettings.classList.remove('visible');
  pendingPlan = null;
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-minimize').addEventListener('click', () => window.claudeUsage.minimize());
$('btn-settings-cancel').addEventListener('click', closeSettings);

$('btn-no-limit').addEventListener('click', () => {
  window.claudeUsage.saveConfig({ plan: null, sessionLimitTokens: null, weeklyLimitTokens: null });
  closeSettings();
});

document.querySelectorAll('.plan-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    pendingPlan = btn.dataset.plan;
    document.querySelectorAll('.plan-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    elCustomRow.style.display = pendingPlan === 'custom' ? 'flex' : 'none';
  });
});

$('btn-settings-save').addEventListener('click', () => {
  if (!pendingPlan) { closeSettings(); return; }
  const btn = document.querySelector(`.plan-btn[data-plan="${pendingPlan}"]`);
  let sessionLimit = parseInt(btn?.dataset.session);
  let weeklyLimit  = parseInt(btn?.dataset.weekly);
  if (pendingPlan === 'custom') {
    sessionLimit = parseInt(elCustomSession.value) || 88000;
    weeklyLimit  = sessionLimit * 5;
  }
  window.claudeUsage.saveConfig({ plan: pendingPlan, sessionLimitTokens: sessionLimit, weeklyLimitTokens: weeklyLimit });
  closeSettings();
});

$('titlebar').addEventListener('mouseup', () => window.claudeUsage.dragEnd());

// ── IPC ───────────────────────────────────────────────────────────────────────

window.claudeUsage.onUsageUpdate(data => applyUsage(data));
window.claudeUsage.onNoData(() => showNoData());
window.claudeUsage.onConfigUpdate(cfg => {
  config = cfg;
  if (lastData) applyUsage(lastData); // re-render with new limits
});

window.claudeUsage.getConfig().then(cfg => {
  config = cfg;
  if (!cfg) openSettings();
});
