#!/usr/bin/env node
// ============================================================================
// AutoSharePics - CompreFace Setup Script
// ============================================================================
// This script:
//   1. Creates a recognition service in CompreFace (if not exists)
//   2. Uploads reference photos for each friend ("subject")
//   3. Tests recognition accuracy
//
// Usage:
//   node scripts/setup-compreface.js --action=upload --friend=alice --photos=./reference_photos/alice/
//   node scripts/setup-compreface.js --action=test --photo=./test_photo.jpg
//   node scripts/setup-compreface.js --action=list
//
// Prerequisites:
//   npm install axios form-data fs-extra glob yargs
// ============================================================================

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');
const path = require('path');
const { glob } = require('glob');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
    // CompreFace API endpoint (admin portal serves the recognition API too)
    apiUrl: process.env.CF_API_URL || 'http://localhost:8000',
    // Recognition API key (get from CompreFace admin UI after creating a service)
    apiKey: process.env.CF_RECOGNITION_API_KEY || '',
    // Supported image formats
    supportedFormats: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff'],
    // Face detection parameters
    detProbThreshold: 0.8,    // Minimum face detection confidence
    facePlugins: 'landmarks,gender,age',  // Extra data to extract
    // FIX #6: Add faceDetectLimit parameter
    faceDetectLimit: process.env.FACE_DETECT_LIMIT || 10,
};

