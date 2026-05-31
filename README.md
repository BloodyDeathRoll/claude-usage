# Claude Usage Monitor

Real-time Claude Code token usage displayed in your VS Code status bar and/or as a floating desktop overlay. Shows the **exact same percentages** as the claude.ai Plan Usage Limits page — session usage, weekly usage, per-model limits, daily routine runs, and extra credits — updated every 15 seconds.

> **No browser login required.** The tools authenticate using the OAuth token Claude Code already stores when you log into the `claude` CLI (`~/.claude/.credentials.json`). There are no cookies to read, no `sql.js`, and no Python needed for the VS Code extension.

---

## Screenshots

![Screenshot 1](assets/screenshot%201.png)
![Screenshot 3](assets/screenshot%203.png)

---

## Components

This repo contains two independent but complementary tools:

| Component | What it does |
|-----------|-------------|
| **VS Code Extension** | Adds a status bar item: `Session: 61% · Weekly: 75% · Extra: 12%` |
| **Electron Overlay** | Always-on-top floating widget with progress bars, reset countdown, and a settings panel |

They share the same data. When the Electron overlay is running, the VS Code extension reads its cache for zero-overhead exact API values. Both fetch directly from claude.ai using the Claude Code OAuth token, and both fall back to local JSONL parsing if the API is unreachable.

---

## VS Code Extension

### Installation

#### Option A — VS Code Marketplace (recommended)

Search the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) for **Tracker Claude Usage** (publisher `EinHanamer`) and click **Install**.

#### Option B — Install from `.vsix`

