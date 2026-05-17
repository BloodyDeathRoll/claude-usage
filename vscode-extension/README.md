# Claude Usage

Real-time Claude Code session and weekly token usage in the VS Code status bar.

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

Hover for a detailed tooltip with mini progress bars and reset countdowns. Click to force an immediate refresh, or to open the optional always-on-top Electron overlay.

The numbers match the **claude.ai → Settings → Usage** page exactly — the extension uses your Claude Code OAuth token to call the Anthropic inference API and reads usage from the rate-limit response headers. No browser login required. If the OAuth token is unavailable it falls back to parsing Claude Code's local JSONL session logs.

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | |
| Claude Code | Provides the OAuth token at `~/.claude/.credentials.json`. Without it the extension falls back to local JSONL counting. |

**No Python, no browser session, no native modules, no extra installs.** The extension is self-contained.

---

## How it gets data

The extension tries three sources in order, stopping at the first success:

1. **Cache file** (`~/.claude-usage-cache.json`) — written by the optional Electron overlay every 10 seconds. Includes full per-model breakdown (Sonnet, Claude Design). Used if the file is less than 10 minutes old.
2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `anthropic-beta: oauth-2025-04-20` header. Usage comes back as rate-limit response headers — 5h session + 7d all-models. No browser, no Cloudflare bypass.
3. **Local JSONL fallback** — parses `~/.claude/projects/**/*.jsonl` and estimates percentages against your configured plan limits.

The tooltip header shows which source is in use: `Claude Usage (live)` vs `Claude Usage (local estimate)`.

---

## Configuration

`Ctrl+,` → search **Claude Usage**. These settings affect the **local JSONL fallback only** (the live API always returns exact values):

| Setting | Default | Description |
|---|---|---|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit for your plan. Pro=320000, Max5=1600000, Max20=6400000. |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit for your plan. |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}`. |

Leave them `null` to show raw token counts instead of percentages in the fallback case.

---

## Commands

| Command | Description |
|---|---|
| **Claude Usage: Refresh Now** | Force an immediate refresh. |
| **Claude Usage: Open Detailed Overlay** | Launch the optional Electron overlay (must be installed separately). |

---

## Privacy

- No data is sent anywhere. All network requests go only to `claude.ai` using your own browser session.
- Cookie access is read-only. The extension copies the browser's cookie database to a tempfile, reads it via in-process `sql.js`, then deletes the tempfile.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no cookies, no personal data.

---

## Troubleshooting

**Tooltip says `(local estimate)` instead of `(live)`**

The OAuth token is missing or expired. Common causes:
- Claude Code has never been run on this machine — no `~/.claude/.credentials.json` exists.
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts instead of percentages**

Either ensure Claude Code's OAuth token is present (see above), or set `claudeUsage.sessionLimitTokens` in VS Code settings to match your plan.

**"Overlay not found" warning when clicking the status bar**

The extension auto-searches common locations. If your repo is elsewhere, set `claudeUsage.overlayPath` in VS Code settings (`Ctrl+,` → search "Claude Usage") to the full path of the folder containing `main.js`. The warning dialog has an **Open Settings** button that takes you there directly.

| Platform | Paths checked automatically |
|----------|---------------------------|
| Linux / macOS | `~/Projects/claude-usage`, `~/Projects/usage`, `~/Documents/Projects/claude-usage` |
| Windows | `~\Documents\Projects\claude-usage`, `~\OneDrive\Documents\Projects\claude-usage`, `~\OneDrive\Projects\claude-usage` |

**"Electron not installed" warning**

The overlay repo was found but `npm install` hasn't been run inside it. The warning dialog has a **Copy Command** button that puts the right command on your clipboard.

---

## Source & feedback

- [GitHub repository](https://github.com/BloodyDeathRoll/claude-usage) — includes the optional Electron overlay.
- [Issue tracker](https://github.com/BloodyDeathRoll/claude-usage/issues).

## License

MIT