// ---------------------------------------------------------------------------
// Helper: Make API request to CompreFace
// ---------------------------------------------------------------------------
async function compreRequest(method, endpoint, data = null, isFormData = false) {
    const url = `${CONFIG.apiUrl}/api/v1/recognition${endpoint}`;
    const headers = {
        'x-api-key': CONFIG.apiKey,
    };

    if (isFormData) {
        Object.assign(headers, data.getHeaders());
    }

    try {
        const response = await axios({
            method,
            url,
            data,
            headers,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            console.error(`❌ API Error (${error.response.status}):`, error.response.data);
        } else {
            console.error(`❌ Network Error:`, error.message);
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// ACTION: List all registered subjects (friends)
// ---------------------------------------------------------------------------
async function listSubjects() {
    console.log('\n📋 Listing all registered subjects...\n');

    const result = await compreRequest('GET', '/subjects');
    const subjects = result.subjects || [];

    if (subjects.length === 0) {
        console.log('  (none) — No subjects registered yet.');
        console.log('  Run with --action=upload to add friends.\n');
        return;
    }

    console.log(`  Found ${subjects.length} subject(s):\n`);

    for (const subject of subjects) {
        // Get face count for each subject
        try {
            const faces = await compreRequest('GET', `/faces?subject=${encodeURIComponent(subject)}`);
            const count = faces.faces ? faces.faces.length : 0;
            console.log(`  👤 ${subject} — ${count} reference photo(s)`);
        } catch {
            console.log(`  👤 ${subject} — (couldn't fetch face count)`);
        }
    }
    console.log('');
}

// ---------------------------------------------------------------------------
// ACTION: Upload reference photos for a friend
// ---------------------------------------------------------------------------
async function uploadFaces(friendName, photosDir) {
    console.log(`\n📸 Uploading reference photos for "${friendName}"...`);
    console.log(`   Source directory: ${photosDir}\n`);

    // Verify directory exists
    if (!await fs.pathExists(photosDir)) {
        console.error(`❌ Directory not found: ${photosDir}`);
        console.error(`   Create it and add 5-15 clear photos of ${friendName}'s face.`);
        process.exit(1);
    }

    // Find all image files
    const patterns = CONFIG.supportedFormats.map(ext => path.join(photosDir, `*${ext}`));
    let imageFiles = [];
    for (const pattern of patterns) {
        // FIX #13: Make windowsPathsNoEscape conditional
        const matches = await glob(pattern, { nocase: true, windowsPathsNoEscape: process.platform === 'win32' });
        imageFiles.push(...matches);
    }

    if (imageFiles.length === 0) {
        console.error(`❌ No image files found in ${photosDir}`);
        console.error(`   Supported formats: ${CONFIG.supportedFormats.join(', ')}`);
        process.exit(1);
    }

    console.log(`   Found ${imageFiles.length} image(s) to upload.\n`);

    // Quality recommendations
    if (imageFiles.length < 5) {
        console.log('   ⚠️  Recommendation: Use at least 5 reference photos for good accuracy.');
        console.log('       Include different angles, lighting, and expressions.\n');
    }
    if (imageFiles.length > 20) {
        console.log('   💡 Tip: More than 20 photos may not improve accuracy significantly.');
        console.log('       Quality > quantity. Diverse angles matter more.\n');
    }

    // Upload each photo
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < imageFiles.length; i++) {
        const filePath = imageFiles[i];
        const fileName = path.basename(filePath);

        process.stdout.write(`   [${i + 1}/${imageFiles.length}] ${fileName}... `);

        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));

            const result = await compreRequest(
                'POST',
                `/faces?subject=${encodeURIComponent(friendName)}&det_prob_threshold=${CONFIG.detProbThreshold}`,
                form,
                true
            );

            if (result.image_id) {
                console.log(`✅ (image_id: ${result.image_id.substring(0, 8)}...)`);
                successCount++;
            } else {
                console.log('⚠️  Uploaded but no face detected');
                failCount++;
            }
        } catch (error) {
            console.log('❌ Failed');
            failCount++;
        }

        // Small delay to not overwhelm the API
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n   📊 Results: ${successCount} succeeded, ${failCount} failed`);
    console.log(`   Subject "${friendName}" is ${successCount > 0 ? 'ready' : 'NOT ready'} for recognition.\n`);
}

// ---------------------------------------------------------------------------
// ACTION: Test face recognition on a photo
// ---------------------------------------------------------------------------
async function testRecognition(photoPath, threshold = 0.85) {
    console.log(`\n🧪 Testing face recognition...`);
    console.log(`   Photo: ${photoPath}`);
    console.log(`   Threshold: ${threshold}\n`);

    if (!await fs.pathExists(photoPath)) {
        console.error(`❌ File not found: ${photoPath}`);
        process.exit(1);
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(photoPath));

    const result = await compreRequest(
        'POST',
        // FIX #6: Replace limit=0 with limit=${CONFIG.faceDetectLimit}
        `/recognize?limit=${CONFIG.faceDetectLimit}&det_prob_threshold=${CONFIG.detProbThreshold}&prediction_count=3&face_plugins=${CONFIG.facePlugins}`,
        form,
        true
    );

    if (!result.result || result.result.length === 0) {
        console.log('   ⚠️  No faces detected in this photo.\n');
        return;
    }

    console.log(`   Found ${result.result.length} face(s):\n`);

    for (let i = 0; i < result.result.length; i++) {
        const face = result.result[i];
        const box = face.box;
        const subjects = face.subjects || [];

        console.log(`   ┌─ Face #${i + 1} ──────────────────────────────`);
        console.log(`   │ Location:   (${box.x_min}, ${box.y_min}) → (${box.x_max}, ${box.y_max})`);
        console.log(`   │ Detection:  ${(box.probability * 100).toFixed(1)}% confidence`);

        if (face.gender) {
            console.log(`   │ Gender:     ${face.gender.value} (${(face.gender.probability * 100).toFixed(0)}%)`);
        }
        if (face.age) {
            console.log(`   │ Age:        ~${face.age.low}-${face.age.high}`);
        }

        if (subjects.length === 0) {
            console.log(`   │ Match:      ❓ Unknown person (no match above threshold)`);
        } else {
            for (const subj of subjects) {
                const isMatch = subj.similarity >= threshold;
                const icon = isMatch ? '✅' : '⚠️';
                console.log(`   │ Match:      ${icon} ${subj.subject} (${(subj.similarity * 100).toFixed(1)}% similarity)`);
            }
        }
        console.log(`   └────────────────────────────────────────\n`);
    }
}

