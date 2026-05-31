# Tracker Claude Usage

Real-time Claude Code session and weekly token usage in the VS Code status bar.

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

Hover for a detailed tooltip with mini progress bars, per-model weekly limits, daily routine runs, and reset countdowns. Click to open the optional always-on-top Electron overlay.

The numbers match the **claude.ai → Settings → Usage** page exactly. The extension authenticates with the **Claude Code OAuth token** (the one stored when you log into the `claude` CLI) and calls the same internal API — **no browser login and no cookies required.** If the token is unavailable it falls back to parsing Claude Code's local JSONL session logs.

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | |
| Claude Code, logged in | Provides the OAuth token at `~/.claude/.credentials.json` that powers the live API. If `claude` runs and is authenticated, the extension works. |

**The extension is pure Node — no Python, no native modules, no bundled runtime dependencies.** Authentication is just a bearer token read from a local file. The optional Electron overlay (a separate app in the repo) may require Python 3 for its `npm install`; that's unrelated to the extension itself.

---

## How it gets data

The extension tries four sources in order, stopping at the first success:

1. **Overlay cache file** (`~/.claude-usage-cache.json`) — written by the optional Electron overlay every 10 seconds. Full per-model data. Used if the file is less than 10 minutes old.
2. **OAuth-direct to claude.ai** — reads the OAuth token from `~/.claude/.credentials.json` and calls `https://claude.ai/api/organizations/{orgId}/usage`, parsing the same `utilization` / `resets_at` fields the settings page renders. Returns the **full** dataset (session, weekly all-models, Sonnet-only, Claude Design, daily routine runs, extra usage).
3. **Inference API headers** — a 1-token request to `api.anthropic.com/v1/messages` with the same token; reads the `anthropic-ratelimit-unified-*` response headers. **Partial** — 5-hour session and 7-day weekly only, no per-model breakdown. Used when claude.ai rejects the token.
4. **Local JSONL fallback** — parses `~/.claude/projects/**/*.jsonl` and estimates percentages against your configured plan limits.

The tooltip header shows which source is in use: `Claude Usage (live)` (sources 1–3) vs `Claude Usage (local estimate)` (source 4).

---

## Configuration

`Ctrl+,` → search **Claude Usage**. These settings affect the **local JSONL fallback only** (the live API always returns exact values):

| Setting | Default | Description |
|---|---|---|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit for your plan. Pro=320000, Max5=1600000, Max20=6400000. |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit for your plan. |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}`. |
| `claudeUsage.overlayPath` | `null` | Absolute path to the claude-usage overlay directory (where `main.js` lives). Leave null to auto-detect from common locations (`~/Projects/claude-usage`, `~/Documents/Projects/claude-usage`, `~/OneDrive/...`, etc.). |

Leave `sessionLimitTokens` and `weeklyLimitTokens` `null` to show raw token counts instead of percentages in the fallback case.

---

## Commands

| Command | Description |
|---|---|
| **Claude Usage: Refresh Now** | Force an immediate refresh. |
| **Claude Usage: Open Detailed Overlay** | Launch the optional Electron overlay (installed from the repo; auto-detected or set via `claudeUsage.overlayPath`). |

---

## Privacy

- No data is sent anywhere except claude.ai and api.anthropic.com, using your own Claude Code OAuth token.
- The token is read locally from `~/.claude/.credentials.json` (read-only) and sent only as the `Authorization` header to Anthropic's own servers. It is never stored or transmitted elsewhere.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages, token counts, and reset timestamps — no token, no cookies, no personal data.

---

## Troubleshooting

**Tooltip says `(local estimate)` instead of `(live)`**

The live API couldn't authenticate — usually a missing or expired Claude Code OAuth token.
- Run `claude` and complete the login if prompted.
- Confirm `~/.claude/.credentials.json` exists with a current `claudeAiOauth.accessToken`.
- Run **Claude Usage: Refresh Now**.

**Tooltip shows session + weekly but no per-model rows**

You're on the inference-headers source (claude.ai rejected the token but `api.anthropic.com` accepted it). That source only exposes 5-hour and 7-day utilization. Run the Electron overlay for the full per-model breakdown.

**Status bar shows `—` or raw token counts instead of percentages**

The extension fell back to local JSONL and no plan limits are configured. Either ensure Claude Code is logged in (so the live API works) or set `claudeUsage.sessionLimitTokens` to match your plan.

---

## Source & feedback

- [GitHub repository](https://github.com/BloodyDeathRoll/claude-usage) — includes the optional Electron overlay.
- [Issue tracker](https://github.com/BloodyDeathRoll/claude-usage/issues).

## License

MIT
