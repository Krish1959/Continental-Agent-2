// server.js — Continental Agent 1

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const { uploadToContinental, inspectCredentials } = require('./drive');
const { appendLedgerRow }                         = require('./ledger');

const app     = express();
const PORT    = process.env.PORT || 3000;
const DRY_RUN = process.env.GOOGLE_DRIVE_ACTIVE !== 'true';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Unsupported type: ${file.mimetype}`));
  },
});

function makeLog() {
  const entries = [];
  const log = (level, msg) => {
    const ts   = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
    console.log(line);
    entries.push({ ts, level, msg });
  };
  return { info:(m)=>log('info',m), ok:(m)=>log('ok',m), warn:(m)=>log('warn',m),
           error:(m)=>log('error',m), step:(m)=>log('step',m), entries };
}

app.get('/health', (req, res) => res.json({
  status: 'ok', agent: 'Continental Agent 1',
  driveActive: !DRY_RUN, timestamp: new Date().toISOString(),
}));

app.get('/debug/auth', (req, res) => {
  const report = inspectCredentials();
  const raw    = process.env.GOOGLE_TOKEN_JSON || '';
  report.envHints = {
    token_length:      raw.length,
    starts_with:       raw.slice(0, 30) + '…',
    drive_active_flag: process.env.GOOGLE_DRIVE_ACTIVE,
    gd_folder_name:    process.env.GD_PARENT_FOLDER_NAME || 'Continental',
  };
  report.guidance = report.ok
    ? 'Credentials look structurally valid.'
    : 'Fix the issues above, then retry /debug/auth.';
  res.json(report);
});

app.post('/upload', upload.single('photo'), async (req, res) => {
  const log = makeLog();
  log.step('--- NEW UPLOAD REQUEST ---');

  if (!req.file) {
    log.error('No photo file in request');
    return res.status(400).json({ success: false, error: 'No photo file received.', log: log.entries });
  }

  const rowId    = uuidv4();
  const ext      = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const uploadTs = new Date().toISOString();
  const fileName = `receipt_${uploadTs.replace(/[:.]/g, '-')}_${rowId.slice(0, 8)}.${ext}`;

  log.info(`File: ${req.file.originalname} | ${(req.file.size/1024).toFixed(1)} KB | ${req.file.mimetype}`);
  log.info(`Row ID: ${rowId}`);
  log.info(`Drive active: ${!DRY_RUN}`);

  if (DRY_RUN) {
    log.warn('DRY RUN — skipping real upload');
    return res.json({ success: true, dryRun: true, rowId, fileId: 'DRY_RUN', fileName, log: log.entries });
  }

  try {
    log.step('STEP 1 — Authenticating with Google…');
    const credCheck = inspectCredentials();
    if (!credCheck.ok) {
      log.error(`Credential check failed: ${credCheck.error}`);
      return res.status(500).json({ success: false, error: credCheck.error, log: log.entries });
    }

    log.step('STEP 2 — Uploading image to Google Drive /Continental/…');
    const driveResult = await uploadToContinental({
      buffer: req.file.buffer, filename: fileName, mimeType: req.file.mimetype,
    });
    log.ok(`Drive upload → fileId: ${driveResult.fileId}`);

    // ── STEP 3: Append PENDING row to Bills ledger ──────────────────────────
    // Records File_Drive_ID so Agent 2 can find and process this receipt.
    // All Xero fields initialised to 'xxx' — Agent 2 fills them after LLM parsing.
    log.step('STEP 3 — Appending PENDING row to Bills ledger…');
    const ledgerSheetId = await appendLedgerRow({
      rowId, fileId: driveResult.fileId, fileName, uploadTs,
    });
    log.ok(`Ledger row appended → sheetId: ${ledgerSheetId}`);

    log.ok('=== UPLOAD COMPLETE ===');

    return res.json({
      success: true,
      dryRun: false,
      rowId,
      fileId:       driveResult.fileId,
      fileName:     driveResult.name,
      webViewLink:  driveResult.webViewLink,
      ledgerSheetId,
      message: 'Receipt uploaded and PENDING row created for Agent 2.',
      log: log.entries,
    });

  } catch (err) {
    log.error(`FAILED: ${err.message}`);
    const m = err.message || '';
    let hint = 'Check server terminal.';
    if (m.includes('invalid_grant'))  hint = 'Refresh token expired. Re-authorise OAuth.';
    if (m.includes('invalid_client')) hint = 'client_id or client_secret wrong.';
    if (m.includes('403'))            hint = 'Drive or Sheets API not enabled in Google Cloud Console.';
    console.error('[Agent 1] Full error:', err);
    return res.status(500).json({ success: false, error: m, hint, log: log.entries });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 1                  │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Drive  : ${DRY_RUN ? '⚠  DRY RUN' : '✓  LIVE — uploading to Drive'}              │`);
  console.log(`│  Ledger : ${DRY_RUN ? '⚠  SKIPPED' : '✓  LIVE — writing Bills sheet'}             │`);
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
  const check = inspectCredentials();
  console.log('[Boot] Credential check:', JSON.stringify(check, null, 2));
});
