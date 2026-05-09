// =============================================================================
// Evolution API / Baileys WSL2 patch
// =============================================================================
// Loaded via NODE_OPTIONS=--require BEFORE any application code runs, so the
// `os` singleton is mutated before `import { release } from 'os'` is
// destructured anywhere downstream.
//
// Why this is the *correct* fix:
//   1. `sed`-rewriting compiled JS is fragile — TS emits `(0, os_1.release)()`
//      and `const { release } = require('os')`, neither of which match a
//      naive `os.release()` regex.
//   2. The Node `os` module is a built-in singleton. Mutating it at require
//      time propagates to every later `require('os')` AND to destructured
//      named imports compiled from `import { release } from 'os'`, because
//      Node compiles those to `const os_1 = require('os'); os_1.release(...)`
//      — a live property access, not a frozen reference.
//   3. We mutate, not redefine, so we cannot fight any other code that
//      already captured the original reference.
// =============================================================================

const os = require('os');
const REPLACEMENT_RELEASE = '10.0.22631';
const REPLACEMENT_TYPE = 'Windows_NT';
const REPLACEMENT_PLATFORM = 'win32';

const safeOverride = (obj, prop, value) => {
  try {
    Object.defineProperty(obj, prop, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err) {
    // best-effort: swallow so the container never crash-loops on patch failure
    process.stderr.write(`[wsl2-patch] could not override os.${prop}: ${err.message}\n`);
  }
};

safeOverride(os, 'release', () => REPLACEMENT_RELEASE);
safeOverride(os, 'type', () => REPLACEMENT_TYPE);

// Some Baileys forks read os.platform() to pick a Browsers preset. Forcing
// win32 ensures Browsers.appropriate() emits ['Windows','Chrome',release()].
const realPlatform = os.platform;
safeOverride(os, 'platform', () => REPLACEMENT_PLATFORM);

// process.platform is read by some libs; it's a getter on the process object
// so we have to defineProperty.
try {
  Object.defineProperty(process, 'platform', {
    value: REPLACEMENT_PLATFORM,
    writable: false,
    configurable: true,
    enumerable: true,
  });
} catch (err) {
  process.stderr.write(`[wsl2-patch] could not override process.platform: ${err.message}\n`);
}

process.env.WSL2_PATCH_APPLIED = 'true';
process.env.WSL2_PATCH_RELEASE = REPLACEMENT_RELEASE;
process.stderr.write(
  `[wsl2-patch] applied: os.release()='${REPLACEMENT_RELEASE}' platform='${REPLACEMENT_PLATFORM}' (real platform was '${realPlatform()}')\n`
);
