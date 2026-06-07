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
// CRITICAL: Evolution API v2.2.0 uses os.release() as the THIRD element of the
// Baileys browser tuple: [CLIENT, NAME, os.release()]. WhatsApp expects a standard
// OS release version (like '20.0.04' or '10.0'), NOT a WhatsApp Web version.
// Having a mismatch like '2.24.6.77' as the OS release version triggers WhatsApp
// anti-spam and drops the connection, causing a loop.
const REPLACEMENT_RELEASE = '20.0.04';
const REPLACEMENT_TYPE = 'Linux';
// NOTE: We do NOT override os.platform(). It must remain 'linux' because
// @ffmpeg-installer/ffmpeg and other native packages use it to find the
// correct binary. Baileys only uses os.release() and os.type() for the
// browser string.

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
// os.platform() is intentionally NOT overridden — see note above.

// Some Baileys forks also check os.version()
if (typeof os.version === 'function') {
  safeOverride(os, 'version', () => 'Ubuntu 20.04 LTS');
}

// Override os.hostname() to return a clean hostname (no WSL artifacts)
const originalHostname = typeof os.hostname === 'function' ? os.hostname() : 'desktop';
const cleanHostname = (originalHostname || 'desktop').split('.')[0].replace(/[^a-zA-Z0-9-]/g, '');
safeOverride(os, 'hostname', () => cleanHostname);

process.env.WSL2_PATCH_APPLIED = 'true';
process.env.WSL2_PATCH_RELEASE = REPLACEMENT_RELEASE;
process.stderr.write(
  `[wsl2-patch] applied: os.release()='${REPLACEMENT_RELEASE}', ` +
  `os.type()='${REPLACEMENT_TYPE}', os.platform()='${os.platform()}' (not overridden), ` +
  `os.hostname()='${cleanHostname}'\n`
);
