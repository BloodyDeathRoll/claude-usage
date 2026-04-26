# claude-usage — port live-data path to pure Node

## Why

The status bar was showing wildly wrong numbers (e.g. 5% / 4%) compared to
`claude.ai/settings/usage` (30% / 13%). Cause: the extension's *live* path was
disabled, so it fell back to a local JSONL token-counter that doesn't match
Anthropic's accounting.

The live path itself is correct — it queries
`https://claude.ai/api/organizations/{orgId}/usage`, the exact endpoint the
settings page uses, and reads the `utilization` / `resets_at` fields verbatim.
It was failing for one reason: the cookie reader was a Python subprocess and
`python3` wasn't on the user's PATH, so `readCookies()` returned `null` and the
extension fell through to the local estimator.

## What changed in this commit

The Python dependency is gone. `browserCookies.js` is now pure Node. No
`python3`, no native modules, no platform-specific binaries.

| File | Change |
|---|---|
| `vscode-extension/package.json` | added `"sql.js": "^1.10.3"` (pure-JS SQLite via WASM) |
| `vscode-extension/src/browserCookies.js` | full rewrite — see below |
| `vscode-extension/src/claudeApi.js` | `readCookies()` is async now → added `await` |
| `vscode-extension/extension.js` | dropped `hasPython` import + the Python-required warning; replaced with a generic "log in to claude.ai in a supported browser" hint |

### New cookie-reader coverage

| Browser | Linux | macOS | Windows |
|---|---|---|---|
| Firefox | ✔ plaintext SQLite | ✔ plaintext SQLite | ✔ plaintext SQLite |
| Chrome / Chromium / Brave / Edge / Vivaldi | ✔ AES-128-CBC, peanuts key | ✔ AES-128-CBC, Keychain-derived key (`security find-generic-password`) | ✔ AES-256-GCM, master key DPAPI-unwrapped via PowerShell |
| Opera | ✔ (Linux only) | — | — |

Implementation notes:
- SQLite reads go through `sql.js` (WASM). The DB is copied to a tempfile,
  read into a buffer, and the tempfile is deleted before sql.js opens it — the
  copy avoids contention with a running browser.
- Cookie queries filter by expiry (`expiry > now` for Firefox, `expires_utc >
  now` for Chromium) so we never pick up a stale `sessionKey`.
- macOS: shells out to `security find-generic-password -a <Browser> -s
  "<Browser> Safe Storage"` to pull the Chromium key from Keychain. On first
  run a Keychain dialog appears; clicking **Always Allow** suppresses future
  prompts (without it, the dialog reappears every refresh).
- Windows: shells out to PowerShell with `-EncodedCommand` to call
  `[System.Security.Cryptography.ProtectedData]::Unprotect` for DPAPI
  unwrapping. No native binary needed.
- Firefox detection: also fixed a typo from the old Python script that pointed
  Linux Firefox at `~/.config/mozilla/firefox` (lowercase, wrong) instead of
  `~/.mozilla/firefox`.
- Decrypt helpers (`decryptCbc` / `decryptGcm`) return `''` when the version
  prefix isn't `v10` / `v11`. Earlier draft returned the raw encrypted bytes
  decoded as UTF-8 — that masqueraded as a valid cookie and produced a
  confusing 403 from the API on Chrome ≥127 (`v20` prefix). Skipping cleanly
  lets us fall through to the next browser instead.

### Known limitations

- **Chrome ≥ 127 "v20" app-bound encryption** isn't handled. claude.ai's
  `sessionKey` cookie typically still uses v10/v11, so this should be fine. If
  it ever breaks for you on Chrome, Firefox is the trivial fallback (plaintext
  on every OS). Cookies with a `v20` prefix are now skipped (see decrypt
  helpers note above) rather than corrupting the result.
- **Chromium profiles**: only the `Default` profile is searched. Multi-profile
  users who keep claude.ai in `Profile 1` etc. would need that added.
- **WAL mode**: only the main `Cookies` file is read. If a browser flushed a
  cookie write only to the WAL, we'd miss it until the next checkpoint. Not
  expected to matter for `sessionKey` (rarely changes).
- **Linux Chrome with kwallet/gnome-keyring**: even with a fix to use
  `--password-store=basic`, *existing* cookies were encrypted under the
  keyring-derived key and won't decrypt with the basic-store fallback. A fresh
  login to claude.ai is required after the switch.

## Tasks remaining (run these on the Linux machine)

```bash
cd vscode-extension

# 1. Install runtime dep (sql.js). Skip dev deps to keep the .vsix lean.
npm install --omit=dev

# 2. Build the .vsix. Use the locally-installed vsce; npx will fetch it if
#    @vscode/vsce isn't in devDependencies anymore.
npx --yes @vscode/vsce package

# 3. Reinstall the extension.
code --uninstall-extension shahar.claude-usage || true
code --install-extension claude-usage-0.1.0.vsix --force
```

Then in VS Code: **Ctrl+Shift+P → Developer: Reload Window**.

### How to verify it's working

1. Open `claude.ai/settings/usage` in any installed browser, log in, leave the
   tab open at least once so the cookies are written.
2. Hover the status-bar item. The tooltip header should read **`Claude Usage
   (live)`**, not `(local estimate)`.
3. The session % and weekly % in the tooltip should match the percentages on
   the claude.ai page exactly (give or take the 15-second poll interval).
4. Reset countdowns should match too — e.g. "resets 3h 30m".

### If it doesn't work

- **Tooltip still says "local estimate"**: the cookie read failed. Most likely
  cause: not logged in to claude.ai in any of the supported browsers, or the
  browser is a flavor we don't search (e.g. LibreWolf, Arc on Windows). Run
  the **`Claude Usage: Refresh Now`** command — it'll pop a warning naming
  the supported browsers.
- **Status bar shows `Cloudflare`-ish errors**: open `claude.ai` in your
  browser, complete the human-check, then hit `Refresh Now`. The
  `cf_clearance` cookie has to be fresh.
- **Linux Chrome with kwallet/gnome-keyring**: the `peanuts` fallback won't
  decrypt cookies. Either switch Chrome's password store to "Basic" (start
  Chrome with `--password-store=basic`) or use Firefox.
- **macOS Keychain dialog**: approve once with "Always Allow".

## Files referenced

- `vscode-extension/src/browserCookies.js` — the rewritten reader
- `vscode-extension/src/claudeApi.js:5` — `await readCookies()` (cookie wiring)
- `vscode-extension/src/claudeApi.js:37` — the `/api/organizations/{orgId}/usage`
  request that produces the live numbers
- `vscode-extension/extension.js:107` — `fetchUsage()` call site, with the
  generic "log in to a supported browser" warning at line 119
