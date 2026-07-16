#!/usr/bin/env node
//
// Builds platform-specific VSIXes with the overlay app and an Electron runtime
// baked in, so installing the extension is the only step a user ever takes.
//
//   node scripts/build.js                        # host platform only (dev)
//   node scripts/build.js --all                  # every target
//   node scripts/build.js --target win32-x64 ...
//
// The overlay app is copied from the repo root at build time, so the root stays
// the single source of truth and the bundled copy can never drift from the
// standalone one.

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_DIR   = path.join(__dirname, '..');
const REPO_ROOT = path.join(EXT_DIR, '..');
const OVERLAY   = path.join(EXT_DIR, 'overlay');
const ELECTRON  = path.join(EXT_DIR, 'electron');

const ROOT_PKG = require(path.join(REPO_ROOT, 'package.json'));

// Prefer the exact Electron the repo has installed — the build the standalone
// overlay is known to run on. Fall back to the range floor if node_modules is
// absent.
const ELECTRON_VERSION = (() => {
  try { return require(path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json')).version; }
  catch { return ROOT_PKG.devDependencies.electron.replace(/^[\^~]/, ''); }
})();

// VS Code target → Electron platform/arch.
//
// macOS is deliberately absent. Electron ships there as an .app bundle whose
// frameworks rely on `Versions/Current -> A` directory symlinks; vsce cannot
// scan them (EISDIR) and a VSIX zip does not reliably preserve them, so the
// extracted bundle would be broken even if it packaged. Shipping macOS needs a
// different approach (and code signing) — it is not solved here.
const TARGETS = {
  'win32-x64':    { platform: 'win32',  arch: 'x64'   },
  'win32-arm64':  { platform: 'win32',  arch: 'arm64' },
  'linux-x64':    { platform: 'linux',  arch: 'x64'   },
  'linux-arm64':  { platform: 'linux',  arch: 'arm64' },
};

// Everything the overlay needs at runtime, relative to the repo root.
const APP_FILES = ['main.js', 'preload.js'];
const APP_DIRS  = ['renderer', 'src', 'assets'];

// Chromium ships 55 locale packs (~38 MB). The overlay's UI is English-only.
const KEEP_LOCALES = new Set(['en-US.pak']);

const log = m => process.stdout.write(m + '\n');
const rmrf = p => fs.rmSync(p, { recursive: true, force: true });
const mb = b => (b / 1048576).toFixed(1) + ' MB';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function dirSize(p) {
  let total = 0;
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) total += fs.statSync(f).size;
    }
  };
  if (fs.existsSync(p)) walk(p);
  return total;
}

// ── Stage the overlay app ─────────────────────────────────────────────────────

function stageOverlay() {
  log('▸ Staging overlay app from repo root');
  rmrf(OVERLAY);
  fs.mkdirSync(OVERLAY, { recursive: true });

  for (const f of APP_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (!fs.existsSync(src)) throw new Error(`missing overlay file: ${f}`);
    fs.copyFileSync(src, path.join(OVERLAY, f));
  }
  for (const d of APP_DIRS) {
    const src = path.join(REPO_ROOT, d);
    if (!fs.existsSync(src)) throw new Error(`missing overlay dir: ${d}`);
    copyDir(src, path.join(OVERLAY, d));
  }

  // `electron <dir>` reads main + name from this manifest.
  //
  // `name` MUST stay byte-identical to the repo root's, and productName MUST NOT
  // be introduced. Electron derives app.getName() (productName first, else name)
  // and from it userData — where the claude.ai session cookies live. Changing the
  // identity hands the overlay an empty cookie jar, so it would demand a fresh
  // login instead of reusing the session the user already has.
  fs.writeFileSync(path.join(OVERLAY, 'package.json'), JSON.stringify({
    name: ROOT_PKG.name,
    version: ROOT_PKG.version,
    main: ROOT_PKG.main,
    dependencies: ROOT_PKG.dependencies,
  }, null, 2));

  const staged = JSON.parse(fs.readFileSync(path.join(OVERLAY, 'package.json'), 'utf8'));
  if (staged.name !== ROOT_PKG.name || staged.productName) {
    throw new Error('overlay identity drifted from repo root — would orphan session cookies');
  }

  // The overlay requires chokidar/glob at runtime; install them into the staged
  // app so the shipped copy needs no install on the user's machine.
  log('▸ Installing overlay runtime deps');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
    cwd: OVERLAY, stdio: 'inherit',
  });
  for (const dep of Object.keys(ROOT_PKG.dependencies)) {
    if (!fs.existsSync(path.join(OVERLAY, 'node_modules', dep))) {
      throw new Error(`overlay dep ${dep} did not install — would fail at runtime`);
    }
  }

  log(`  overlay staged: ${mb(dirSize(OVERLAY))}`);
}

