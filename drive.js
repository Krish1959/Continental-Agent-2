// drive.js — Agent 2: Download image from Google Drive as base64
const { google } = require('googleapis');
const { getAuth } = require('./auth');

let _drive = null;
async function getDrive() {
  if (_drive) return _drive;
  const auth = await getAuth();
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

/**
 * Download a Drive file and return it as a base64 string + mimeType.
 * @param {string} fileId
 * @returns {{ base64: string, mimeType: string, fileName: string }}
 */
async function downloadAsBase64(fileId) {
  const drive = await getDrive();

  // Get metadata first (name + mimeType)
  const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType' });
  const mimeType = meta.data.mimeType || 'image/jpeg';
  const fileName = meta.data.name;

  // Download binary
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  const base64 = Buffer.from(res.data).toString('base64');
  console.log(`[Drive] Downloaded: ${fileName} (${(base64.length * 0.75 / 1024).toFixed(1)} KB)`);
  return { base64, mimeType, fileName };
}

/**
 * List all PENDING rows in the Bills sheet from Google Drive/Sheets.
 * (Delegates to ledger.js — included here for convenience.)
 */
module.exports = { downloadAsBase64 };
