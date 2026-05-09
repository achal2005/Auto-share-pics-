const fs = require('fs');
let data = fs.readFileSync('workflows/02-process.json', 'utf8');
let start = data.indexOf('const firstItem = items[0].json;');
let end = data.indexOf('}];"');
if (start !== -1 && end !== -1) {
    let broken = data.substring(start, end + 4);
    let fixed = broken.replace(/\r?\n/g, '\\n').replace(/"/g, '\\"');
    // Also remove the extra backslashes before quotes that were added by my regex
    fixed = fixed.replace(/\\\\"/g, '\\"');
    
    // Actually, I can just replace the whole node's jsCode.
    // Let me just replace the broken part with a clean escaped string.
    let cleanFixed = `const firstItem = items[0].json;\\nconst mediaId = firstItem.id;\\nconst friendsList = Array.from(friendsSet).sort().map(f => f.replace(/'/g, \\"''\\"));\\n\\nreturn [{\\n  json: {\\n    mediaId: mediaId,\\n    gdriveFileId: firstItem.gdrive_file_id || firstItem.gdriveFileId,\\n    originalFilename: firstItem.original_filename || firstItem.originalFilename,\\n    isVideo: firstItem.is_video || firstItem.isVideo || false,\\n    takenAt: firstItem.taken_at || firstItem.takenAt,\\n    localPath: firstItem.local_path || firstItem.localPath,\\n    facesDetected: allFaces.length,\\n    facesRecognized: JSON.stringify(allFaces).replace(/'/g, \\"''\\"),\\n    friendsIdentified: friendsList,\\n    friendCount: friendsList.length,\\n    // For display\\n    friendNames: friendsList.join(', ') || 'No friends recognized',\\n  }\\n}];\\"`;
    
    data = data.substring(0, start) + cleanFixed + data.substring(end + 4);
    fs.writeFileSync('workflows/02-process.json', data);
    console.log("Fixed 02-process.json!");
} else {
    console.log("Could not find broken string.");
}
