const http2 = require('http2');
const { readCookies } = require('./browserCookies');

async function fetchUsage() {
  const cookies = readCookies();
  if (!cookies) return { error: 'no_cookies' };

  const { sessionKey, cf_clearance, lastActiveOrg: orgId } = cookies;
  if (!sessionKey || !orgId) return { error: 'no_cookies' };

  const cookieStr = [
    'sessionKey=' + sessionKey,
    cf_clearance ? 'cf_clearance=' + cf_clearance : '',
  ].filter(Boolean).join('; ');

  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };

    let client;
    try {
      client = http2.connect('https://claude.ai');
    } catch {
      return done({ error: 'network' });
    }

    const cleanup = () => { try { client.close(); } catch {} };
    const fail    = err => { cleanup(); done({ error: err }); };

    client.on('error', () => fail('network'));

    // Kill the whole session if nothing happens within 10s
    const timer = setTimeout(() => fail('timeout'), 10_000);

    const req = client.request({
      ':method':       'GET',
      ':path':         `/api/organizations/${orgId}/usage`,
      ':scheme':       'https',
      ':authority':    'claude.ai',
      'cookie':        cookieStr,
      'user-agent':    'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'accept':        'application/json',
      'referer':       'https://claude.ai/settings/limits',
      'accept-language': 'en-US,en;q=0.5',
      'sec-fetch-dest':  'empty',
      'sec-fetch-mode':  'cors',
      'sec-fetch-site':  'same-origin',
    });

    req.on('error', () => fail('network'));

    let status = null;
    let body   = '';

    req.on('response', headers => { status = parseInt(headers[':status'], 10); });
    req.on('data',     chunk   => { body += chunk; });

    req.on('end', () => {
      clearTimeout(timer);
      cleanup();

      if (status === 403) return done({ error: body.startsWith('<') ? 'cloudflare' : 'auth' });
      if (status !== 200) return done({ error: 'http_' + status });

      let raw;
      try { raw = JSON.parse(body); } catch { return done({ error: 'parse' }); }

      done({
        source:     'api',
        session:    raw.five_hour  ? { pct: raw.five_hour.utilization  ?? 0, resetsAt: raw.five_hour.resets_at  } : null,
        allModels:  raw.seven_day  ? { pct: raw.seven_day.utilization  ?? 0, resetsAt: raw.seven_day.resets_at  } : null,
        extraUsage: raw.extra_usage
          ? { enabled:     raw.extra_usage.is_enabled,
              usedCredits: raw.extra_usage.used_credits,
              pct:         raw.extra_usage.utilization,
              currency:    raw.extra_usage.currency }
          : null,
        lastUpdated: new Date(),
      });
    });

    req.end();
  });
}

module.exports = { fetchUsage };
