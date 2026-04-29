// Fetches real-time usage from api.anthropic.com via the Claude Code OAuth token.
// Makes a minimal 1-token inference request; rate-limit utilization comes back
// in response headers — no browser session or cookie needed.

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_PATH   = path.join(os.homedir(), '.claude-usage-cache.json');
const CACHE_MAX_MS = 2 * 60 * 1000;

function readOAuthToken() {
  try {
    const oauth = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8'))?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch { return null; }
}

function parseRateLimitHeaders(headers) {
  const h = name => headers[name.toLowerCase()] ?? null;

  const fiveHUtil   = h('anthropic-ratelimit-unified-5h-utilization');
  const sevenDUtil  = h('anthropic-ratelimit-unified-7d-utilization');
  const fiveHReset  = h('anthropic-ratelimit-unified-5h-reset');
  const sevenDReset = h('anthropic-ratelimit-unified-7d-reset');
  const overageSt   = h('anthropic-ratelimit-unified-overage-status');

  if (fiveHUtil == null && sevenDUtil == null) return null;

  // Headers are 0–1 fractions; renderer expects 0–100 percentages.
  const slot = (utilStr, resetStr) => utilStr == null ? null : {
    pct:      parseFloat(utilStr) * 100,
    resetsAt: resetStr ? new Date(parseInt(resetStr, 10) * 1000).toISOString() : null,
  };

  return {
    source:       'api',
    session:      slot(fiveHUtil,  fiveHReset),
    allModels:    slot(sevenDUtil, sevenDReset),
    sonnetOnly:   null,
    claudeDesign: null,
    extraUsage: overageSt != null ? {
      enabled:      overageSt === 'allowed',
      usedCredits:  null,
      monthlyLimit: null,
      pct:          null,
      currency:     null,
    } : null,
    lastUpdated: new Date(),
  };
}

let _pending = null;

async function fetchUsage() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Date.now() - new Date(cached.lastUpdated).getTime() <= CACHE_MAX_MS) return cached;
  } catch {}

  if (_pending) return _pending;
  _pending = _doFetch().finally(() => { _pending = null; });
  return _pending;
}

async function _doFetch() {
  const token = readOAuthToken();
  if (!token) return null;

  const body = Buffer.from(JSON.stringify({
    model:     'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages:  [{ role: 'user', content: 'hi' }],
  }));

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Authorization':    `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':   'oauth-2025-04-20',
        'Content-Type':     'application/json',
        'Content-Length':   body.length,
      },
      timeout: 10000,
    }, (res) => {
      res.resume();  // drain body, don't need the JSON
      const result = parseRateLimitHeaders(res.headers);
      if (result) {
        try { fs.writeFileSync(CACHE_PATH, JSON.stringify(result)); } catch {}
      }
      resolve(result);
    });

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body);
    req.end();
  });
}

module.exports = { fetchUsage };
