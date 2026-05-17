# Claude Usage

Real-time Claude Code session and weekly token usage in the VS Code status bar.

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

Hover for a detailed tooltip with mini progress bars and reset countdowns. Click to force an immediate refresh, or to open the optional always-on-top Electron overlay.

The numbers match the **claude.ai → Settings → Usage** page exactly — the extension reads your browser's `sessionKey` cookie and calls the same internal API. If no cookie is available, it falls back to parsing Claude Code's local JSONL session logs.

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | |
| A supported browser logged into claude.ai | Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, or (Linux) Opera. Without this the extension still works, but falls back to local JSONL counting. |
| Claude Code | Used by the local JSONL fallback to read session logs. |

**No Python, no native modules, no extra installs.** Cookie reading is pure Node, with platform decryption handled via OS-builtin tools.

### Bundled runtime dependencies

| Package | Version | Why |
|---|---|---|
| [`sql.js`](https://www.npmjs.com/package/sql.js) | ^1.10.3 | WASM-compiled SQLite — reads each browser's encrypted cookie database without any native module. |

Decryption per platform:

| Platform | Method | Tool used (already on the OS) |
|---|---|---|
| Linux (Chromium-based) | AES-128-CBC with the well-known `peanuts` key | Node `crypto` |
| macOS (Chromium-based) | AES-128-CBC with a Keychain-derived key | `security find-generic-password` |
| Windows (Chromium-based) | AES-256-GCM with a DPAPI-unwrapped master key | `powershell.exe` (DPAPI `Unprotect`) |
| Firefox (any OS) | None — cookies are plaintext SQLite | Node `crypto` (just for SQLite read) |

---

## How it gets data

The extension tries three sources in order, stopping at the first success:

1. **Cache file** (`~/.claude-usage-cache.json`) — written by the optional Electron overlay every 10 seconds. Used if the file is less than 2 minutes old.
2. **Live API via browser cookies** — reads your `sessionKey` from the supported browser, calls `https://claude.ai/api/organizations/{orgId}/usage`, and parses the same `utilization` / `resets_at` fields the settings page renders.
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

The cookie read failed. Common causes:
- Not logged in to claude.ai in any of the supported browsers.
- Using a non-default Chromium profile (only `Default` is searched).
- Using a fork the extension doesn't know about (e.g. LibreWolf, Arc on Windows).
- **Linux Chrome with kwallet/gnome-keyring**: existing cookies are encrypted with a key the extension can't read. Start Chrome with `--password-store=basic` and **log in to claude.ai again** — existing cookies won't decrypt with the new key, a fresh login is required. Or use Firefox.
- **macOS first run**: a Keychain dialog asks permission to read the browser's Safe Storage password. Click **Always Allow** to suppress future prompts.
- **Chrome ≥127 v20 app-bound encryption**: rare for `sessionKey`, which usually stays on v10/v11. If it ever breaks, fall back to Firefox (plaintext on every OS).

**Status bar shows `Cloudflare`-ish errors**

Open `claude.ai` in your browser, complete the human-check, then run **Claude Usage: Refresh Now**. The `cf_clearance` cookie has to be fresh.

**Status bar shows `—` or raw token counts instead of percentages**

Either log in to claude.ai (see above) or set `claudeUsage.sessionLimitTokens` to match your plan.

---

## Source & feedback

- [GitHub repository](https://github.com/BloodyDeathRoll/claude-usage) — includes the optional Electron overlay.
- [Issue tracker](https://github.com/BloodyDeathRoll/claude-usage/issues).

## License

MIT
