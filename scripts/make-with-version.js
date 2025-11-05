#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(...args) { console.log('[make-with-version]', ...args); }

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
let pkg = { version: '0.0.0' };
try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { /* ignore */ }
const version = String(pkg.version || '0.0.0');

// Run electron-forge make
log('Running electron-forge make...');
const res = spawnSync('electron-forge', ['make'], { stdio: 'inherit', shell: true, cwd: repoRoot });
if (res.error) {
  console.error('[make-with-version] Failed to run electron-forge:', res.error);
  process.exit(res.status || 1);
}
if (res.status && res.status !== 0) {
  console.error('[make-with-version] electron-forge exited with code', res.status);
  process.exit(res.status);
}

// Default output dir used by forge
const outBase = path.join(repoRoot, 'out');
const makeDir = path.join(outBase, 'make');
const targetDir = path.join(outBase, `make-v${version}`);

if (!fs.existsSync(makeDir)) {
  log('No', makeDir, 'found — nothing to rename.');
  process.exit(0);
}

// If target exists, remove it first
if (fs.existsSync(targetDir)) {
  try {
    log('Removing existing target dir', targetDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch (e) {
    console.warn('[make-with-version] failed to remove existing target dir:', e);
  }
}

try {
  fs.renameSync(makeDir, targetDir);
  log('Renamed', makeDir, '->', targetDir);
} catch (e) {
  console.error('[make-with-version] failed to rename folder:', e);
  process.exit(1);
}

log('Done.');
