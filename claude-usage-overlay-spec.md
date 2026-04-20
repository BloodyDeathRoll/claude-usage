# Claude Usage Overlay — Build Spec

## Overview

Build an Electron desktop overlay app called `claude-usage-overlay` that sits on top of all windows and displays Claude Code token usage in real time. The app reads local session data written by Claude Code, requires no API calls, and is designed for Ubuntu Linux.

---

## Goals

- Always-on-top, draggable, frameless widget
- Minimizable to system tray
- Shows **current session** token usage and **weekly** token usage
- Reads directly from `~/.claude/projects/**/*.jsonl` — no network calls
- Auto-refreshes every 10 seconds via file watching

---

## Stack

- **Runtime:** Electron (v30+)
- **UI:** Vanilla JS / HTML / CSS — no React, no framework
- **File watching:** `chokidar` (more reliable than `fs.watch` on Linux)
- **Build:** `electron-builder` targeting Linux (AppImage + deb)
- **No native dependencies**

---

## File Structure

```
claude-usage-overlay/
├── package.json
├── main.js               # Electron main process
├── preload.js            # Secure IPC bridge (contextBridge)
├── renderer/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── src/
    └── usageParser.js    # JSONL scanner and aggregator
```

---

## Data Source

Claude Code writes one JSONL file per session to `~/.claude/projects/`. Each line is a JSON object. Lines where the role is `assistant` contain a `usage` field with the following shape:

```json
{
  "input_tokens": 1200,
  "output_tokens": 340,
  "cache_read_input_tokens": 5000,
  "cache_creation_input_tokens": 800
}
```

Parse defensively — malformed or incomplete lines must be skipped without crashing.

---

## usageParser.js — Logic

### Current Session
- Find all `.jsonl` files under `~/.claude/projects/` modified within the last **5 hours** (Claude Code's rolling session window)
- Among those, use the **most recently modified** file as the active session
- Sum all `usage` fields in that file: `input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens`

### Weekly Usage
- Scan all `.jsonl` files modified within the **last 7 days**
- Aggregate the same token fields across all of them

### Return shape
```js
{
  session: { input, output, cacheRead, cacheCreate, total },
  weekly:  { input, output, cacheRead, cacheCreate, total },
  lastUpdated: Date
}
```

---

## main.js — Electron Main Process

### Window
```js
new BrowserWindow({
  width: 300,
  height: 140,
  alwaysOnTop: true,
  frame: false,
  transparent: true,
  resizable: false,
  skipTaskbar: true,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false
  }
})
```

### Dragging
- Renderer sends `{ deltaX, deltaY }` via IPC on `mousemove` while dragging
- Main process calls `win.setPosition(x + deltaX, y + deltaY)`

### Minimize to Tray
- Intercept `close` event → hide window instead of quitting
- Create a `Tray` with a small icon
- Tray click → `win.show()`
- Tray context menu: **Show**, **Quit**

### Data Polling
- On startup, call `usageParser` and send result to renderer via `webContents.send('usage-update', data)`
- Set up `chokidar` watcher on `~/.claude/projects/`
- On any file change, re-parse and push updated data
- Also poll every 10 seconds as fallback

---

## preload.js

Expose a minimal, safe API via `contextBridge`:

```js
contextBridge.exposeInMainWorld('claudeUsage', {
  onUsageUpdate: (cb) => ipcRenderer.on('usage-update', (_, data) => cb(data)),
  startDrag: (delta) => ipcRenderer.send('drag', delta),
  minimize: () => ipcRenderer.send('minimize'),
  openSettings: () => ipcRenderer.send('open-settings')
})
```

---

## renderer/ — UI

### Layout (300×140px pill widget)
```
┌─────────────────────────────────┐
│  ⠿  Claude Usage          _ ⚙  │  ← drag handle, minimize, settings
├─────────────────────────────────┤
│  Session  ████████░░░░  62,400  │
│  Weekly   ███░░░░░░░░░ 180,000  │
│                  last sync 12s  │
└─────────────────────────────────┘
```

- Top bar: drag handle (cursor: grab), minimize button, settings button
- Two rows: label + progress bar + token count
- Progress bar colors: green < 60%, yellow 60–85%, red > 85%
- "Last sync" timestamp at bottom right
- Font: monospace, small (11–12px)
- Background: semi-transparent dark (`rgba(15, 15, 15, 0.88)`)
- Border radius: 12px

### Dragging
- `mousedown` on drag handle → flag `isDragging = true`, record `startX/Y`
- `mousemove` on document → if dragging, send delta to main via `window.claudeUsage.startDrag(delta)`
- `mouseup` → `isDragging = false`

---

## Settings

On first launch (or when `~/.claude-overlay-config.json` doesn't exist), show a simple inline settings panel within the widget:

- Plan selector: **Pro** (44k), **Max5** (88k), **Max20** (220k), **Custom**
- Custom field: numeric input for session token limit
- Weekly limit: auto-calculated as `sessionLimit × 5 × 7 / 5` or user-overridable
- Save to `~/.claude-overlay-config.json`

If no config exists, show progress bars without a limit line (display raw token counts only).

---

## Config File Schema

```json
{
  "plan": "max5",
  "sessionLimitTokens": 88000,
  "weeklyLimitTokens": 440000,
  "position": { "x": 1600, "y": 20 }
}
```

---

## package.json

```json
{
  "name": "claude-usage-overlay",
  "version": "1.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --linux"
  },
  "dependencies": {
    "chokidar": "^3.6.0",
    "glob": "^10.4.0"
  },
  "devDependencies": {
    "electron": "^30.0.0",
    "electron-builder": "^24.13.0"
  },
  "build": {
    "appId": "com.shahar.claude-usage-overlay",
    "productName": "Claude Usage Overlay",
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Utility"
    }
  }
}
```

---

## Autostart on Ubuntu

Generate a `.desktop` file at `~/.config/autostart/claude-usage-overlay.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Claude Usage Overlay
Exec=/path/to/claude-usage-overlay.AppImage
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
```

The app should offer to write this file on first launch (yes/no prompt in the settings panel).

---

## Error Handling

- If `~/.claude/projects/` doesn't exist, show "No Claude Code data found" in the widget
- If a JSONL line fails to parse, skip it silently and continue
- If `chokidar` watch fails, fall back to polling only
- All errors should be caught; the app must never crash on bad data

---

## Out of Scope (Defer)

- Windows / macOS support
- Per-model breakdown in the widget (parse it, but don't display yet)
- Remote usage API (not available from Anthropic yet — tracked in issue #44328)
- Cost estimation display
