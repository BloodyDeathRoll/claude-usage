// ── State ─────────────────────────────────────────────────────────────────────

let config   = null;
let resetAt  = null;
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
const elWeeklyRows    = $('weekly-rows');
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

function fmtPct(pct) {
  return pct.toFixed(1).replace(/\.0$/, '') + '%';
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

// ── Countdown ticker ──────────────────────────────────────────────────────────

setInterval(() => {
  if (!resetAt) { elResetTimer.textContent = ''; return; }
  const ms = new Date(resetAt).getTime() - Date.now();
  elResetTimer.textContent = fmtCountdown(ms);
  elResetTimer.className   = (ms > 0 && ms < 10 * 60 * 1000) ? 'urgent' : '';
  if (lastData) elLastSync.textContent = fmtAgo(lastData.lastUpdated);
}, 1000);

// ── Row builder ───────────────────────────────────────────────────────────────

function makeRow(label, pct, sublabel) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  const cls = 'progress-fill ' + barClass(pct);
  const width = Math.min(100, pct) + '%';
  row.innerHTML = `
    <div class="row-header">
      <span class="row-label">${label}</span>
      <span class="row-right">
        <span class="row-value">${fmtPct(pct)}</span><span class="row-limit">${sublabel ? ' · ' + sublabel : ''}</span>
      </span>
    </div>
    <div class="progress-track">
      <div class="${cls}" style="width:${width}"></div>
    </div>`;
  return row;
}

// ── API data path ─────────────────────────────────────────────────────────────

function applyApiUsage(data) {
  if (data.session?.resetsAt) resetAt = data.session.resetsAt;

  elNoData.style.display   = 'none';
  elBodyRows.style.display = 'flex';
  elFooter.style.display   = 'flex';

  // Session
  const sPct = data.session?.pct ?? 0;
  elSessionBar.style.width   = Math.min(100, sPct) + '%';
  elSessionBar.className     = 'progress-fill ' + barClass(sPct);
  elSessionBar.style.opacity = '';
  elSessionValue.textContent = fmtPct(sPct);
  elSessionLimit.textContent = '';

  // Extra usage — show whenever enabled OR there is active spend/utilisation
  const ex = data.extraUsage;
  const hasExtraData = ex && (ex.enabled || ex.pct != null || (ex.usedCredits != null && ex.usedCredits > 0));
  if (hasExtraData) {
    elRowExtra.style.display = '';
    const pct     = ex.pct ?? 0;
    const credits = ex.usedCredits != null
      ? (ex.currency === 'usd' ? '$' : '') + Number(ex.usedCredits).toFixed(2)
      : '$0.00';
    elExtraValue.textContent = credits + ' · ' + fmtPct(pct);
    elExtraBar.style.width   = Math.min(100, pct) + '%';
    // colour the bar by utilisation
    elExtraBar.className = 'progress-fill extra-fill ' + barClass(pct);
  } else {
    elRowExtra.style.display = 'none';
  }

  // Weekly rows
  elWeeklyRows.innerHTML = '';
  if (data.allModels) {
    elWeeklyRows.appendChild(makeRow('Weekly · All', data.allModels.pct));
  }

  elLastSync.textContent = fmtAgo(data.lastUpdated);
}

// ── Local (JSONL) data path ───────────────────────────────────────────────────

function makeWeeklyRowLocal(label, billable, limit) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  let valueText, limitText, barWidth, cls, opacity = '';
  if (limit) {
    const pct = Math.min(100, (billable / limit) * 100);
    valueText = fmtPct(pct);
    limitText = ' · ' + fmt(billable) + ' / ' + fmt(limit);
    barWidth  = pct + '%';
    cls       = 'progress-fill ' + barClass(pct);
  } else {
    valueText = fmt(billable);
    limitText = '';
    barWidth  = '100%';
    cls       = 'progress-fill no-limit';
    opacity   = 'opacity:0.35;';
  }
  row.innerHTML = `
    <div class="row-header">
      <span class="row-label">${label}</span>
      <span class="row-right">
        <span class="row-value">${valueText}</span><span class="row-limit">${limitText}</span>
      </span>
    </div>
    <div class="progress-track">
      <div class="${cls}" style="width:${barWidth};${opacity}"></div>
    </div>`;
  return row;
}

const WEEKLY_MODELS = [
  { key: 'sonnet', label: 'Weekly · All'    },
  { key: 'haiku',  label: 'Weekly · Design' },
  { key: 'opus',   label: 'Weekly · Opus'   },
];

