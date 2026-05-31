const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'usageParser.js');
const EXT = path.join(__dirname, '..', 'vscode-extension', 'src', 'usageParser.js');

function freshHomeWith(files) {
  // files: { 'name.jsonl': '<contents>' }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-home-'));
  const proj = path.join(home, '.claude', 'projects', 'projA');
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(proj, name), body);
  }
  return home;
}

function loadFreshGetUsage(modPath, home) {
  process.env.HOME = home;        // CLAUDE_DIR const is captured at require-time
  delete require.cache[require.resolve(modPath)];
  return require(modPath).getUsage;
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function line(id, inTok, outTok, when = ago(60_000)) {
  return JSON.stringify({
    timestamp: when,
    message: { id, usage: { input_tokens: inTok, output_tokens: outTok } },
  });
}

// session.billable lives at .billable (overlay) or .tokens (extension)
const billable = (res) => res.session.billable ?? res.session.tokens;

for (const modPath of [SRC, EXT]) {
  const label = modPath.includes('vscode-extension') ? 'ext' : 'src';

  test(`[${label}] same message.id across two files counts once`, async () => {
    const home = freshHomeWith({
      'f1.jsonl': line('msg-shared', 10, 5) + '\n' + line('msg-a', 20, 0) + '\n',
      'f2.jsonl': line('msg-shared', 10, 5) + '\n' + line('msg-b', 20, 0) + '\n',
    });
    const res = await loadFreshGetUsage(modPath, home)();
    // shared(15) + a(20) + b(20) = 55, NOT 70 (double-counted shared)
    assert.strictEqual(billable(res), 55, 'shared message must be counted once');
  });

  test(`[${label}] id-less messages are NOT collapsed`, async () => {
    const noId = JSON.stringify({ timestamp: ago(60_000), message: { usage: { input_tokens: 7 } } });
    const home = freshHomeWith({ 'f.jsonl': noId + '\n' + noId + '\n' });
    const res = await loadFreshGetUsage(modPath, home)();
    assert.strictEqual(billable(res), 14, 'id-less messages each count');
  });

  test(`[${label}] entries older than the 5h session window are excluded`, async () => {
    const home = freshHomeWith({
      'f.jsonl': line('old', 99, 0, ago(6 * 60 * 60 * 1000)) + '\n' + line('fresh', 3, 0) + '\n',
    });
    const res = await loadFreshGetUsage(modPath, home)();
    assert.strictEqual(billable(res), 3, 'only the fresh message is in the session window');
  });
}
