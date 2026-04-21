const https = require('https');
const { readCookies } = require('./browserCookies');

function httpsGet(hostname, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function fetchUsage() {
  const cookies = readCookies();
  if (!cookies) return { error: 'no_cookies' };

  const { sessionKey, cf_clearance, lastActiveOrg: orgId, __ssid } = cookies;
  if (!sessionKey || !orgId) return { error: 'no_cookies' };

  const cookieStr = [
    `sessionKey=${sessionKey}`,
    cf_clearance ? `cf_clearance=${cf_clearance}` : '',
    __ssid       ? `__ssid=${__ssid}` : '',
  ].filter(Boolean).join('; ');

  let res;
  try {
    res = await httpsGet('claude.ai', `/api/organizations/${orgId}/usage`, {
      Cookie:       cookieStr,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept:       'application/json',
      Referer:      'https://claude.ai/settings/billing',
    });
  } catch {
    return { error: 'network' };
  }

  if (res.status === 403) return { error: 'cloudflare' };
  if (res.status !== 200) return { error: 'http_' + res.status };

  let raw;
  try { raw = JSON.parse(res.body); } catch { return { error: 'parse' }; }

  return {
    source:      'api',
    session:     raw.five_hour         ? { pct: raw.five_hour.utilization         ?? 0, resetsAt: raw.five_hour.resets_at         } : null,
    allModels:   raw.seven_day         ? { pct: raw.seven_day.utilization         ?? 0, resetsAt: raw.seven_day.resets_at         } : null,
    extraUsage:  raw.extra_usage
      ? { enabled: raw.extra_usage.is_enabled, usedCredits: raw.extra_usage.used_credits,
          pct: raw.extra_usage.utilization, currency: raw.extra_usage.currency }
      : null,
    lastUpdated: new Date(),
  };
}

module.exports = { fetchUsage };
