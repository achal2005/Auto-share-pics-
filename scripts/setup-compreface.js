#!/usr/bin/env node
// =============================================================================
// AutoSharePics — CompreFace Setup CLI (audited rewrite)
// =============================================================================
// Fixes from the audit:
//   - glob v9+ API: `glob` is now a named export, options changed.
//   - Adds 429 / 5xx retry with exponential backoff.
//   - Lowercases subject names consistently with the DB CHECK constraint.
//   - HEIC -> JPEG fallback for iPhone references via heic-convert.
//   - Verifies the friend has at least N usable embeddings before declaring
//     them "ready" (CompreFace requires multiple distinct faces to disambiguate
//     in small databases — reduces the false-positive risk that's high when
//     only 2-5 friends are enrolled).
// =============================================================================

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const path = require('path');
const { glob } = require('glob');
let heicConvert = null; try { heicConvert = require('heic-convert'); } catch {}

const CONFIG = {
  apiUrl: process.env.CF_API_URL || 'http://localhost:8000',
  apiKey: process.env.CF_RECOGNITION_API_KEY || '',
  supportedFormats: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.heic', '.heif'],
  detProbThreshold: 0.8,
  facePlugins: 'landmarks,gender,age',
  maxRetries: 5,
  retryBaseDelayMs: 800,
  minEmbeddingsForReady: 5,
  uploadDelayMs: 250,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function compreRequest(method, endpoint, data = null, isFormData = false, attempt = 1) {
  const url = `${CONFIG.apiUrl}/api/v1/recognition${endpoint}`;
  const headers = { 'x-api-key': CONFIG.apiKey };
  if (isFormData && data) Object.assign(headers, data.getHeaders());

  try {
    const response = await axios({
      method, url, data, headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
      validateStatus: (s) => s < 500 && s !== 429,
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const retryable = status === 429 || (status >= 500 && status < 600) || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT';
    if (retryable && attempt < CONFIG.maxRetries) {
      const delay = CONFIG.retryBaseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      console.warn(`   retry ${attempt}/${CONFIG.maxRetries} after ${delay}ms (status=${status || error.code})`);
      await sleep(delay);
      return compreRequest(method, endpoint, data, isFormData, attempt + 1);
    }
    if (error.response) {
      console.error(`   API Error ${error.response.status}:`, JSON.stringify(error.response.data));
    } else {
      console.error('   Network Error:', error.message);
    }
    throw error;
  }
}

async function maybeConvertHeic(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') return { stream: fs.createReadStream(filePath), filename: path.basename(filePath) };
  if (!heicConvert) {
    throw new Error(`HEIC file ${path.basename(filePath)} requires heic-convert. Install: npm i heic-convert`);
  }
  const buf = await heicConvert({ buffer: await fs.readFile(filePath), format: 'JPEG', quality: 0.9 });
  return { stream: buf, filename: path.basename(filePath, ext) + '.jpg' };
}

async function listSubjects() {
  console.log('\nListing all registered subjects...\n');
  const result = await compreRequest('GET', '/subjects');
  const subjects = result.subjects || [];
  if (!subjects.length) {
    console.log('  (none)\n');
    return;
  }
  for (const subject of subjects) {
    try {
      const faces = await compreRequest('GET', `/faces?subject=${encodeURIComponent(subject)}`);
      const count = faces.faces?.length || 0;
      const ok = count >= CONFIG.minEmbeddingsForReady;
      console.log(`  ${ok ? 'OK ' : '!! '} ${subject} — ${count} reference photo(s)${ok ? '' : ` (need >= ${CONFIG.minEmbeddingsForReady})`}`);
    } catch {
      console.log(`  ?? ${subject} — (could not fetch face count)`);
    }
  }
  console.log('');
}

async function uploadFaces(friendName, photosDir) {
  const subject = friendName.toLowerCase();
  console.log(`\nUploading reference photos for "${subject}"...`);
  console.log(`Source: ${photosDir}\n`);

  if (!await fs.pathExists(photosDir)) {
    console.error(`Directory not found: ${photosDir}`);
    process.exit(1);
  }

  const patterns = CONFIG.supportedFormats.map((ext) => path.posix.join(photosDir.replace(/\\/g, '/'), `*${ext}`));
  const imageFiles = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { nocase: true, windowsPathsNoEscape: true });
    imageFiles.push(...matches);
  }

  if (!imageFiles.length) {
    console.error(`No image files found in ${photosDir}`);
    console.error(`Supported: ${CONFIG.supportedFormats.join(', ')}`);
    process.exit(1);
  }

  console.log(`Found ${imageFiles.length} image(s).`);
  if (imageFiles.length < CONFIG.minEmbeddingsForReady) {
    console.log(`WARNING: ${imageFiles.length} < ${CONFIG.minEmbeddingsForReady}. Add more photos for reliable recognition.`);
  }

  let success = 0, fail = 0;
  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const fileName = path.basename(filePath);
    process.stdout.write(`  [${i + 1}/${imageFiles.length}] ${fileName} ... `);
    try {
      const { stream, filename } = await maybeConvertHeic(filePath);
      const form = new FormData();
      form.append('file', stream, { filename });
      const result = await compreRequest(
        'POST',
        `/faces?subject=${encodeURIComponent(subject)}&det_prob_threshold=${CONFIG.detProbThreshold}`,
        form, true,
      );
      if (result.image_id) {
        console.log(`ok (${result.image_id.slice(0, 8)})`);
        success++;
      } else {
        console.log('uploaded but no face detected');
        fail++;
      }
    } catch {
      console.log('failed');
      fail++;
    }
    await sleep(CONFIG.uploadDelayMs);
  }

  const ready = success >= CONFIG.minEmbeddingsForReady;
  console.log(`\nResults: ${success} succeeded, ${fail} failed`);
  console.log(`Subject "${subject}" is ${ready ? 'READY' : 'NOT YET READY'} for recognition.\n`);
  if (!ready) process.exitCode = 1;
}

