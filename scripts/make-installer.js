#!/usr/bin/env node
/**
 * Production installer build.
 *
 * Orchestrates a clean, repeatable release build for this Electron app:
 *   1. Sanity-checks the environment (Node version, deps installed)
 *   2. Generates build/icon.ico from wolf.png if it doesn't exist
 *   3. Builds in a fresh temp directory (so a syncing OneDrive/AV can't
 *      throttle the ~300MB of intermediate writes), then wipes dist/ so
 *      stale artifacts never leak into a release
 *   4. Runs `electron-forge make` (packages the app, then builds the
 *      Squirrel.Windows Setup.exe + portable zip)
 *   5. Copies every artifact into dist/ and prints SHA-256 checksums
 *   6. Always cleans up the temp build dir (even on failure)
 *
 * Usage:  npm run make:installer
 * Output: dist/Halo-<version>-Setup.exe, dist/Halo-<version>-win32-x64.zip
 *
 * Env:  FORGE_OUT=dir   override the temporary build directory (e.g. to keep
 *                       out/ in the project for debugging)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const DIST_DIR = path.join(ROOT, 'dist');
const ICON = path.join(ROOT, 'build', 'icon.ico');
// Invoke Forge through its JS entry so we never need a shell (the .bin/
// wrappers on Windows are .cmd files that force shelling + arg escaping).
const FORGE_ENTRY = path.join(ROOT, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');

const USER_FORGE_OUT = !!process.env.FORGE_OUT;
const BUILD_ROOT = process.env.FORGE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'halo-build-'));

const START = Date.now();
function log(msg) { console.log('\n[make-installer] ' + msg); }
function fail(msg) { throw new Error(msg); }

function run(cmd, args) {
  log('> ' + cmd + ' ' + args.join(' '));
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env: process.env });
  if (res.error) fail(cmd + ' could not be launched: ' + res.error.message);
  if (res.status === null) fail(cmd + ' was killed by signal ' + (res.signal || 'unknown') + ' — aborting.');
  if (res.status !== 0) fail(cmd + ' exited with code ' + res.status + ' — aborting.');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

try {
  // ---- 1. Environment sanity checks ----
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 16) fail('Node 16+ is required (you have ' + process.versions.node + ').');
  if (!fs.existsSync(FORGE_ENTRY)) fail('Electron Forge is not installed — run `npm install` first.');
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) fail('Electron is not installed — run `npm install` first.');

  // ---- 2. App icon (custom, generated from wolf.png) ----
  if (!fs.existsSync(ICON)) {
    log('No build/icon.ico yet — generating from wolf.png…');
    const electronBin = require(path.join(ROOT, 'node_modules', 'electron'));
    run(electronBin, [path.join(ROOT, 'scripts', 'generate-icon.js')]);
  } else {
    log('Reusing existing ' + ICON);
  }
  if (!fs.existsSync(ICON)) fail('Icon generation failed — build/icon.ico is missing.');

  // ---- 3. Clean previous outputs ----
  log('Cleaning ' + DIST_DIR);
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  log('Build dir: ' + BUILD_ROOT);
  process.env.FORGE_OUT = BUILD_ROOT; // forge.config.js honours this

  // ---- 4. Package + make ----
  run(process.execPath, [FORGE_ENTRY, 'make']);

  // ---- 5. Collect artifacts into dist/ with checksums ----
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const artifacts = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) artifacts.push(full);
    }
  })(path.join(BUILD_ROOT, 'make'));

  if (artifacts.length === 0) fail('electron-forge make produced no artifacts under out/make/.');

  const copied = [];
  for (const file of artifacts) {
    const name = path.basename(file);
    const dest = path.join(DIST_DIR, name);
    fs.copyFileSync(file, dest);
    copied.push({ name, size: fs.statSync(dest).size, sha: sha256(dest) });
  }

  // ---- 6. Summary ----
  const setup = copied.find((a) => /Setup\.exe$/i.test(a.name));
  if (!setup) fail('Squirrel installer (Setup.exe) was not produced — check the make output above.');
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('  Build complete in ' + ((Date.now() - START) / 1000).toFixed(1) + 's');
  console.log('  Version:   ' + pkg.version);
  console.log('  Platform:  ' + process.platform + ' / ' + process.arch);
  console.log('────────────────────────────────────────────────────────────');
  for (const a of copied) {
    console.log('  ✔ dist/' + a.name + '  (' + (a.size / 1024 / 1024).toFixed(1) + ' MB)');
    console.log('      sha256  ' + a.sha);
  }
  console.log('\n  Installer ready: ' + path.join(DIST_DIR, setup.name));
  console.log('────────────────────────────────────────────────────────────\n');
} catch (err) {
  console.error('\n[make-installer] ERROR: ' + err.message);
  process.exitCode = 1;
} finally {
  // ---- 7. Clean up the temp build dir (unless the user chose FORGE_OUT) ----
  if (!USER_FORGE_OUT && fs.existsSync(BUILD_ROOT)) {
    log('Cleaning up ' + BUILD_ROOT);
    fs.rmSync(BUILD_ROOT, { recursive: true, force: true });
  }
}
