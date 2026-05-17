# Claude Usage Monitor

Real-time Claude Code token usage in your VS Code status bar. Shows the **exact same percentages** as the claude.ai Plan Usage Limits page — session usage, weekly usage, and extra credits — updated every 15 seconds.

**Click the status bar item** to launch the always-on-top floating overlay. On first click the overlay installs itself automatically — no manual steps, no cloning, no `npm install`.

---

## Components

| Component | What it does |
|-----------|-------------|
| **VS Code Extension** | Status bar item with live usage + tooltip |
| **Electron Overlay** | Always-on-top floating widget — launched by clicking the status bar, auto-installs on first use |

The two share a cache file. The overlay writes full per-model data (Sonnet, Claude Design) that the extension reads automatically for its tooltip.

---

## VS Code Extension

### Installation

#### Option A — Install from `.vsix` (recommended for all platforms)

1. Download `claude-usage-0.1.8.vsix` from the [latest release](https://github.com/BloodyDeathRoll/claude-usage/releases/latest).

2. Install via the **VS Code UI** — works on Windows, macOS, and Linux with no CLI quirks:
   - Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click the `···` menu at the top right
   - Choose **Install from VSIX…**
   - Select the downloaded file
   - Reload when prompted (`Ctrl+Shift+P` → **Developer: Reload Window**)

   Or via terminal:

   **Linux / macOS:**
   ```bash
   code --install-extension claude-usage-0.1.8.vsix
   ```

   **Windows PowerShell** (must use `code.cmd`, not `Code.exe`):
   ```powershell
   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" --install-extension claude-usage-0.1.8.vsix
   ```

3. Click the `☁ Session: …` item in the status bar. The overlay installs itself on first click (downloads Electron via `npm install` into `~/.claude-usage-overlay` — takes about a minute) then launches automatically.

#### Option B — Build from source

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage/vscode-extension
npm install
npx vsce package           # produces claude-usage-0.1.8.vsix
code --install-extension claude-usage-0.1.8.vsix
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

**Click** to launch the overlay. **Hover** for a tooltip with mini progress bars and reset countdowns. Run **Claude Usage: Refresh Now** from the command palette to force a data update.

---

### Requirements

| Requirement | Notes |
|-------------|-------|
| VS Code 1.85+ | |
| Node.js + npm | Required for the overlay's first-time auto-install. Already present on any machine that has Claude Code. |
| Claude Code | Provides the OAuth token for live usage data. Without it the extension shows local JSONL estimates. |

No Python. No browser. No manual setup.

---

### How it gets data

Three sources tried in order, stopping at the first success:

1. **Overlay cache** (`~/.claude-usage-cache.json`) — written by the overlay every 10 seconds. Includes full per-model breakdown (Sonnet, Claude Design). Used if less than 10 minutes old.

2. **Claude Code OAuth token** — reads `~/.claude/.credentials.json` and calls `api.anthropic.com/v1/messages` with the `anthropic-beta: oauth-2025-04-20` header. Usage comes back in rate-limit response headers (5h session + 7d all-models). No browser, no Cloudflare bypass.

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
| `claudeUsage.overlayPath` | `null` | Override the overlay install location. Leave null to use the auto-managed `~/.claude-usage-overlay`. |

---

### Commands

| Command | Description |
|---------|-------------|
| **Claude Usage: Open Overlay** | Launch the overlay (same as clicking the status bar). |
| **Claude Usage: Refresh Now** | Force an immediate data refresh. |

---

### Troubleshooting

**Tooltip shows `(local estimate)` instead of `(live)`**

The OAuth token is missing or expired:
- Claude Code has never been run on this machine — no `~/.claude/.credentials.json` exists yet.
- The token expired — run `claude` once to refresh it.

**Status bar shows `—` or raw token counts**

The extension fell back to local JSONL and no plan limits are configured. Run Claude Code once (to create the OAuth token), or set `claudeUsage.sessionLimitTokens` in settings.

**Overlay setup failed**

If the auto-install fails (e.g. npm not on PATH), you can set it up manually:
```bash
# The extension extracts the overlay source to this location:
cd ~/.claude-usage-overlay
npm install
```
Then click the status bar item again.

---

## Electron Overlay

The overlay is an always-on-top desktop widget with live progress bars, a reset countdown, and a settings panel. It is bundled inside the `.vsix` and installed automatically to `~/.claude-usage-overlay` on first use.

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

### Running from source (optional)

If you want to run the overlay from a local clone instead of the auto-managed install:

```bash
git clone https://github.com/BloodyDeathRoll/claude-usage.git
cd claude-usage
npm install
npm start
```

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
Usage percentages come back in response headers. No browser interaction.

### Electron overlay — claude.ai internal API

Makes requests from inside a hidden Chromium `BrowserWindow`, passing Cloudflare checks via the stored session cookie. Calls:
```
GET claude.ai/api/organizations/{orgId}/usage
```
The org ID comes from the `lastActiveOrg` cookie. Returns full per-model breakdowns. Results are cached to `~/.claude-usage-cache.json`.

### Local JSONL fallback

Parses `~/.claude/projects/**/*.jsonl`, deduplicates by `message.id`, and aggregates token counts over rolling 5h and 7d windows.

---

## Privacy

- No data leaves your machine except requests to `api.anthropic.com` using your own OAuth token.
- The cache file `~/.claude-usage-cache.json` contains only usage percentages and token counts — no credentials.

---

## License

MIT
