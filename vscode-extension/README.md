# Claude Usage

Real-time Claude Code session and weekly token usage in the VS Code status bar.

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

**Click the status bar item** to open a full detail panel inside VS Code — session usage, weekly limits, per-model breakdown, reset countdowns. No Electron overlay, no npm install, no extra setup. Works on every machine the moment the extension is installed.

The numbers match **claude.ai → Settings → Usage** exactly — the extension uses your Claude Code OAuth token to call the Anthropic inference API and reads usage from the rate-limit response headers. If the OAuth token is unavailable it falls back to parsing Claude Code's local JSONL session logs.

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | |
| Claude Code | Provides the OAuth token at `~/.claude/.credentials.json`. Without it the extension still works, using local JSONL counting. |

**No Python. No browser. No native modules. No extra installs.** The extension is completely self-contained.

---

## How it gets data

Three sources tried in order, stopping at the first success:

1. **Overlay cache** (`~/.claude-usage-cache.json`) — written by the optional Electron overlay. Includes full per-model breakdown (Sonnet, Claude Design). Used if the file is less than 10 minutes old.
2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `anthropic-beta: oauth-2025-04-20` header. Usage comes back in rate-limit response headers (5h session + 7d all-models). No browser, no Cloudflare bypass.
3. **Local JSONL** — parses `~/.claude/projects/**/*.jsonl` and estimates percentages against your configured plan limits.

The tooltip header shows which source is active: `Claude Usage (live)` vs `Claude Usage (local estimate)`.

---

## Commands

| Command | What it does |
|---|---|
| **Claude Usage: Show Detail Panel** | Opens the usage detail panel (same as clicking the status bar). |
| **Claude Usage: Refresh Now** | Force an immediate refresh. |
| **Claude Usage: Open External Overlay (optional)** | Launches the always-on-top Electron overlay if you have the repo cloned and `npm install` run. |

---

## Configuration

`Ctrl+,` → search **Claude Usage**:

| Setting | Default | Description |
|---|---|---|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit. Pro=320000, Max5=1600000, Max20=6400000. Used for local fallback only. |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit. Used for local fallback only. |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}`. Used for local fallback only. |
| `claudeUsage.overlayPath` | `null` | Path to the Electron overlay repo (optional). Only needed if you want the external overlay and it isn't auto-detected. |

---

## Privacy

- No data leaves your machine. All requests go only to `api.anthropic.com` using your own OAuth token.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no credentials.

---

## Troubleshooting

**Tooltip shows `(local estimate)` instead of `(live)`**

The OAuth token is missing or expired:
- Claude Code has never been run on this machine — no `~/.claude/.credentials.json` exists yet.
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts**

The extension fell back to local JSONL and no plan limits are configured. Either run Claude Code once (to create the OAuth token) or set `claudeUsage.sessionLimitTokens` in settings to match your plan.

---

## Source & feedback

- [GitHub repository](https://github.com/BloodyDeathRoll/claude-usage) — includes the optional Electron overlay.
- [Issue tracker](https://github.com/BloodyDeathRoll/claude-usage/issues).

## License

MIT
