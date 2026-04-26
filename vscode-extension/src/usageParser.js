const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CLAUDE_DIR        = path.join(os.homedir(), '.claude', 'projects');
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
  const noIdItems = [];
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

      // Skip entries outside the requested window (entries with no timestamp are also skipped
      // when a cutoff is set — they can't be attributed to the right time window)
      if (cutoff !== null && (!entryTime || entryTime.getTime() < cutoff)) continue;

      if (entryTime && (!oldest || entryTime < oldest)) oldest = entryTime;

      const u = obj?.message?.usage ?? obj?.usage;
      if (!u) continue;

      const entry = {
        inp: u.input_tokens ?? 0, out: u.output_tokens ?? 0,
        cr:  u.cache_read_input_tokens ?? 0, cc: u.cache_creation_input_tokens ?? 0,
        family: modelFamily(obj?.message?.model ?? obj?.model ?? ''),
      };
      const msgId = obj?.message?.id;
      if (msgId) byMsgId.set(msgId, entry); else noIdItems.push(entry);
    } catch {}
  }

  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, byModel = {};
  const add = ({ inp, out, cr, cc, family }) => {
    input += inp; output += out; cacheRead += cr; cacheCreate += cc;
    if (!byModel[family]) byModel[family] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    byModel[family].input += inp; byModel[family].output += out;
    byModel[family].cacheRead += cr; byModel[family].cacheCreate += cc;
  };
  for (const e of byMsgId.values()) add(e);
  for (const e of noIdItems) add(e);
  return { input, output, cacheRead, cacheCreate, byModel, oldest };
}

function findJsonl(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findJsonl(full, results);
    else if (e.isFile() && e.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

async function getUsage(cfg) {
  const now           = Date.now();
  const sessionCutoff = now - SESSION_WINDOW_MS;
  const weeklyCutoff  = now - WEEKLY_WINDOW_MS;

  let files;
  try { files = findJsonl(CLAUDE_DIR); } catch { return null; }
  if (!files.length) return null;

  const withMtime = files.map(f => {
    try { return { f, mtime: fs.statSync(f).mtimeMs }; }
    catch { return null; }
  }).filter(Boolean);

  // Pre-filter: skip files not touched in 7 days (they can't contain recent entries)
  const weeklyFiles = withMtime.filter(x => x.mtime >= weeklyCutoff);

  let session = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billable: 0 };
  let weekly  = { input: 0, output: 0, billable: 0, byModel: {} };
  let sessionOldest = null;

  for (const { f, mtime } of weeklyFiles) {
    // Weekly: count only entries with ts in the last 7 days
    const wu = parseFile(f, weeklyCutoff);
    weekly.input  += wu.input;
    weekly.output += wu.output;
    for (const [fam, c] of Object.entries(wu.byModel)) {
      if (!weekly.byModel[fam]) weekly.byModel[fam] = { input: 0, output: 0 };
      weekly.byModel[fam].input  += c.input;
      weekly.byModel[fam].output += c.output;
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

  session.billable = session.input + session.output;
  weekly.billable  = weekly.input + weekly.output;
  for (const m of Object.values(weekly.byModel)) m.billable = m.input + m.output;

  // resetAt = oldest entry in the session window + 5h (when the current session block expires)
  const resetAt = sessionOldest ? new Date(sessionOldest.getTime() + SESSION_WINDOW_MS) : null;

  const sessionLimit = cfg?.sessionLimitTokens ?? null;
  const sonnetLimit  = cfg?.weeklyModelLimits?.sonnet ?? cfg?.weeklyLimitTokens ?? null;

  return {
    source:    'local',
    session:   {
      pct:      sessionLimit ? Math.min(100, (session.billable / sessionLimit) * 100) : null,
      tokens:   session.billable,
      resetsAt: resetAt,
    },
    allModels: {
      pct:    sonnetLimit ? Math.min(100, ((weekly.byModel.sonnet?.billable ?? weekly.billable) / sonnetLimit) * 100) : null,
      tokens: weekly.byModel.sonnet?.billable ?? weekly.billable,
    },
    lastUpdated: new Date(),
  };
}

module.exports = { getUsage };