// ---------------------------------------------------------------------------
// ACTION: Delete a subject and all their reference photos
// ---------------------------------------------------------------------------
async function deleteSubject(friendName) {
    console.log(`\n🗑️  Deleting subject "${friendName}" and all reference photos...`);

    try {
        await compreRequest('DELETE', `/subjects/${encodeURIComponent(friendName)}`);
        console.log(`   ✅ Subject "${friendName}" deleted.\n`);
    } catch (error) {
        console.log(`   ❌ Failed to delete. Subject may not exist.\n`);
    }
}

// ---------------------------------------------------------------------------
// ACTION: Bulk upload from a structured directory
// ---------------------------------------------------------------------------
// Expected structure:
//   reference_photos/
//     alice/
//       photo1.jpg
//       photo2.jpg
//     bob/
//       photo1.jpg
//       photo2.jpg
// ---------------------------------------------------------------------------
async function bulkUpload(baseDir) {
    console.log(`\n📦 Bulk uploading from ${baseDir}...\n`);

    if (!await fs.pathExists(baseDir)) {
        console.error(`❌ Directory not found: ${baseDir}`);
        process.exit(1);
    }

    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const friendDirs = entries.filter(e => e.isDirectory());

    if (friendDirs.length === 0) {
        console.error('❌ No subdirectories found. Expected structure:');
        console.error('   reference_photos/alice/, reference_photos/bob/, etc.');
        process.exit(1);
    }

    console.log(`   Found ${friendDirs.length} friend folder(s): ${friendDirs.map(d => d.name).join(', ')}\n`);

    for (const dir of friendDirs) {
        const friendName = dir.name.toLowerCase();
        const friendPath = path.join(baseDir, dir.name);
        await uploadFaces(friendName, friendPath);
    }

    console.log('\n✅ Bulk upload complete! Run --action=list to verify.\n');
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------
async function main() {
    const args = require('yargs')
        .usage('Usage: $0 --action=<action> [options]')
        .option('action', {
            alias: 'a',
            describe: 'Action to perform',
            choices: ['upload', 'bulk', 'test', 'list', 'delete'],
            demandOption: true,
        })
        .option('friend', {
            alias: 'f',
            describe: 'Friend name (subject) for upload/delete',
            type: 'string',
        })
        .option('photos', {
            alias: 'p',
            describe: 'Path to photos directory (upload) or single photo (test)',
            type: 'string',
        })
        .option('photo', {
            describe: 'Path to a single photo for testing',
            type: 'string',
        })
        .option('dir', {
            alias: 'd',
            describe: 'Base directory for bulk upload (contains friend subdirectories)',
            type: 'string',
            default: './reference_photos',
        })
        .option('threshold', {
            alias: 't',
            describe: 'Confidence threshold for recognition (0.0 - 1.0)',
            type: 'number',
            default: 0.85,
        })
        .option('api-key', {
            describe: 'CompreFace API key (or set CF_RECOGNITION_API_KEY env var)',
            type: 'string',
        })
        .help()
        .argv;

    // Override API key if provided via CLI
    if (args['api-key']) {
        CONFIG.apiKey = args['api-key'];
    }

    if (!CONFIG.apiKey) {
        console.error('\n❌ No API key provided!');
        console.error('   Set CF_RECOGNITION_API_KEY environment variable, or pass --api-key=<key>');
        console.error('   Get your API key from CompreFace admin UI: http://localhost:8000\n');
        process.exit(1);
    }

    switch (args.action) {
        case 'list':
            await listSubjects();
            break;

        case 'upload':
            if (!args.friend || !args.photos) {
                console.error('❌ --friend and --photos are required for upload action');
                process.exit(1);
            }
            await uploadFaces(args.friend, args.photos);
            break;

        case 'bulk':
            await bulkUpload(args.dir);
            break;

        case 'test':
            if (!args.photo) {
                console.error('❌ --photo is required for test action');
                process.exit(1);
            }
            await testRecognition(args.photo, args.threshold);
            break;

        case 'delete':
            if (!args.friend) {
                console.error('❌ --friend is required for delete action');
                process.exit(1);
            }
            await deleteSubject(args.friend);
            break;
    }
}

main().catch(error => {
    console.error('\n💥 Unexpected error:', error.message);
    process.exit(1);
});
