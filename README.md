# Claude Usage Monitor

Real-time Claude Code token usage displayed in your VS Code status bar and/or as a floating desktop overlay. Shows the **exact same percentages** as the claude.ai Plan Usage Limits page — session usage, weekly usage, and extra credits — updated every 15 seconds.

> **VS Code extension requires no browser login** — it reads your Claude Code OAuth token directly and hits the Anthropic inference API. No Python, no browser, no cookie access needed.

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

1. Download `claude-usage-0.1.6.vsix` from the [latest release](https://github.com/BloodyDeathRoll/claude-usage/releases/latest).

2. Install it:

   **Linux / macOS** — terminal:
   ```bash
   code --install-extension claude-usage-0.1.6.vsix
   ```

   **Windows** — PowerShell (use `code.cmd`, not `Code.exe`):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" --install-extension claude-usage-0.1.6.vsix
   ```
   Or use the UI method below — it works on all platforms without any CLI quirks.

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
npx vsce package           # produces claude-usage-0.1.6.vsix
code --install-extension claude-usage-0.1.6.vsix
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

1. **Cache file** (`~/.claude-usage-cache.json`) — written by the Electron overlay every 10 seconds. Includes full per-model breakdown. Used if the file is less than 10 minutes old.

2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `oauth-2025-04-20` beta header. Usage comes back in rate-limit response headers (5h session + 7d all-models). No browser, no cookies, no Cloudflare bypass needed. Works on any machine where Claude Code is installed.

3. **Local JSONL fallback** — parses `~/.claude/projects/**/*.jsonl` (Claude Code's own log files) and calculates token counts locally. Percentages are estimated based on your configured plan limits.

---

### Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code 1.85+ | |
| Claude Code | Required — the extension reads your OAuth token from `~/.claude/.credentials.json` |

No Python, no browser session, no native modules, nothing to install separately. The extension is self-contained.

---

### Configuration

Open VS Code settings (`Ctrl+,`) and search for **Claude Usage**. These settings affect the local JSONL fallback only (the live API always returns exact values):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit for your plan. Pro=320000, Max5=1600000, Max20=6400000 |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit for your plan |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}` |
| `claudeUsage.overlayPath` | `null` | Absolute path to the overlay repo (folder containing `main.js`). Set when the repo is in a non-standard location, e.g. `C:\Users\you\OneDrive\Documents\Projects\claude-usage` |

The token limit settings affect the local JSONL fallback only. `claudeUsage.overlayPath` is needed only if the extension can't find the overlay automatically (see Troubleshooting below).

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

**VS Code extension** — reads the Claude Code OAuth token from `~/.claude/.credentials.json` and calls:

```
POST api.anthropic.com/v1/messages   (anthropic-beta: oauth-2025-04-20)
```

Usage comes back as rate-limit response headers (`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`). No browser, no Cloudflare bypass.

**Electron overlay** — calls the claude.ai internal endpoint for full per-model data:

```
GET claude.ai/api/organizations/{orgId}/usage
```

This returns `utilization` percentages for the 5-hour session window, the 7-day weekly window, per-model breakdowns (Sonnet, Claude Design), and extra credit consumption — the exact numbers shown on the settings page. The request is made from inside a hidden Chromium window (`BrowserWindow`), which passes Cloudflare checks transparently using the stored session cookie. The org ID comes from the `lastActiveOrg` cookie (not the bootstrap API). The result is cached to `~/.claude-usage-cache.json` so the VS Code extension can read per-model data without repeating the request.

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

Make sure Claude Code is installed and you've run it at least once so the OAuth token exists at `~/.claude/.credentials.json`. Then click the status bar item (or run **Claude Usage: Refresh Now**) to force a refresh.

If the Electron overlay is also running, its cache is used first and includes per-model data.

**Tooltip says `(local estimate)` instead of `(live)`**

The OAuth token is missing or expired. Common causes:
- Claude Code has never been run on this machine (no `~/.claude/.credentials.json`).
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts instead of percentages**

The extension fell back to local JSONL and no plan limits are configured. Either:
- Ensure Claude Code's OAuth token exists (see above), or
- Set `claudeUsage.sessionLimitTokens` in VS Code settings to match your plan.

**"Overlay not found" warning when clicking the status bar**

The extension searches these locations automatically:

| Platform | Paths checked |
|----------|--------------|
| Linux / macOS | `~/Projects/claude-usage`, `~/Projects/usage`, `~/Documents/Projects/claude-usage` |
| Windows | `~\Documents\Projects\claude-usage`, `~\OneDrive\Documents\Projects\claude-usage`, `~\OneDrive\Projects\claude-usage` |

If your repo is elsewhere, set `claudeUsage.overlayPath` in VS Code settings (`Ctrl+,` → search "Claude Usage") to the full path of the folder containing `main.js`. The warning dialog also has an **Open Settings** button that takes you there directly.

**"Electron not installed" warning**

The overlay repo was found but `npm install` hasn't been run inside it yet. Run:
```bash
cd /path/to/claude-usage
npm install
```
On Windows the warning dialog has a **Copy Command** button that puts the right `cd && npm install` on your clipboard.

---

## License

MIT
