# Claude Usage Monitor

Real-time Claude Code token usage in your VS Code status bar. Shows the **exact same percentages** as the claude.ai Plan Usage Limits page — session usage, weekly usage, and extra credits — updated every 15 seconds.

**Click the status bar item** to open a full detail panel inside VS Code with progress bars, per-model breakdown, and reset countdowns. No extra installs required on any platform.

---

## Components

| Component | What it does | Required? |
|-----------|-------------|-----------|
| **VS Code Extension** | Status bar item + click-to-detail panel | ✅ Core |
| **Electron Overlay** | Always-on-top floating desktop widget | Optional |

The two share a cache file. When the Electron overlay is running it writes richer per-model data (Sonnet, Claude Design) that the extension reads automatically.

---

## VS Code Extension

### Installation

#### Option A — Install from `.vsix` (recommended for all platforms)

1. Download `claude-usage-0.1.7.vsix` from the [latest release](https://github.com/BloodyDeathRoll/claude-usage/releases/latest).

2. Install via the **VS Code UI** (works on Windows, macOS, and Linux — no CLI quirks):
   - Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click the `···` menu at the top right
   - Choose **Install from VSIX…**
   - Select the downloaded file
   - Reload when prompted (`Ctrl+Shift+P` → **Developer: Reload Window**)

   Or via terminal:

   **Linux / macOS:**
   ```bash
   code --install-extension claude-usage-0.1.7.vsix
   ```

   **Windows PowerShell** (must use `code.cmd`, not `Code.exe`):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" --install-extension claude-usage-0.1.7.vsix
   ```

#### Option B — Build from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage/vscode-extension
npm install
npx vsce package           # produces claude-usage-0.1.7.vsix
code --install-extension claude-usage-0.1.7.vsix
```

> **Not on the VS Code Marketplace yet.** Distributed via `.vsix` only.

---

### What you see

The status bar item (bottom-right) shows:

```
☁ Session: 61% · Weekly: 75% · Extra: 12%
```

- **Session** — your 5-hour rolling usage window
- **Weekly** — your 7-day rolling usage window
- **Extra** — paid credits consumed (only shown when active)

Color changes automatically: yellow at 60–85%, red above 85%.

**Click** the item to open the detail panel. **Hover** for a tooltip with mini progress bars. Run **Claude Usage: Refresh Now** from the command palette to force an update.

---

### Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code 1.85+ | |
| Claude Code | Provides the OAuth token. Without it the extension falls back to local JSONL counting. |

No Python. No browser. No native modules. No extra installs. The extension is completely self-contained.

---

### How it gets data

Three sources tried in order, stopping at the first success:

1. **Overlay cache** (`~/.claude-usage-cache.json`) — written by the optional Electron overlay every 10 seconds. Includes full per-model breakdown (Sonnet, Claude Design). Used if less than 10 minutes old.

2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `anthropic-beta: oauth-2025-04-20` header. Usage comes back in rate-limit response headers (5h session + 7d all-models). No browser, no Cloudflare bypass, no cookies.

3. **Local JSONL** — parses `~/.claude/projects/**/*.jsonl` and estimates percentages against your configured plan limits.

The tooltip shows which source is active: `Claude Usage (live)` vs `Claude Usage (local estimate)`.

---

### Configuration

`Ctrl+,` → search **Claude Usage**:

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.sessionLimitTokens` | `null` | Session token limit. Pro=320000, Max5=1600000, Max20=6400000. Local fallback only. |
| `claudeUsage.weeklyLimitTokens` | `null` | Weekly token limit. Local fallback only. |
| `claudeUsage.weeklyModelLimits` | `null` | Per-model weekly limits, e.g. `{"sonnet": 436000, "haiku": 25000}`. Local fallback only. |
| `claudeUsage.overlayPath` | `null` | Path to the Electron overlay repo (optional). Only needed if you use the external overlay and it isn't auto-detected. |

---

### Commands

| Command | Description |
|---------|-------------|
| **Claude Usage: Show Detail Panel** | Opens the usage detail panel (same as clicking the status bar). |
| **Claude Usage: Refresh Now** | Force an immediate data refresh. |
| **Claude Usage: Open External Overlay (optional)** | Launches the Electron overlay if you have it set up. |

---

### Troubleshooting

**Tooltip shows `(local estimate)` instead of `(live)`**

The OAuth token is missing or expired:
- Claude Code has never been run on this machine — no `~/.claude/.credentials.json` exists yet.
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts**

The extension fell back to local JSONL and no plan limits are configured. Run Claude Code once (to create the OAuth token), or set `claudeUsage.sessionLimitTokens` in settings.

**External overlay not launching** (only relevant if you use the optional Electron overlay)

The `claudeUsage.openExternalOverlay` command searches these paths automatically:

| Platform | Paths checked |
|----------|--------------|
| Linux / macOS | `~/Projects/claude-usage`, `~/Projects/usage`, `~/Documents/Projects/claude-usage` |
| Windows | `~\Documents\Projects\claude-usage`, `~\OneDrive\Documents\Projects\claude-usage`, `~\OneDrive\Projects\claude-usage` |

If your repo is elsewhere, set `claudeUsage.overlayPath` in VS Code settings. If `npm install` hasn't been run in the overlay repo yet, the error dialog has a **Copy Command** button.

---

## Electron Overlay (optional floating widget)

The overlay is an always-on-top desktop widget with live progress bars, reset countdown, and a settings panel. It also writes the richer per-model cache the extension reads.

### Requirements

- Node.js 18+
- npm

### Running from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage
npm install
npm start
```

The overlay appears as a small dark widget. Drag it anywhere; position is remembered between launches.

### Controls

| Action | How |
|--------|-----|
| Move | Click and drag anywhere on the widget |
| Minimize to tray | Click the `−` button |
| Restore from tray | Click the tray icon |
| Open settings | Click the `⚙` button |
| Quit | Right-click tray icon → Quit |

### Settings panel

| Plan | Session limit | Weekly limit |
|------|--------------|--------------|
| Pro | 320,000 tokens | 461,000 tokens |
| Max5 | 1,600,000 tokens | 2,300,000 tokens |
| Max20 | 6,400,000 tokens | 9,200,000 tokens |
| Custom | Your choice | 5× session limit |

### Building a distributable

**Linux** (`.AppImage` + `.deb`):
```bash
npm run build:linux
```

**macOS** (`.dmg` — must run on macOS):
```bash
npm run build:mac
```

---

## How it works

### VS Code extension — OAuth inference headers

Reads `~/.claude/.credentials.json` and calls:
```
POST api.anthropic.com/v1/messages   (anthropic-beta: oauth-2025-04-20)
```
Usage percentages come back in response headers (`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`). No browser interaction.

### Electron overlay — claude.ai internal API

Makes requests from inside a hidden Chromium `BrowserWindow`, which passes Cloudflare checks using the stored session cookie. Calls:
```
GET claude.ai/api/organizations/{orgId}/usage
```
The org ID comes from the `lastActiveOrg` cookie. Returns full per-model breakdowns (Sonnet, Claude Design, extra credits). Results are cached to `~/.claude-usage-cache.json`.

### Local JSONL fallback

Parses `~/.claude/projects/**/*.jsonl`, deduplicates by `message.id` (Claude Code writes each message twice during streaming), and aggregates token counts over rolling 5h and 7d windows.

---

## Privacy

- No data leaves your machine except requests to `api.anthropic.com` using your own OAuth token.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no credentials.

---

## License

MIT