// ── Fetch + trim an Electron runtime ──────────────────────────────────────────

async function stageElectron(target) {
  const { platform, arch } = TARGETS[target];
  const { downloadArtifact } = require('@electron/get');
  const extract = require('extract-zip');

  log(`▸ Fetching Electron ${ELECTRON_VERSION} for ${platform}-${arch}`);
  const zip = await downloadArtifact({
    version: ELECTRON_VERSION, platform, arch, artifactName: 'electron',
  });

  rmrf(ELECTRON);
  fs.mkdirSync(ELECTRON, { recursive: true });
  await extract(zip, { dir: ELECTRON });

  const before = dirSize(ELECTRON);

  // Drop unused locale packs. On macOS they live inside the .app bundle.
  const localeDirs = [
    path.join(ELECTRON, 'locales'),
    path.join(ELECTRON, 'Electron.app', 'Contents', 'Frameworks',
      'Electron Framework.framework', 'Resources'),
  ];
  for (const dir of localeDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pak') && !KEEP_LOCALES.has(f)) fs.rmSync(path.join(dir, f));
      if (f.endsWith('.lproj') && f !== 'en.lproj') rmrf(path.join(dir, f));
    }
  }

  // Do NOT delete resources/default_app.asar. It is not just Electron's welcome
  // screen — it implements `electron <app-dir>`, which is the only reason passing
  // the overlay path works. Without it the binary exits silently with no output.
  const defaultApp = platform === 'darwin'
    ? path.join(ELECTRON, 'Electron.app', 'Contents', 'Resources', 'default_app.asar')
    : path.join(ELECTRON, 'resources', 'default_app.asar');
  if (!fs.existsSync(defaultApp)) {
    throw new Error('default_app.asar missing — `electron <dir>` would not work');
  }

  log(`  electron staged: ${mb(before)} → ${mb(dirSize(ELECTRON))}`);
}

// ── Package ───────────────────────────────────────────────────────────────────

function packageVsix(target) {
  log(`▸ Packaging VSIX for ${target}`);
  execFileSync('npx', ['--no-install', 'vsce', 'package', '--target', target], {
    cwd: EXT_DIR, stdio: 'inherit',
  });
  const version = require(path.join(EXT_DIR, 'package.json')).version;
  const vsix = path.join(EXT_DIR, `tracker-claude-usage-${target}-${version}.vsix`);
  if (!fs.existsSync(vsix)) throw new Error(`expected VSIX not produced: ${vsix}`);
  log(`  ✓ ${path.basename(vsix)} — ${mb(fs.statSync(vsix).size)}`);
  return vsix;
}

// Guard the two failure modes that are invisible until a user hits them: a VSIX
// with no Electron binary, or one with no overlay entry point.
function verifyVsix(vsix, target) {
  const out = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n');
  const { platform } = TARGETS[target];
  const bin = platform === 'win32' ? 'extension/electron/electron.exe'
    : platform === 'darwin' ? 'extension/electron/Electron.app/Contents/MacOS/Electron'
    : 'extension/electron/electron';
  const required = [
    bin,
    'extension/overlay/main.js',
    'extension/overlay/renderer/index.html',
    'extension/overlay/node_modules/chokidar/package.json',
    platform === 'darwin'
      ? 'extension/electron/Electron.app/Contents/Resources/default_app.asar'
      : 'extension/electron/resources/default_app.asar',
  ];
  for (const f of required) {
    if (!out.includes(f)) throw new Error(`VSIX for ${target} is missing ${f}`);
  }
  log(`  ✓ verified: electron binary, overlay entry point, deps and default_app all present`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  let targets;
  if (argv.includes('--all')) {
    targets = Object.keys(TARGETS);
  } else if (argv.includes('--target')) {
    targets = argv.reduce((a, v, i) => (v === '--target' ? [...a, argv[i + 1]] : a), []);
    for (const t of targets) {
      if (t.startsWith('darwin')) {
        throw new Error('macOS is not a supported bundle target — see the TARGETS comment in this file');
      }
      if (!TARGETS[t]) throw new Error(`unknown target: ${t}\nknown: ${Object.keys(TARGETS).join(', ')}`);
    }
  } else {
    const t = `${process.platform}-${process.arch}`;
    if (!TARGETS[t]) throw new Error(`unsupported host: ${t}`);
    targets = [t];
    log(`(no --target/--all given; building host target ${t} only)`);
  }

  stageOverlay();

  const built = [];
  for (const target of targets) {
    await stageElectron(target);
    const vsix = packageVsix(target);
    verifyVsix(vsix, target);
    built.push(vsix);
  }

  // The staged runtime is a build artifact, not source.
  rmrf(ELECTRON);

  log('\nBuilt:');
  for (const b of built) log('  ' + path.basename(b));
}

main().catch(err => { console.error('\nBUILD FAILED:', err.message); process.exit(1); });