async function testRecognition(photoPath, threshold) {
  console.log(`\nTesting recognition on ${photoPath} (threshold=${threshold})\n`);
  if (!await fs.pathExists(photoPath)) {
    console.error(`File not found: ${photoPath}`);
    process.exit(1);
  }
  const { stream, filename } = await maybeConvertHeic(photoPath);
  const form = new FormData();
  form.append('file', stream, { filename });
  const result = await compreRequest(
    'POST',
    `/recognize?limit=0&det_prob_threshold=${CONFIG.detProbThreshold}&prediction_count=3&face_plugins=${CONFIG.facePlugins}`,
    form, true,
  );
  if (!result.result?.length) {
    console.log('No faces detected.\n');
    return;
  }
  console.log(`Found ${result.result.length} face(s):`);
  result.result.forEach((face, i) => {
    const subjects = face.subjects || [];
    console.log(`\n  Face #${i + 1}: detection=${(face.box.probability * 100).toFixed(1)}%`);
    if (!subjects.length) {
      console.log('    -> Unknown');
    } else {
      subjects.forEach((s) => {
        const m = s.similarity >= threshold;
        console.log(`    ${m ? 'MATCH' : 'below'} ${s.subject}: ${(s.similarity * 100).toFixed(1)}%`);
      });
    }
  });
  console.log('');
}

async function deleteSubject(friendName) {
  const subject = friendName.toLowerCase();
  console.log(`\nDeleting subject "${subject}"...`);
  try {
    await compreRequest('DELETE', `/subjects/${encodeURIComponent(subject)}`);
    console.log('Deleted.\n');
  } catch {
    console.log('Failed to delete (subject may not exist).\n');
  }
}

async function bulkUpload(baseDir) {
  console.log(`\nBulk uploading from ${baseDir}\n`);
  if (!await fs.pathExists(baseDir)) {
    console.error(`Directory not found: ${baseDir}`);
    process.exit(1);
  }
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const friendDirs = entries.filter((e) => e.isDirectory());
  if (!friendDirs.length) {
    console.error('No friend subdirectories found.');
    process.exit(1);
  }
  console.log(`Found ${friendDirs.length} folder(s): ${friendDirs.map((d) => d.name).join(', ')}\n`);
  for (const dir of friendDirs) {
    await uploadFaces(dir.name, path.join(baseDir, dir.name));
  }
  console.log('\nBulk upload complete. Run --action=list to verify.\n');
}

async function main() {
  const args = require('yargs')
    .usage('Usage: $0 --action=<action> [options]')
    .option('action', { alias: 'a', choices: ['upload', 'bulk', 'test', 'list', 'delete'], demandOption: true })
    .option('friend', { alias: 'f', type: 'string' })
    .option('photos', { alias: 'p', type: 'string' })
    .option('photo', { type: 'string' })
    .option('dir', { alias: 'd', type: 'string', default: './reference_photos' })
    .option('threshold', { alias: 't', type: 'number', default: 0.85 })
    .option('api-key', { type: 'string' })
    .help()
    .argv;

  if (args['api-key']) CONFIG.apiKey = args['api-key'];
  if (!CONFIG.apiKey) {
    console.error('No API key. Set CF_RECOGNITION_API_KEY or pass --api-key=<key>');
    process.exit(1);
  }

  switch (args.action) {
    case 'list':   return listSubjects();
    case 'upload':
      if (!args.friend || !args.photos) { console.error('--friend and --photos required'); process.exit(1); }
      return uploadFaces(args.friend, args.photos);
    case 'bulk':   return bulkUpload(args.dir);
    case 'test':
      if (!args.photo) { console.error('--photo required'); process.exit(1); }
      return testRecognition(args.photo, args.threshold);
    case 'delete':
      if (!args.friend) { console.error('--friend required'); process.exit(1); }
      return deleteSubject(args.friend);
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
