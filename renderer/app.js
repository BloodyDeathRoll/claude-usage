// ── State ─────────────────────────────────────────────────────────────────────

let config   = null;
let resetAt  = null;
let lastData = null;
let pendingPlan = null;

// ── Elements ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const elNoData         = $('no-data');
const elBody           = $('body');
const elFooter         = $('footer');
const elSessionValue   = $('session-value');
const elSessionReset   = $('session-reset');
const elSessionBar     = $('session-bar');
const elWeeklyAllValue = $('weekly-all-value');
const elWeeklyAllBar   = $('weekly-all-bar');
const elRowSonnet      = $('row-sonnet');
const elSonnetValue    = $('weekly-sonnet-value');
const elSonnetBar      = $('weekly-sonnet-bar');
const elRowDesign      = $('row-design');
const elDesignValue    = $('weekly-design-value');
const elDesignBar      = $('weekly-design-bar');
const elWeeklyReset    = $('weekly-reset');
const elSectionFeatures = $('section-features');
const elRoutinesValue  = $('routines-value');
const elSectionExtra   = $('section-extra');
const elExtraSummary   = $('extra-summary');
const elExtraBar       = $('extra-bar');
const elWeeklyRows     = $('weekly-rows');
const elResetTimer     = $('reset-timer');
const elLastSync       = $('last-sync');
const elSettings       = $('settings-panel');
const elCustomRow      = $('custom-row');
const elCustomSession  = $('custom-session');

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) {
    const k = n / 1_000;
    // .toFixed(1) on >=999.95 rounds to "1000.0" — roll over to M instead.
    if (k >= 999.95) return (n / 1_000_000).toFixed(2) + 'M';
    return k.toFixed(1) + 'k';
  }
  return String(n);
}

function fmtPct(pct) {
  if (pct == null) return '—';
  return pct.toFixed(1).replace(/\.0$/, '') + '%';
}

