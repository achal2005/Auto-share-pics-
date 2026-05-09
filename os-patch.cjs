// Patches os.release() before anything else loads
// Works because Node loads -r requires before the main module
const os = require('os');
Object.defineProperty(os, 'release', {
  value: () => '10.0',
  writable: false,
  configurable: false
});
process.env.OS_RELEASE_PATCHED = 'true';
