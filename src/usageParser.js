const fs = require('fs');
const { glob } = require('glob');
const os = require('os');
const path = require('path');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000;

// Returns { usage: {input,output,cacheRead,cacheCreate}, sessionStart: Date|null }
function parseFile(filePath) {
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  let sessionStart = null;
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { input, output, cacheRead, cacheCreate, sessionStart }; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // Grab the earliest timestamp as session start
      const ts = obj?.timestamp;
      if (ts) {
        const d = new Date(ts);
        if (!isNaN(d) && (!sessionStart || d < sessionStart)) sessionStart = d;
      }

      const u = obj?.message?.usage ?? obj?.usage;
      if (!u) continue;
      input       += u.input_tokens                ?? 0;
      output      += u.output_tokens               ?? 0;
      cacheRead   += u.cache_read_input_tokens     ?? 0;
      cacheCreate += u.cache_creation_input_tokens ?? 0;
    } catch { }
  }
  return { input, output, cacheRead, cacheCreate, sessionStart };
}

async function getUsage() {
  const now          = Date.now();
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

  // ── Current session ───────────────────────────────────────────────────────
  const sessionFiles = withMtime.filter(x => x.mtime >= sessionCutoff);
  let session = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  let sessionStart = null;

  if (sessionFiles.length) {
    sessionFiles.sort((a, b) => b.mtime - a.mtime);
    const { input, output, cacheRead, cacheCreate, sessionStart: st } = parseFile(sessionFiles[0].f);
    session = { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate };
    sessionStart = st;
  }

  // Reset time: 5 hours after the first message in the active session file.
  // Falls back to 5h after the file's mtime if no timestamp found in records.
  let resetAt = null;
  if (sessionFiles.length) {
    const anchor = sessionStart ?? new Date(sessionFiles[0].mtime);
    resetAt = new Date(anchor.getTime() + SESSION_WINDOW_MS);
  }

  // ── Weekly ────────────────────────────────────────────────────────────────
  const weeklyFiles = withMtime.filter(x => x.mtime >= weeklyCutoff);
  let weekly = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  for (const { f } of weeklyFiles) {
    const u = parseFile(f);
    weekly.input       += u.input;
    weekly.output      += u.output;
    weekly.cacheRead   += u.cacheRead;
    weekly.cacheCreate += u.cacheCreate;
  }
  weekly.total = weekly.input + weekly.output + weekly.cacheRead + weekly.cacheCreate;

  return { session, weekly, resetAt, lastUpdated: new Date() };
}

module.exports = { getUsage, CLAUDE_PROJECTS_DIR };
