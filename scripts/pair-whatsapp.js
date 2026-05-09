#!/usr/bin/env node
// =============================================================================
// AutoSharePics — WhatsApp pairing helper
// =============================================================================
// Creates an Evolution API instance, polls for the QR until it appears,
// renders it as ASCII in the terminal, and exits when the instance reports
// `open`. Replaces the brittle two-curl-and-pray flow.
//
//   node scripts/pair-whatsapp.js
// =============================================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
let qrcode = null; try { qrcode = require('qrcode-terminal'); } catch {}

const envPath = path.resolve(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error('.env not found at', envPath);
  process.exit(1);
}
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const [k, ...v] = line.split('=');
  env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
}

const API = env.EVOLUTION_SERVER_URL || 'http://localhost:8080';
const KEY = env.EVOLUTION_API_KEY;
const NAME = env.EVOLUTION_INSTANCE_NAME || 'autoshare';

if (!KEY || /CHANGE_ME/i.test(KEY)) {
  console.error('EVOLUTION_API_KEY missing or unset in .env');
  process.exit(1);
}

const client = axios.create({
  baseURL: API,
  headers: { apikey: KEY, 'Content-Type': 'application/json' },
  timeout: 15000,
  validateStatus: () => true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureInstance() {
  const list = await client.get('/instance/fetchInstances');
  const found = (list.data || []).find((i) => i.instance?.instanceName === NAME || i.name === NAME);
  if (found) {
    console.log(`Instance "${NAME}" already exists.`);
    return;
  }
  console.log(`Creating instance "${NAME}"...`);
  const created = await client.post('/instance/create', {
    instanceName: NAME,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
  });
  if (created.status >= 400) {
    console.error('Create failed:', created.status, created.data);
    process.exit(1);
  }
}

async function getStatus() {
  const r = await client.get(`/instance/connectionState/${NAME}`);
  return r.data?.instance?.state || r.data?.state || 'unknown';
}

async function fetchQr() {
  const r = await client.get(`/instance/connect/${NAME}`);
  const body = r.data || {};
  const qr = body.base64 || body.qrcode?.base64 || body.code || body.qrcode?.code;
  return { state: body.state || body.instance?.state, qr };
}

async function main() {
  console.log(`Talking to Evolution API at ${API}`);
  await ensureInstance();

  const start = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000;
  let lastState = '';
  let printedQr = false;

  while (Date.now() - start < TIMEOUT_MS) {
    const state = await getStatus();
    if (state !== lastState) {
      console.log(`state: ${state}`);
      lastState = state;
    }
    if (state === 'open') {
      console.log('Paired successfully.');
      return;
    }
    const { qr } = await fetchQr();
    if (qr && !printedQr) {
      console.log('\nScan this QR with WhatsApp -> Linked Devices -> Link a Device:\n');
      // qr is either base64 PNG or raw payload depending on Evolution version
      const payload = qr.startsWith('data:image') ? null : qr;
      if (qrcode && payload) {
        qrcode.generate(payload, { small: true });
      } else {
        console.log(qr.slice(0, 80) + '...');
        console.log('(install `qrcode-terminal` for inline QR rendering)');
      }
      printedQr = true;
    }
    await sleep(2000);
  }
  console.error('Timed out waiting for pairing. Check evolution-api logs.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
