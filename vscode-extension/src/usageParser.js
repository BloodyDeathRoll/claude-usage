// Local JSONL fallback — reads ~/.claude/projects/**/*.jsonl and counts tokens.
// Activated when the claude.ai API is unreachable (no browser cookies / Cloudflare).

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { glob } = require('glob');

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

function parseFile(filePath) {
  let sessionStart = null;
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessionStart: null, byModel: {} }; }

  const byMsgId   = new Map();
  const noIdItems = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const ts = obj?.timestamp;
      if (ts) {
        const d = new Date(ts);
        if (!isNaN(d) && (!sessionStart || d < sessionStart)) sessionStart = d;
      }
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
  return { input, output, cacheRead, cacheCreate, sessionStart, byModel };
}

async function getUsage(cfg) {
  const now           = Date.now();
  const sessionCutoff = now - SESSION_WINDOW_MS;
  const weeklyCutoff  = now - WEEKLY_WINDOW_MS;

  let files;
  try {
    files = await glob('**/*.jsonl', { cwd: CLAUDE_DIR, absolute: true, nodir: true });
  } catch { return null; }
  if (!files.length) return null;

  const withMtime = files.map(f => {
    try { return { f, mtime: fs.statSync(f).mtimeMs }; }
    catch { return null; }
  }).filter(Boolean);

  const sessionFiles = withMtime.filter(x => x.mtime >= sessionCutoff);
  let session = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, billable: 0 };
  let sessionStart = null;
  for (const { f } of sessionFiles) {
    const u = parseFile(f);
    session.input += u.input; session.output += u.output;
    session.cacheRead += u.cacheRead; session.cacheCreate += u.cacheCreate;
    if (u.sessionStart && (!sessionStart || u.sessionStart < sessionStart)) sessionStart = u.sessionStart;
  }
  session.billable = session.input + session.output;

  let resetAt = null;
  if (sessionFiles.length) {
    const anchor = sessionStart ?? new Date(Math.min(...sessionFiles.map(x => x.mtime)));
    resetAt = new Date(anchor.getTime() + SESSION_WINDOW_MS);
  }

  const weeklyFiles = withMtime.filter(x => x.mtime >= weeklyCutoff);
  let weekly = { input: 0, output: 0, billable: 0, byModel: {} };
  for (const { f } of weeklyFiles) {
    const u = parseFile(f);
    weekly.input += u.input; weekly.output += u.output;
    for (const [fam, c] of Object.entries(u.byModel)) {
      if (!weekly.byModel[fam]) weekly.byModel[fam] = { input: 0, output: 0 };
      weekly.byModel[fam].input  += c.input;
      weekly.byModel[fam].output += c.output;
    }
  }
  weekly.billable = weekly.input + weekly.output;
  for (const m of Object.values(weekly.byModel)) m.billable = m.input + m.output;

  // Convert to percentages if plan limits are configured
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
