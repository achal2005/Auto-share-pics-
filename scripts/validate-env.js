#!/usr/bin/env node
// =============================================================================
// AutoSharePics — .env validator
// =============================================================================
// Run BEFORE `docker compose up` to fail fast on misconfiguration.
//
// Usage:
//   node scripts/validate-env.js [--env=.env]
//
// Exit codes:
//   0 = all checks passed
//   1 = one or more validation errors
//   2 = .env file missing
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argEnv = process.argv.find(a => a.startsWith('--env='));
const envPath = argEnv ? argEnv.slice(6) : path.resolve(process.cwd(), '.env');

if (!fs.existsSync(envPath)) {
  console.error(`\nFAIL  .env not found at ${envPath}`);
  console.error('       Run:  copy .env.example .env  (Windows)  /  cp .env.example .env  (Unix)\n');
  process.exit(2);
}

const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}

const errors = [];
const warnings = [];

const required = (key, opts = {}) => {
  const v = env[key];
  if (v === undefined || v === '') {
    errors.push(`${key}: missing`);
    return null;
  }
  if (/CHANGE_ME|your_.*_here|XXXX/i.test(v)) {
    errors.push(`${key}: still a placeholder (${v})`);
    return null;
  }
  if (opts.minLength && v.length < opts.minLength) {
    errors.push(`${key}: too short (${v.length} chars, need ${opts.minLength})`);
    return null;
  }
  if (opts.pattern && !opts.pattern.test(v)) {
    errors.push(`${key}: does not match required format (${opts.patternDesc || opts.pattern})`);
    return null;
  }
  return v;
};

const recommend = (key, predicate, message) => {
  const v = env[key];
  if (v !== undefined && v !== '' && !predicate(v)) {
    warnings.push(`${key}: ${message}`);
  }
};

// ---------- Database ----------
required('APP_DB_USER');
required('APP_DB_PASSWORD', { minLength: 16 });
required('APP_DB_NAME');

// ---------- n8n ----------
required('N8N_AUTH_USER');
required('N8N_AUTH_PASSWORD', { minLength: 16 });
required('N8N_ENCRYPTION_KEY', { minLength: 32 });

// ---------- CompreFace ----------
required('CF_DB_USER');
required('CF_DB_PASSWORD', { minLength: 16 });
required('CF_RECOGNITION_API_KEY', { minLength: 16 });

// ---------- Evolution / WhatsApp ----------
required('EVOLUTION_API_KEY', { minLength: 32 });
const myWa = required('MY_WHATSAPP_NUMBER', {
  pattern: /^[0-9]{8,20}$/,
  patternDesc: 'digits only, country-code-prefixed, no + sign',
});
const groupJid = env.WHATSAPP_GROUP_JID;
if (groupJid && groupJid !== 'your_group_jid_here' && !/@g\.us$/.test(groupJid)) {
  errors.push(`WHATSAPP_GROUP_JID: must end with @g.us (got "${groupJid}")`);
}

// ---------- Webhook secret ----------
required('GEOFENCE_WEBHOOK_SECRET', { minLength: 24 });

// ---------- Tuning ----------
const num = (k, min, max) => {
  const v = env[k];
  if (v === undefined) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${k}: must be a number in [${min}, ${max}] (got "${v}")`);
  }
  return n;
};

num('FACE_CONFIDENCE_THRESHOLD', 0.5, 1.0);
num('FACE_DETECT_LIMIT', 1, 50);
num('CF_IMG_LIMIT', 320, 4096);
num('WA_MIN_DELAY_MS', 500, 60000);
num('WA_MAX_DELAY_MS', 500, 120000);
num('WA_BATCH_SIZE', 1, 100);
num('WA_BATCH_COOLDOWN_MS', 1000, 600000);

if (env.WA_MIN_DELAY_MS && env.WA_MAX_DELAY_MS &&
    Number(env.WA_MIN_DELAY_MS) > Number(env.WA_MAX_DELAY_MS)) {
  errors.push('WA_MIN_DELAY_MS must be <= WA_MAX_DELAY_MS');
}

recommend('FACE_CONFIDENCE_THRESHOLD',
  v => Number(v) >= 0.85,
  'below 0.85 risks false positives — friends will get strangers\' photos');

recommend('CF_IMG_LIMIT',
  v => Number(v) >= 1024,
  'below 1024 may miss faces in group photos with 5+ people');

// ---------- Detect dangerous duplicate secrets ----------
const sensitiveKeys = [
  'APP_DB_PASSWORD', 'CF_DB_PASSWORD', 'N8N_AUTH_PASSWORD',
  'EVOLUTION_API_KEY', 'GEOFENCE_WEBHOOK_SECRET', 'N8N_ENCRYPTION_KEY',
  'CF_RECOGNITION_API_KEY',
];
const seen = new Map();
for (const k of sensitiveKeys) {
  const v = env[k];
  if (!v) continue;
  if (seen.has(v)) {
    errors.push(`${k} reuses the same value as ${seen.get(v)} — use distinct secrets`);
  }
  seen.set(v, k);
}

// ---------- Output ----------
console.log('');
if (warnings.length) {
  console.log('Warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
  console.log('');
}
if (errors.length) {
  console.log('Errors:');
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log('');
  console.log(`${errors.length} error(s). Fix .env and re-run.\n`);
  process.exit(1);
}

console.log('  ✓ All required env variables present and well-formed.');
if (warnings.length) console.log(`  (${warnings.length} non-fatal warnings above.)`);
console.log('');
process.exit(0);
