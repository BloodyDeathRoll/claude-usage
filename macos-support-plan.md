# macOS Overlay Support — Implementation Plan (future work)

Status: **not implemented.** This is a design sketch, not shipped code. Written
2026-07-23. macOS is deliberately excluded from every VSIX through 0.4.x (see the
`TARGETS` comment in `vscode-extension/scripts/build.js`).

## Why macOS is blocked today

The extension bundles the Electron runtime so the user installs nothing else. On
Windows/Linux the runtime is a plain binary tree that zips into a VSIX fine. On
macOS, Electron ships as `Electron.app`, whose frameworks depend on symlinks like
`Versions/Current → A`:

- **vsce (the packager) chokes on them** — its scanner walks the tree and dies with
  `EISDIR` on the symlinked directories.
- **A VSIX is a zip**, and extraction does not reliably preserve those directory
  symlinks, so the unpacked `.app` would be structurally broken and wouldn't launch.

## Core idea: ship the `.app` as a tarball, unpack at first run

Don't ship the `.app` as a live tree. Ship it as one opaque `.tar.gz` (tar preserves
symlinks + exec bits natively; vsce sees a single blob → no `EISDIR`, no symlink loss),
and restore it on the user's machine at first launch.

## 1. Build changes — `vscode-extension/scripts/build.js`

- Add `darwin-x64` + `darwin-arm64` to `TARGETS`.
- `stageElectron()` currently copies the runtime tree. Add a darwin branch:
  1. `@electron/get` returns a **zip** containing the `.app` with symlinks. Extract it
     on Linux with a **symlink-preserving** extractor — `extract-zip` (current dep) does
     NOT reliably keep symlinks; use the `unzip` CLI or a tar-aware path.
     **← GOTCHA #1: verify symlinks survive extraction on the Linux build box.**
  2. Re-pack the `.app` as `electron/darwin-<arch>/electron.app.tar.gz` via system `tar`.
- `verifyVsix()` for darwin: assert the tarball exists and, un-tarred, contains
  `Electron.app/Contents/MacOS/Electron` with an intact `Versions/Current → A` symlink.

## 2. Runtime changes — `vscode-extension/extension.js`

- New `ensureDarwinRuntime()`, called before launch on darwin: if the `.app` isn't
  already extracted, `tar -xzf` the bundled tarball into a **writable, persistent** dir —
  `context.globalStorageUri.fsPath` (the extension dir can be read-only / wiped on
  update). Guard with a version marker so it re-extracts only when the bundled runtime
  changes (same idempotent pattern as the existing `ensureExecutable()`).
- `getElectronBin()`: on darwin, return
  `<globalStorage>/electron/darwin-<arch>/Electron.app/Contents/MacOS/Electron`.
- `ensureExecutable()`: extend to chmod the darwin binary + helper apps
  (`Electron Helper*.app/Contents/MacOS/*`).
- **Identity unchanged**: the overlay is passed as an argv *directory*
  (`electron <overlayDir>`), never injected into the `.app`, so the official
  notarization stays intact and the `userData`/cookie-jar rule holds (staged manifest
  mirrors `name`, no `productName` — see the handoff's failed-attempts on the sign-in
  window regression).

## 3. Signing / Gatekeeper — smaller than originally feared

- Official Electron prebuilts are **already signed & notarized** by the Electron team.
  Because we keep the `.app` pristine (overlay runs as an argument), that signature
  survives → **likely no need for your own Developer ID signing.**
- Native-addon library validation is **NOT a problem** — VERIFIED 2026-07-23: the staged
  overlay `node_modules` has zero `.node` files and no `fsevents`. `fsevents` is a
  macOS-only optionalDependency of `chokidar`; because deps are installed on Linux at
  build time it's skipped, and chokidar falls back to `fs.watch` on macOS (works fine).
  Keep installing overlay deps on Linux so no native addon ever enters the bundle.
- Remaining risk is **quarantine** (`com.apple.quarantine` on extracted files). Apps
  launched via `spawn()`/execve usually bypass Gatekeeper's LaunchServices gate, but the
  extraction step can `xattr -dr com.apple.quarantine <app>` to be safe.
  **← GOTCHA #2: must confirm on a real Mac.**

## 4. Distribution / size

- Adding two mac runtimes to the **universal** VSIX pushes it from 382 MB to ~560 MB+.
  Painful for the single-file web-upload publish path.
- Clean answer: **platform-specific VSIXes** (`--target darwin-x64` / `darwin-arm64`) so
  Mac users download only their ~95 MB runtime. `build.js` already supports `--target`;
  this pairs naturally with the still-open "publish platform packages" item — blocked on
  an Azure DevOps org / PAT with Marketplace→Manage scope (see handoff).

## 5. The real cost: testing (the crux)

The build + runtime scaffolding can all be written on the Linux box, but **none of it can
be validated there.** Needs an actual **Intel + Apple Silicon Mac** to confirm:
extraction-preserves-symlinks, Gatekeeper doesn't block the spawn, quarantine handling,
overlay renders, claude.ai session reused with no login prompt. That validation loop is
the bulk of the effort and the reason this is its own project, not a bug fix.

## Rough effort

- Build + runtime scaffolding: ~half a day (doable on Linux, fully additive — zero change
  to the working Windows/Linux paths).
- Mac validation + iterating on quarantine/Gatekeeper surprises: unknown, gated on having
  Macs to test.

## Two verified facts to carry forward (checked 2026-07-23)

1. Overlay bundle has **no native addons / no fsevents** → hardened-runtime library
   validation is a non-issue as long as deps keep being installed on Linux.
2. Overlay launches as `electron <overlayDir>` (argv), so the official Electron `.app`
   is never modified → its Apple notarization is preserved.
