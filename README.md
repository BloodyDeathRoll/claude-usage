# Claude Usage Monitor

Real-time Claude Code token usage displayed in your VS Code status bar and/or as a floating desktop overlay. Shows the **exact same percentages** as the claude.ai Plan Usage Limits page — session usage, weekly usage, and extra credits — updated every 15 seconds.

> **VS Code extension is now pure Node** — Python is no longer required. Cookie reading uses [`sql.js`](https://www.npmjs.com/package/sql.js) (a WASM build of SQLite) bundled with the extension.

---

## Components

This repo contains two independent but complementary tools:

| Component | What it does |
|-----------|-------------|
| **VS Code Extension** | Adds a status bar item: `Session: 61% · Weekly: 75% · Extra: 12%` |
| **Electron Overlay** | Always-on-top floating widget with progress bars, reset countdown, and a settings panel |

They share the same data. When the Electron overlay is running, the VS Code extension reads its cache for zero-overhead exact API values. Both fall back to local JSONL parsing if the overlay is not running.

---

## VS Code Extension

### Installation

#### Option A — Install from `.vsix` (recommended)

1. Download `claude-usage-0.1.0.vsix` from the [latest release](https://github.com/BloodyDeathRoll/claude-usage/releases/latest).

2. Install it:

   **Linux / macOS** — terminal:
   ```bash
   code --install-extension claude-usage-0.1.0.vsix
   ```

   **Windows** — PowerShell:
   ```powershell
   code --install-extension claude-usage-0.1.0.vsix
   ```

   **Or via VS Code UI** (all platforms):
   - Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click the `···` menu at the top right
   - Choose **Install from VSIX…**
   - Select the downloaded file

3. Reload VS Code when prompted (`Ctrl+Shift+P` → **Developer: Reload Window**).

#### Option B — Install from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage/vscode-extension
npm install
npx vsce package           # produces claude-usage-0.1.0.vsix
code --install-extension claude-usage-0.1.0.vsix
```

> **Not on the VS Code Marketplace yet.** The extension is distributed via `.vsix` only. It will not appear in the Extensions search on machines where it has not been manually installed. To install on another PC, download the `.vsix` from the [latest release](https://github.com/BloodyDeathRoll/claude-usage/releases/latest) and follow Option A above.

---

### What you see

The status bar item (bottom-right) shows:

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

- **Session** — your 5-hour rolling usage window
- **Weekly** — your 7-day rolling usage window
- **Extra** — paid credits consumed (only shown when active)

Colors change automatically:
- Normal (no color) below 60%
- Yellow warning at 60–85%
- Red error above 85%

Hover over the item for a detailed tooltip with mini progress bars and reset countdown. Click it to force an immediate refresh.

---

### How it gets data

The extension tries three sources in order, stopping at the first success:

1. **Cache file** (`~/.claude-usage-cache.json`) — written by the Electron overlay every 10 seconds. Exact API values, no browser interaction needed. Used if the file is less than 2 minutes old.

2. **Live API via browser cookies** — reads your browser's `sessionKey` cookie and calls the claude.ai internal API directly. Pure Node (uses bundled `sql.js`); no Python or native modules required. Supports Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, and (Linux only) Opera. This gives the same exact percentages as the claude.ai settings page.

3. **Local JSONL fallback** — parses `~/.claude/projects/**/*.jsonl` (Claude Code's own log files) and calculates token counts locally. Percentages are estimated based on your configured plan limits.

---

### Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code 1.85+ | |
| A supported browser logged into claude.ai | Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, or (Linux) Opera. Without this the extension still works, but falls back to local JSONL counting. |
| Claude Code | Used by the local JSONL fallback to read session logs |

#### Runtime dependencies (bundled in the `.vsix`)

| Dependency | Why |
|---|---|
| [`sql.js`](https://www.npmjs.com/package/sql.js) ^1.10.3 | WASM-compiled SQLite — reads each browser's encrypted cookie database without any native module |

No Python, no native build step, nothing to install separately. Platform-specific decryption uses tools that are already part of the OS:

| Platform | Decryption uses |
|---|---|
| Linux (Chromium-based) | Built-in `crypto` (AES-128-CBC with the well-known `peanuts` key) |
| macOS (Chromium-based) | `security find-generic-password` (already installed) to fetch the per-browser Keychain key |
| Windows (Chromium-based) | `powershell.exe` (already installed) to call DPAPI `Unprotect` for the master key |
| Firefox (any OS) | Direct read — Firefox cookies are unencrypted |

---

### Configuration

Open VS Code settings (`Ctrl+,`) and search for **Claude Usage**. These settings affect the local JSONL fallback only (the live API always returns exact values):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit for your plan. Pro=320000, Max5=1600000, Max20=6400000 |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit for your plan |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}` |

Leave these `null` to show raw token counts instead of percentages in the fallback case.

---

## Electron Overlay (floating popup)

The overlay is a small always-on-top widget that sits in the corner of your screen. It shows live progress bars for all usage categories with a reset countdown timer, and lets you configure your plan limits.

### Requirements

- **Node.js** 18+
- **npm**

### Running from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage
npm install
npm start
```

The overlay appears as a small dark widget. You can drag it anywhere on screen; its position is remembered between launches.

### Controls

| Action | How |
|--------|-----|
| Move | Click and drag anywhere on the widget |
| Minimize to tray | Click the `−` button |
| Restore from tray | Click the tray icon |
| Open settings | Click the `⚙` button |
| Quit | Right-click the tray icon → Quit |

### Settings panel

Click the gear icon to open the settings panel. Choose your plan:

| Plan | Session limit | Weekly limit |
|------|--------------|--------------|
| Pro | 320,000 tokens | 461,000 tokens |
| Max5 | 1,600,000 tokens | 2,300,000 tokens |
| Max20 | 6,400,000 tokens | 9,200,000 tokens |
| Custom | Your choice | 5× session limit |

You can also set per-model weekly limits (Sonnet / Haiku / Opus) for granular tracking.

### Building a distributable

**Linux** (produces `.AppImage` and `.deb`):
```bash
npm run build:linux
# Output: dist/Claude Usage Overlay-1.0.0.AppImage
#         dist/claude-usage-overlay_1.0.0_amd64.deb
```

**macOS** (produces `.dmg` for Intel and Apple Silicon):
```bash
npm run build:mac
# Output: dist/Claude Usage Overlay-1.0.0.dmg
```

**Both at once:**
```bash
npm run build
```

> **macOS note:** Building the `.dmg` requires running on macOS. Cross-compiling from Linux is not supported by electron-builder for macOS targets.

### Installing the built package

**Linux — AppImage:**
```bash
chmod +x "dist/Claude Usage Overlay-1.0.0.AppImage"
./dist/Claude\ Usage\ Overlay-1.0.0.AppImage
```

**Linux — Debian/Ubuntu package:**
```bash
sudo dpkg -i dist/claude-usage-overlay_1.0.0_amd64.deb
claude-usage-overlay   # or find it in your application launcher
```

**macOS:**
Open the `.dmg`, drag the app to Applications, then launch it. macOS may warn about an unidentified developer — go to System Preferences → Security & Privacy → Open Anyway.

---

## How it works

### Live API (exact values)

Claude's usage page at `claude.ai/settings/limits` reads from an internal API endpoint:

```
GET /api/organizations/{orgId}/usage
```

This returns `utilization` percentages for the 5-hour session window, the 7-day weekly window, and extra credit consumption — the exact numbers shown on the settings page.

The API sits behind Cloudflare's bot protection, which blocks plain HTTP requests from Node.js. The Electron overlay solves this by making the request from inside a hidden Chromium window (Electron's `BrowserWindow`), which passes the Cloudflare checks transparently. The result is cached to `~/.claude-usage-cache.json` so the VS Code extension can read it without repeating the browser dance.

### Local JSONL fallback

When the API is unreachable, both tools parse Claude Code's own log files at `~/.claude/projects/**/*.jsonl`. Each assistant message is deduplicated by `message.id` (Claude Code writes each message twice during streaming) and token counts are aggregated over:

- **Session window:** rolling 5 hours
- **Weekly window:** rolling 7 days

Percentages are calculated against the plan limits you configure. Without configured limits, raw token counts are shown.

---

## Privacy

- No data is sent anywhere. All network requests go only to `claude.ai` using your own browser session.
- Cookie access is read-only and local. The extension copies the browser's cookie database to a tempfile, reads it via in-process `sql.js`, then deletes the tempfile. Nothing is stored or transmitted.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no cookies, no personal data.

---

## Troubleshooting

**Numbers don't match claude.ai (showing 0% or wrong %)**

The extension needs a browser session to read exact values. On each machine:
1. Open claude.ai in any supported browser and make sure you're logged in.
2. Visit `claude.ai/settings/usage` once so the cookies are written to disk.
3. Click the status bar item (or run **Claude Usage: Refresh Now**) to force a refresh.

Supported browsers (checked automatically): Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera (Linux only).

**Tooltip says `(local estimate)` instead of `(live)`**

The cookie read failed. Common causes:
- Not logged in to claude.ai in any of the supported browsers above.
- Using a non-default Chromium profile (only the `Default` profile is searched).
- Using a fork the extension doesn't know about (e.g. LibreWolf, Arc on Windows).
- **Linux Chrome with kwallet/gnome-keyring**: cookies are encrypted with a key the extension can't read. Either start Chrome with `--password-store=basic` and **log in to claude.ai again** (existing cookies won't decrypt — a fresh login is required), or use Firefox.
- **macOS first run**: a Keychain dialog appears asking permission to read the browser's Safe Storage password. Click **Always Allow** to suppress future prompts.
- **Chrome ≥127 v20 app-bound encryption**: the `sessionKey` cookie typically still uses v10/v11, so this is rare. If it ever breaks, fall back to Firefox (plaintext on every OS).

**Status bar shows `—` or raw token counts instead of percentages**

The extension fell back to local JSONL and no plan limits are configured. Either:
- Open claude.ai in your browser and log in (see above), or
- Set `claudeUsage.sessionLimitTokens` in VS Code settings to match your plan.

**Cloudflare authentication prompt**

Open claude.ai in your browser on this machine, complete the human-check, then click the status bar item to refresh. The `cf_clearance` cookie has to be fresh.

---

## License

MIT