function fmtMoney(val, currency) {
  if (val == null) return '—';
  const sym = currency === 'usd' ? '$' : (currency ?? '$');
  return sym + Number(val).toFixed(2);
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

function fmtResetDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return 'Resets ' + d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
       + ' ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
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

// ── Slot renderer helper ──────────────────────────────────────────────────────

function applySlot(valueEl, barEl, slot, showClass) {
  if (!slot) return;
  const pct = slot.pct ?? 0;
  valueEl.textContent = fmtPct(pct);
  barEl.style.width   = Math.min(100, pct) + '%';
  barEl.className     = 'progress-fill ' + barClass(pct);
}

// ── API data path ─────────────────────────────────────────────────────────────

function applyApiUsage(data) {
  if (data.session?.resetsAt) resetAt = data.session.resetsAt;

  elNoData.style.display = 'none';
  elBody.style.display   = 'flex';
  elFooter.style.display = 'flex';

  // ── Current session ──────────────────────────────────────────────────────
  const sPct = data.session?.pct ?? 0;
  elSessionValue.textContent = fmtPct(sPct);
  elSessionBar.style.width   = Math.min(100, sPct) + '%';
  elSessionBar.className     = 'progress-fill ' + barClass(sPct);
  elSessionReset.textContent = data.session?.resetsAt
    ? fmtCountdown(new Date(data.session.resetsAt).getTime() - Date.now())
    : '';

  // ── Weekly — All models ───────────────────────────────────────────────────
  applySlot(elWeeklyAllValue, elWeeklyAllBar, data.allModels);

  // ── Weekly — Sonnet only ──────────────────────────────────────────────────
  if (data.sonnetOnly) {
    elRowSonnet.style.display = '';
    applySlot(elSonnetValue, elSonnetBar, data.sonnetOnly);
  } else {
    elRowSonnet.style.display = 'none';
  }

  // ── Weekly — Claude Design ────────────────────────────────────────────────
  if (data.claudeDesign) {
    elRowDesign.style.display = '';
    applySlot(elDesignValue, elDesignBar, data.claudeDesign);
  } else {
    elRowDesign.style.display = 'none';
  }

  // ── Weekly reset date ─────────────────────────────────────────────────────
  const weeklyResets = data.allModels?.resetsAt ?? data.sonnetOnly?.resetsAt;
  if (weeklyResets) {
    elWeeklyReset.textContent = fmtResetDate(weeklyResets);
    elWeeklyReset.classList.add('visible');
  } else {
    elWeeklyReset.classList.remove('visible');
  }

  // ── Additional features — Daily routine runs ──────────────────────────────
  // The /usage endpoint returns `iguana_necktie` populated only after a routine
  // has been run. The limit ("/15" etc.) is plan-tier hardcoded in the Claude
  // UI, so we mirror that: read the limit from plan config, and render "0 / N"
  // when iguana_necktie is null. When non-null with utilization, convert the
  // 0–100 percentage back to a count.
  const routinesLimit = config?.routinesPerDay ?? 0;
  const runs          = data.dailyRoutineRuns;
  if (routinesLimit > 0) {
    elSectionFeatures.style.display = '';
    let used = 0;
    if (runs && typeof runs === 'object') {
      if (runs.used != null)             used = runs.used;
      else if (runs.utilization != null) used = Math.round((runs.utilization / 100) * routinesLimit);
    }
    elRoutinesValue.textContent = used + ' / ' + routinesLimit;
  } else {
    elSectionFeatures.style.display = 'none';
  }

  // ── Extra usage ───────────────────────────────────────────────────────────
  const ex       = data.extraUsage;
  const currency = ex?.currency ?? 'usd';
  const spent    = ex?.usedCredits  ?? 0;
  const limit    = ex?.monthlyLimit ?? null;
  const balance  = limit != null ? Math.max(0, limit - spent) : null;
  const pct      = ex?.pct ?? (limit ? Math.min(100, (spent / limit) * 100) : 0);

  const spentStr   = fmtMoney(spent, currency);
  const limitStr   = limit   != null ? fmtMoney(limit,   currency) : '?';
  const balanceStr = balance != null ? fmtMoney(balance, currency) + ' left' : '—';
  elExtraSummary.textContent = `${spentStr}/${limitStr} | ${balanceStr}`;

  const disabled = !ex?.enabled;
  elExtraBar.style.width     = Math.min(100, pct) + '%';
  elExtraBar.className       = 'progress-fill extra-fill' + (disabled ? ' faded' : ' ' + barClass(pct));
  elExtraSummary.className   = 'row-value extra-label' + (disabled ? ' faded' : '');

  elLastSync.textContent = fmtAgo(data.lastUpdated);
}

// ── Local (JSONL) data path ───────────────────────────────────────────────────

function makeWeeklyRow(label, billable, limit) {
  const row = document.createElement('div');
  row.className = 'usage-row';
  let valueText, barWidth, cls, opacity = '';
  if (limit) {
    const pct = Math.min(100, (billable / limit) * 100);
    valueText = fmtPct(pct);
    barWidth  = pct + '%';
    cls       = 'progress-fill ' + barClass(pct);
  } else {
    valueText = fmt(billable);
    barWidth  = '100%';
    cls       = 'progress-fill no-limit';
    opacity   = 'opacity:0.35;';
  }
  row.innerHTML = `
    <div class="row-header">
      <span class="row-label">${label}</span>
      <span class="row-value">${valueText}</span>
    </div>
    <div class="progress-track">
      <div class="${cls}" style="width:${barWidth};${opacity}"></div>
    </div>`;
  return row;
}

const WEEKLY_MODELS = [
  { key: 'sonnet', label: 'All / Sonnet' },
  { key: 'haiku',  label: 'Haiku' },
  { key: 'opus',   label: 'Opus' },
];

function applyLocalUsage(data) {
  if (data.resetAt) resetAt = data.resetAt;

  elNoData.style.display = 'none';
  elBody.style.display   = 'flex';
  elFooter.style.display = 'flex';

  // Hide API-only sections
  elRowSonnet.style.display      = 'none';
  elRowDesign.style.display      = 'none';
  elWeeklyReset.classList.remove('visible');
  elSectionFeatures.style.display = 'none';
  elSectionExtra.style.display   = 'none';

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
    elSessionValue.textContent = fmtPct(pct);
    elSessionReset.textContent = fmt(sessionBillable) + ' / ' + fmt(sessionLimit);
  } else {
    elSessionValue.textContent = fmt(sessionBillable);
    elSessionReset.textContent = '';
    elSessionBar.style.width   = '100%';
    elSessionBar.className     = 'progress-fill no-limit';
  }

  elWeeklyRows.innerHTML = '';
  const byModel     = data.weekly.byModel ?? {};
  const modelLimits = config?.weeklyModelLimits ?? null;
  const activeModels = WEEKLY_MODELS.filter(({ key }) =>
    (byModel[key]?.billable > 0) || (modelLimits?.[key] > 0)
  );
  if (activeModels.length === 0) {
    elWeeklyRows.appendChild(makeWeeklyRow('Weekly', data.weekly.billable, config?.weeklyLimitTokens ?? null));
  } else {
    for (const { key, label } of activeModels) {
      elWeeklyRows.appendChild(makeWeeklyRow(label, byModel[key]?.billable ?? 0, modelLimits?.[key] ?? null));
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
  elBody.style.display   = 'none';
  elFooter.style.display = 'none';
  elNoData.style.display = 'flex';
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
  window.claudeUsage.saveConfig({ plan: null, sessionLimitTokens: null, weeklyLimitTokens: null, weeklyModelLimits: null, routinesPerDay: 0 });
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
  let routinesPerDay;
  if (pendingPlan === 'custom') {
    sessionLimit      = parseInt(elCustomSession.value) || 330000;
    weeklyLimitTokens = sessionLimit * 5;
    weeklyModelLimits = null;
    routinesPerDay    = 0;
  } else {
    sessionLimit = parseInt(btn?.dataset.session);
    weeklyModelLimits = {
      sonnet: parseInt(btn?.dataset.weeklySonnet) || 0,
      haiku:  parseInt(btn?.dataset.weeklyHaiku)  || 0,
      opus:   parseInt(btn?.dataset.weeklyOpus)   || 0,
    };
    weeklyLimitTokens = Object.values(weeklyModelLimits).reduce((a, b) => a + b, 0);
    routinesPerDay    = parseInt(btn?.dataset.routines) || 0;
  }
  window.claudeUsage.saveConfig({ plan: pendingPlan, sessionLimitTokens: sessionLimit, weeklyLimitTokens, weeklyModelLimits, routinesPerDay });
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
  // A saved config always carries a `plan` key (including `plan: null` for the
  // explicit "No limit" choice). Only fall back to Pro defaults when the config
  // is genuinely absent / never initialised — otherwise we'd clobber a user who
  // deliberately turned limits off.
  if (!cfg || !('plan' in cfg)) {
    const proDefaults = {
      plan: 'pro',
      sessionLimitTokens: 320000,
      weeklyLimitTokens: 461000,
      weeklyModelLimits: { sonnet: 436000, haiku: 25000, opus: 0 },
      routinesPerDay: 5,
    };
    config = { ...(cfg ?? {}), ...proDefaults };
    window.claudeUsage.saveConfig(proDefaults);
    if (lastData) applyUsage(lastData);
  } else {
    config = cfg;
    // Backfill routinesPerDay for configs saved before this field existed.
    if (config.routinesPerDay == null) {
      const planRoutines = { pro: 5, max5: 15, max20: 60 };
      const r = planRoutines[config.plan] ?? 0;
      if (r > 0) {
        config.routinesPerDay = r;
        window.claudeUsage.saveConfig({ routinesPerDay: r });
      }
    }
  }
});

// Auto-resize the Electron window to match content.
const sendResize = (() => {
  let last = 0;
  let pending = null;
  return () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const h = document.getElementById('app').getBoundingClientRect().height;
      if (Math.abs(h - last) >= 1) {
        last = h;
        window.claudeUsage.resize(h);
      }
    });
  };
})();
new ResizeObserver(sendResize).observe(document.getElementById('app'));
window.addEventListener('load', sendResize);
