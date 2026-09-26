// `npm run app`: builds Inkwell.app in release mode and opens the Finder window that has it, so making
// (or updating) the Mac app is one line instead of the four steps in the README/the v2.3 plan doc.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos');

// Without this, a missing/incomplete `npm install` surfaces as a cryptic "npm error could not determine
// executable to run" from npx (it can't find a package literally named "tauri" on the registry either,
// since the real package is "@tauri-apps/cli") — say plainly what to do instead.
const tauriBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
if (!existsSync(tauriBin)) {
  console.error('Inkwell\'s build tool isn\'t installed yet.\n\nRun this first:\n\n    npm install\n\nThen run "npm run app" again.');
  process.exit(1);
}

console.log('Building Inkwell.app — this can take several minutes the first time (warnings along the way are normal).\n');

const build = spawnSync('npx', ['tauri', 'build', '--bundles', 'app'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (build.error || build.status !== 0) {
  console.error('\nThe build did not finish — scroll up for the error. Nothing was opened.');
  process.exit(build.status ?? 1);
}

if (!existsSync(bundleDir)) {
  console.error(`\nThe build reported success, but ${bundleDir} was not there. Check the output above.`);
  process.exit(1);
}

console.log(`\nDone. Inkwell.app is in ${bundleDir}`);
if (process.platform === 'darwin') {
  console.log('Opening that folder — drag Inkwell.app into Applications, then open it from Launchpad or Spotlight from now on.');
  spawnSync('open', [bundleDir], { stdio: 'inherit' });
} else {
  // Only macOS can build the "app" bundle in the first place, but keep this script harmless elsewhere.
  console.log('(This folder only opens itself automatically on a Mac.)');
}