function applyLocalUsage(data) {
  if (data.resetAt) resetAt = data.resetAt;

  elNoData.style.display   = 'none';
  elBodyRows.style.display = 'flex';
  elFooter.style.display   = 'flex';

  const sessionLimit    = config?.sessionLimitTokens ?? null;
  const sessionBillable = data.session.billable ?? data.session.total;

  let baseUsed = sessionBillable, extraUsed = 0;
  if (sessionLimit && sessionBillable > sessionLimit) {
    baseUsed  = sessionLimit;
    extraUsed = sessionBillable - sessionLimit;
  }

  if (sessionLimit) {
    const pct = Math.min(100, (baseUsed / sessionLimit) * 100);
    elSessionBar.style.width   = pct + '%';
    elSessionBar.className     = 'progress-fill ' + barClass(pct);
    elSessionBar.style.opacity = '';
    elSessionValue.textContent = fmtPct(pct);
    elSessionLimit.textContent = ' · ' + fmt(sessionBillable) + ' / ' + fmt(sessionLimit);
  } else {
    elSessionLimit.textContent = '';
    elSessionValue.textContent = fmt(data.session.total);
    elSessionBar.style.width   = '100%';
    elSessionBar.className     = 'progress-fill no-limit';
    elSessionBar.style.opacity = '0.35';
  }

  if (extraUsed > 0) {
    elRowExtra.style.display = '';
    elExtraValue.textContent = fmt(extraUsed);
    const extraPct = sessionLimit ? Math.min(100, (extraUsed / sessionLimit) * 100) : 30;
    elExtraBar.style.width = extraPct + '%';
  } else {
    elRowExtra.style.display = 'none';
  }

  elWeeklyRows.innerHTML = '';
  const byModel     = data.weekly.byModel ?? {};
  const modelLimits = config?.weeklyModelLimits ?? null;
  const activeModels = WEEKLY_MODELS.filter(({ key }) =>
    (byModel[key]?.billable > 0) || (modelLimits?.[key] > 0)
  );
  if (activeModels.length === 0) {
    elWeeklyRows.appendChild(makeWeeklyRowLocal('Weekly', data.weekly.billable, config?.weeklyLimitTokens ?? null));
  } else {
    for (const { key, label } of activeModels) {
      elWeeklyRows.appendChild(makeWeeklyRowLocal(label, byModel[key]?.billable ?? 0, modelLimits?.[key] ?? null));
    }
  }

  elLastSync.textContent = fmtAgo(data.lastUpdated);
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function applyUsage(data) {
  lastData = data;
  if (data.source === 'api') {
    applyApiUsage(data);
  } else {
    applyLocalUsage(data);
  }
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
  window.claudeUsage.saveConfig({ plan: null, sessionLimitTokens: null, weeklyLimitTokens: null, weeklyModelLimits: null });
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
  let sessionLimit, weeklyModelLimits, weeklyLimitTokens;
  if (pendingPlan === 'custom') {
    sessionLimit      = parseInt(elCustomSession.value) || 330000;
    weeklyLimitTokens = sessionLimit * 5;
    weeklyModelLimits = null;
  } else {
    sessionLimit = parseInt(btn?.dataset.session);
    weeklyModelLimits = {
      sonnet: parseInt(btn?.dataset.weeklySonnet) || 0,
      haiku:  parseInt(btn?.dataset.weeklyHaiku)  || 0,
      opus:   parseInt(btn?.dataset.weeklyOpus)   || 0,
    };
    weeklyLimitTokens = Object.values(weeklyModelLimits).reduce((a, b) => a + b, 0);
  }
  window.claudeUsage.saveConfig({ plan: pendingPlan, sessionLimitTokens: sessionLimit, weeklyLimitTokens, weeklyModelLimits });
  closeSettings();
});

$('titlebar').addEventListener('mouseup', () => window.claudeUsage.dragEnd());

// ── IPC ───────────────────────────────────────────────────────────────────────

window.claudeUsage.onUsageUpdate(data => applyUsage(data));
window.claudeUsage.onNoData(() => showNoData());
window.claudeUsage.onConfigUpdate(cfg => {
  config = cfg;
  if (lastData) applyUsage(lastData);
});

window.claudeUsage.getConfig().then(cfg => {
  if (!cfg || cfg.plan == null) {
    const proDefaults = {
      plan: 'pro',
      sessionLimitTokens: 320000,
      weeklyLimitTokens: 461000,
      weeklyModelLimits: { sonnet: 436000, haiku: 25000, opus: 0 },
    };
    config = { ...(cfg ?? {}), ...proDefaults };
    window.claudeUsage.saveConfig(proDefaults);
    if (lastData) applyUsage(lastData);
  } else {
    config = cfg;
  }
});
