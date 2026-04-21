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

function parseFile(filePath) {
  let sessionStart = null;
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessionStart: null, byModel: {} }; }

  // Claude Code writes each assistant message twice: once during streaming
  // (stop_reason: null, partial tokens) and once when complete (final tokens).
  // Deduplicate by message.id, keeping the last entry (highest token count).
  const byMsgId = new Map(); // message.id -> { inp, out, cr, cc, family }
  const noIdEntries = [];    // entries without a message.id (summed directly)

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

      const inp = u.input_tokens                ?? 0;
      const out = u.output_tokens               ?? 0;
      const cr  = u.cache_read_input_tokens     ?? 0;
      const cc  = u.cache_creation_input_tokens ?? 0;
      const family = modelFamily(obj?.message?.model ?? obj?.model ?? '');
      const msgId  = obj?.message?.id;

      if (msgId) {
        // Always overwrite — later entry has equal-or-higher token counts
        byMsgId.set(msgId, { inp, out, cr, cc, family });
      } else {
        noIdEntries.push({ inp, out, cr, cc, family });
      }
    } catch { }
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

  return { input, output, cacheRead, cacheCreate, sessionStart, byModel };
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

  // ── Current session ────────────────────────────────────────────────────────
  const sessionFiles = withMtime.filter(x => x.mtime >= sessionCutoff);
  let session = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, billable: 0 };
  let sessionStart = null;

  if (sessionFiles.length) {
    for (const { f } of sessionFiles) {
      const u = parseFile(f);
      session.input       += u.input;
      session.output      += u.output;
      session.cacheRead   += u.cacheRead;
      session.cacheCreate += u.cacheCreate;
      if (u.sessionStart && (!sessionStart || u.sessionStart < sessionStart)) {
        sessionStart = u.sessionStart;
      }
    }
    session.total    = session.input + session.output + session.cacheRead + session.cacheCreate;
    session.billable = session.input + session.output;
  }

  // Reset = 5h after the oldest request in the session window.
  let resetAt = null;
  if (sessionFiles.length) {
    const oldestMtime = Math.min(...sessionFiles.map(x => x.mtime));
    const anchor = sessionStart ?? new Date(oldestMtime);
    resetAt = new Date(anchor.getTime() + SESSION_WINDOW_MS);
  }

  // ── Weekly ─────────────────────────────────────────────────────────────────
  const weeklyFiles = withMtime.filter(x => x.mtime >= weeklyCutoff);
  let weekly = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, billable: 0, byModel: {} };

  for (const { f } of weeklyFiles) {
    const u = parseFile(f);
    weekly.input       += u.input;
    weekly.output      += u.output;
    weekly.cacheRead   += u.cacheRead;
    weekly.cacheCreate += u.cacheCreate;
    for (const [family, counts] of Object.entries(u.byModel)) {
      if (!weekly.byModel[family]) {
        weekly.byModel[family] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      }
      weekly.byModel[family].input       += counts.input;
      weekly.byModel[family].output      += counts.output;
      weekly.byModel[family].cacheRead   += counts.cacheRead;
      weekly.byModel[family].cacheCreate += counts.cacheCreate;
    }
  }

  weekly.total    = weekly.input + weekly.output + weekly.cacheRead + weekly.cacheCreate;
  weekly.billable = weekly.input + weekly.output;
  for (const m of Object.values(weekly.byModel)) {
    m.billable = m.input + m.output;
    m.total    = m.input + m.output + m.cacheRead + m.cacheCreate;
  }

  return { session, weekly, resetAt, lastUpdated: new Date() };
}

module.exports = { getUsage, CLAUDE_PROJECTS_DIR };
