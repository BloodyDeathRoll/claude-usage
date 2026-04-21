const fs = require('fs');
const { glob } = require('glob');
const os = require('os');
const path = require('path');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000;

function modelFamily(model) {
  if (!model) return 'other';
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku'))  return 'haiku';
  return 'other';
}

// cutoff: only count entries whose timestamp >= cutoff (ms). null = count all.
function parseFile(filePath, cutoff = null) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, byModel: {}, oldest: null }; }

  const byMsgId   = new Map();
  const noIdEntries = [];
  let oldest = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      let entryTime = null;
      const ts = obj?.timestamp;
      if (ts) {
        const d = new Date(ts);
        if (!isNaN(d)) entryTime = d;
      }

      if (cutoff !== null && (!entryTime || entryTime.getTime() < cutoff)) continue;

      if (entryTime && (!oldest || entryTime < oldest)) oldest = entryTime;

      const u = obj?.message?.usage ?? obj?.usage;
      if (!u) continue;

      const inp    = u.input_tokens                ?? 0;
      const out    = u.output_tokens               ?? 0;
      const cr     = u.cache_read_input_tokens     ?? 0;
      const cc     = u.cache_creation_input_tokens ?? 0;
      const family = modelFamily(obj?.message?.model ?? obj?.model ?? '');
      const msgId  = obj?.message?.id;

      if (msgId) {
        byMsgId.set(msgId, { inp, out, cr, cc, family });
      } else {
        noIdEntries.push({ inp, out, cr, cc, family });
      }
    } catch {}
  }

  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  let byModel = {};

  const accumulate = ({ inp, out, cr, cc, family }) => {
    input       += inp;
    output      += out;
    cacheRead   += cr;
    cacheCreate += cc;
    if (!byModel[family]) byModel[family] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    byModel[family].input       += inp;
    byModel[family].output      += out;
    byModel[family].cacheRead   += cr;
    byModel[family].cacheCreate += cc;
  };

  for (const entry of byMsgId.values()) accumulate(entry);
  for (const entry of noIdEntries)      accumulate(entry);

  return { input, output, cacheRead, cacheCreate, byModel, oldest };
}

async function getUsage() {
  const now           = Date.now();
  const sessionCutoff = now - SESSION_WINDOW_MS;
  const weeklyCutoff  = now - WEEKLY_WINDOW_MS;

  let files;
  try {
    files = await glob('**/*.jsonl', { cwd: CLAUDE_PROJECTS_DIR, absolute: true, nodir: true });
  } catch { return null; }
  if (!files.length) return null;

  const withMtime = files.map(f => {
    try { return { f, mtime: fs.statSync(f).mtimeMs }; }
    catch { return null; }
  }).filter(Boolean);

  // Pre-filter: skip files not touched in 7 days (they can't contain recent entries)
  const weeklyFiles = withMtime.filter(x => x.mtime >= weeklyCutoff);

  let session = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, billable: 0 };
  let weekly  = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, billable: 0, byModel: {} };
  let sessionOldest = null;

  for (const { f, mtime } of weeklyFiles) {
    // Weekly: count only entries with ts in the last 7 days
    const wu = parseFile(f, weeklyCutoff);
    weekly.input       += wu.input;
    weekly.output      += wu.output;
    weekly.cacheRead   += wu.cacheRead;
    weekly.cacheCreate += wu.cacheCreate;
    for (const [family, counts] of Object.entries(wu.byModel)) {
      if (!weekly.byModel[family]) {
        weekly.byModel[family] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      }
      weekly.byModel[family].input       += counts.input;
      weekly.byModel[family].output      += counts.output;
      weekly.byModel[family].cacheRead   += counts.cacheRead;
      weekly.byModel[family].cacheCreate += counts.cacheCreate;
    }

    // Session: only parse files that could have recent entries (mtime in last 5h)
    if (mtime >= sessionCutoff) {
      const su = parseFile(f, sessionCutoff);
      session.input       += su.input;
      session.output      += su.output;
      session.cacheRead   += su.cacheRead;
      session.cacheCreate += su.cacheCreate;
      if (su.oldest && (!sessionOldest || su.oldest < sessionOldest)) sessionOldest = su.oldest;
    }
  }

  session.total    = session.input + session.output + session.cacheRead + session.cacheCreate;
  session.billable = session.input + session.output;
  weekly.total     = weekly.input + weekly.output + weekly.cacheRead + weekly.cacheCreate;
  weekly.billable  = weekly.input + weekly.output;
  for (const m of Object.values(weekly.byModel)) {
    m.billable = m.input + m.output;
    m.total    = m.input + m.output + m.cacheRead + m.cacheCreate;
  }

  // resetAt = oldest entry in the session window + 5h
  const resetAt = sessionOldest ? new Date(sessionOldest.getTime() + SESSION_WINDOW_MS) : null;

  return { session, weekly, resetAt, lastUpdated: new Date() };
}

module.exports = { getUsage, CLAUDE_PROJECTS_DIR };
