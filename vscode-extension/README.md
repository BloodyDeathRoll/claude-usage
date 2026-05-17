# Claude Usage

Real-time Claude Code session and weekly token usage in the VS Code status bar.

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

**Click the status bar item** to launch the always-on-top floating overlay. On first click the overlay installs itself automatically — no cloning, no manual `npm install`, no extra steps on any OS.

Hover for a tooltip with mini progress bars and reset countdowns. The numbers match **claude.ai → Settings → Usage** exactly.

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | |
| Node.js + npm | Used for the overlay's one-time auto-install. Present on any machine with Claude Code. |
| Claude Code | Provides the OAuth token for live data. Without it the extension falls back to local JSONL counting. |

**No Python. No browser. No manual setup.**

---

## How it gets data

Three sources tried in order, stopping at the first success:

1. **Overlay cache** (`~/.claude-usage-cache.json`) — written by the overlay every 10 seconds. Includes full per-model breakdown (Sonnet, Claude Design). Used if less than 10 minutes old.
2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `anthropic-beta: oauth-2025-04-20` header. Usage in rate-limit response headers (5h + 7d). No browser, no Cloudflare bypass.
3. **Local JSONL** — parses `~/.claude/projects/**/*.jsonl` and estimates percentages against your configured plan limits.

Tooltip header shows which source is active: `Claude Usage (live)` vs `Claude Usage (local estimate)`.

---

## Configuration

`Ctrl+,` → search **Claude Usage**:

| Setting | Default | Description |
|---|---|---|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit. Pro=320000, Max5=1600000, Max20=6400000. Local fallback only. |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit. Local fallback only. |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}`. Local fallback only. |
| `claudeUsage.overlayPath` | `null` | Override the overlay install location. Leave null to use the auto-managed `~/.claude-usage-overlay`. |

---

## Commands

| Command | Description |
|---|---|
| **Claude Usage: Open Overlay** | Launch the overlay (same as clicking the status bar). |
| **Claude Usage: Refresh Now** | Force an immediate refresh. |

---

## Privacy

- No data leaves your machine except requests to `api.anthropic.com` using your own OAuth token.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no credentials.

---

## Troubleshooting

**Tooltip shows `(local estimate)` instead of `(live)`**

- Claude Code has never been run on this machine — no `~/.claude/.credentials.json` exists yet.
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts**

Run Claude Code once (to create the OAuth token), or set `claudeUsage.sessionLimitTokens` in settings to match your plan.

**Overlay setup failed**

If the auto-install fails, set it up manually:
```bash
cd ~/.claude-usage-overlay
npm install
```
Then click the status bar item again.

---

## Source & feedback

- [GitHub repository](https://github.com/BloodyDeathRoll/claude-usage)
- [Issue tracker](https://github.com/BloodyDeathRoll/claude-usage/issues)

## License

MIT
