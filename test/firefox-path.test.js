const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The Linux Firefox profile path lives in an embedded Python snippet inside the
// claude-usage CLI script (not an exported function), so assert against source.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'claude-usage'), 'utf8');

test('Linux Firefox profile dir uses ~/.mozilla/firefox', () => {
  assert.match(SRC, /expanduser\("~\/\.mozilla\/firefox"\)/,
    'must use the real Linux Firefox path');
});

test('stale ~/.config/mozilla/firefox path is gone', () => {
  assert.doesNotMatch(SRC, /\.config\/mozilla\/firefox/,
    'old wrong path must not remain');
});