1. Download the latest `tracker-claude-usage-*.vsix` from the [releases page](https://github.com/BloodyDeathRoll/claude-usage/releases/latest) (or build it from source — see Option C).

2. Install it:

   **Linux / macOS / Windows** — terminal or PowerShell:
   ```bash
   code --install-extension tracker-claude-usage-0.3.3.vsix
   ```

   **Or via VS Code UI** (all platforms):
   - Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click the `···` menu at the top right
   - Choose **Install from VSIX…**
   - Select the downloaded file

3. Reload VS Code when prompted (`Ctrl+Shift+P` → **Developer: Reload Window**).

#### Option C — Build from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage/vscode-extension
npm install
npx vsce package           # produces tracker-claude-usage-0.3.3.vsix
code --install-extension tracker-claude-usage-0.3.3.vsix
```

---

### What you see

The status bar item (bottom-right) shows:

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

- **Session** — your 5-hour rolling usage window
- **Weekly** — your 7-day rolling usage window (all models)
- **Extra** — paid credits consumed (only shown when active)

Colors change automatically:
- Normal (no color) below 60%
- Yellow warning at 60–85%
- Red error above 85%

Hover over the item for a detailed tooltip with mini progress bars, per-model weekly limits (Sonnet only / Claude Design), daily routine runs, extra-usage credits, and reset countdowns. Click it to open the optional Electron overlay.

---

### How it gets data

The extension tries four sources in order, stopping at the first success:

1. **Overlay cache file** (`~/.claude-usage-cache.json`) — written by the Electron overlay every 10 seconds. Exact API values with full per-model breakdown. Used if the file is less than 10 minutes old.

2. **OAuth-direct to claude.ai** — reads the Claude Code OAuth token from `~/.claude/.credentials.json` and calls `https://claude.ai/api/organizations/{orgId}/usage` directly. Returns the **full** dataset (session, weekly all-models, Sonnet-only, Claude Design, daily routine runs, extra usage) — the same numbers the claude.ai settings page renders. No browser, no cookies.

3. **Inference API headers** — sends a 1-token request to `api.anthropic.com/v1/messages` with the same OAuth token and reads the `anthropic-ratelimit-unified-*` response headers. This is a **partial** source: it provides the 5-hour session and 7-day weekly utilization only (no per-model breakdown). Used when claude.ai rejects the token.

4. **Local JSONL fallback** — parses `~/.claude/projects/**/*.jsonl` (Claude Code's own log files) and calculates token counts locally. Percentages are estimated against your configured plan limits.

The tooltip header shows which source is in use: `Claude Usage (live)` for sources 1–3, `Claude Usage (local estimate)` for source 4.

---

### Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code 1.85+ | |
| Claude Code, logged in | Provides the OAuth token at `~/.claude/.credentials.json` that powers the live API sources. If you can run `claude` and it's authenticated, the extension works. |

**No browser, no Python, no native modules.** The extension is pure Node and ships with no runtime dependencies — authentication is just a bearer token read from a local file. If the token is missing or expired (e.g. you've never logged into Claude Code, or your session lapsed), the extension automatically falls back to local JSONL counting.

---

### Configuration

Open VS Code settings (`Ctrl+,`) and search for **Claude Usage**. These settings affect the **local JSONL fallback only** (the live API always returns exact values):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit for your plan. Pro=320000, Max5=1600000, Max20=6400000 |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit for your plan |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}` |
| `claudeUsage.overlayPath` | `null` | Absolute path to the overlay directory (where `main.js` lives). Leave null to auto-detect from common locations |

Leave the limit settings `null` to show raw token counts instead of percentages in the fallback case.

---

## Electron Overlay (floating popup)

The overlay is a small always-on-top widget that sits in the corner of your screen. It shows live progress bars for all usage categories with a reset countdown timer, and lets you configure your plan limits.

### Requirements

- **Node.js** 18+ and **npm**
- **Python 3** — may be required by `npm install` on some platforms (node-gyp builds for optional native deps). Install from [python.org](https://www.python.org/downloads/) if `npm install` fails with a build error.

### Running from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage
npm install
npm start
```

The overlay appears as a small dark widget. You can drag it anywhere on screen; its position is remembered between launches.

On first launch the overlay tries the OAuth token automatically. If the token can't reach claude.ai (rare), the tray menu's **Connect to claude.ai** option opens a one-time login window — this is the *only* path that uses a browser session, and only as a fallback.

### Controls

| Action | How |
|--------|-----|
| Move | Click and drag anywhere on the widget |
| Minimize to tray | Click the `−` button |
| Restore from tray | Click the tray icon |
| Open settings | Click the `⚙` button |
| Connect to claude.ai (fallback login) | Right-click the tray icon → **Connect to claude.ai** |
| Quit | Right-click the tray icon → **Quit** |

### Settings panel

Click the gear icon to open the settings panel. Choose your plan:

| Plan | Session limit | Weekly limit |
|------|--------------|--------------|
| Pro | 320,000 tokens | 461,000 tokens |
| Max5 | 1,600,000 tokens | 2,300,000 tokens |
| Max20 | 6,400,000 tokens | 9,200,000 tokens |
| Custom | Your choice | 5× session limit |

You can also set per-model weekly limits (Sonnet / Haiku / Opus) and your plan's daily routine-run allowance for granular tracking. These configured limits only matter for the local JSONL fallback; live API values are always exact.

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

### Live API via the OAuth token (exact values)

Claude's usage page at `claude.ai/settings/limits` reads from an internal API endpoint:

```
GET /api/organizations/{orgId}/usage
```

This returns `utilization` percentages and `resets_at` timestamps for the 5-hour session window, the 7-day weekly windows (all models, Sonnet only, Claude Design), daily routine runs, and extra-credit consumption — the exact numbers shown on the settings page.

Both tools authenticate by reading the **Claude Code OAuth bearer token** from `~/.claude/.credentials.json` (the token written when you log into the `claude` CLI) and sending it as `Authorization: Bearer …` with the `anthropic-beta: oauth-2025-04-20` header. The organization ID is discovered by enumerating `/api/organizations` and trying each org's usage endpoint until one returns data.

This OAuth-direct path needs no browser and no cookies. If claude.ai ever rejects the token, the tools fall back to:

- **Inference API headers** — a 1-token request to `api.anthropic.com/v1/messages` returns `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers, giving session and weekly utilization (partial — no per-model breakdown).
- **Electron BrowserWindow session** (overlay only) — a one-time login window establishes a claude.ai session cookie inside Electron's own browser context, used to call the same usage endpoint with full data. This is the fallback that replaced the old browser-cookie reader.

The overlay caches whichever live result it gets to `~/.claude-usage-cache.json` so the VS Code extension can read it without repeating any work.

### Local JSONL fallback

When the API is unreachable, both tools parse Claude Code's own log files at `~/.claude/projects/**/*.jsonl`. Each assistant message is deduplicated by `message.id` (Claude Code writes each message twice during streaming) and token counts are aggregated over:

- **Session window:** rolling 5 hours
- **Weekly window:** rolling 7 days

Percentages are calculated against the plan limits you configure. Without configured limits, raw token counts are shown.

---

## Privacy

- No data is sent anywhere except claude.ai and api.anthropic.com, using your own Claude Code OAuth token.
- The token is read locally from `~/.claude/.credentials.json` (read-only) and never stored or transmitted anywhere other than as the `Authorization` header on requests to Anthropic's own servers.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages, token counts, and reset timestamps — no token, no cookies, no personal data.

---

## Troubleshooting

**Tooltip says `(local estimate)` instead of `(live)`**

The live API sources couldn't authenticate. The usual cause is a missing or expired Claude Code OAuth token. Fix it by making sure Claude Code is logged in:
1. Run `claude` in a terminal and complete the login if prompted.
2. Confirm `~/.claude/.credentials.json` exists and `claudeAiOauth.accessToken` is present and not expired.
3. Click the status bar item (or run **Claude Usage: Refresh Now**) to force a refresh.

**Tooltip shows session + weekly but no per-model rows**

You're on the **inference-headers** source (claude.ai rejected the token but `api.anthropic.com` accepted it). This source only exposes 5-hour and 7-day utilization. To get the full per-model breakdown, run the Electron overlay, which can fall back to a one-time claude.ai login window.

**Status bar shows `—` or raw token counts instead of percentages**

The extension fell back to local JSONL and no plan limits are configured. Either:
- Ensure Claude Code is logged in so the live API works (see above), or
- Set `claudeUsage.sessionLimitTokens` (and the weekly limits) in VS Code settings to match your plan.

---

## License

MIT
