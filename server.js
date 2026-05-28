// server.js — Continental Agent 2
// Dual-LLM Consensus Engine + Human Verification Interface

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { downloadAsBase64 } = require('./drive');
const { extractDual }      = require('./extractor');
const { getPendingRows, writeApproved } = require('./ledger');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  agent: 'Continental Agent 2',
  status: 'ok',
  timestamp: new Date().toISOString(),
  env: {
    gemini:   !!process.env.GEMINI_API_KEY,
    openai:   !!process.env.OPENAI_API_KEY,
    sheetId:  !!process.env.BILLS_SHEET_ID,
    driveAuth:!!process.env.GOOGLE_CREDENTIALS_JSON || !!process.env.GOOGLE_TOKEN_JSON,
  },
}));

// ── GET /pending — list all PENDING rows from Bills sheet ─────────────────
app.get('/pending', async (req, res) => {
  try {
    const rows = await getPendingRows();
    res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('[/pending]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /process — download image + run dual LLM extraction ─────────────
// Body: { fileId, rowId }
app.post('/process', async (req, res) => {
  const { fileId, rowId } = req.body;
  if (!fileId) return res.status(400).json({ success: false, error: 'fileId is required' });

  try {
    console.log(`\n[Agent 2] Processing rowId=${rowId} fileId=${fileId}`);

    // 1. Download image from Drive
    console.log('[Agent 2] Step 1 — Downloading image from Drive…');
    const { base64, mimeType, fileName } = await downloadAsBase64(fileId);

    // 2. Dual LLM extraction
    console.log('[Agent 2] Step 2 — Running Gemini + OpenAI extraction…');
    const result = await extractDual(base64, mimeType);

    res.json({
      success: true,
      rowId,
      fileId,
      fileName,
      imageBase64: base64,
      imageMime:   mimeType,
      ...result,  // gemini, openai, consensus, allMatch, durationMs
    });

  } catch (err) {
    console.error('[/process]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /approve — write approved data to Bills sheet ────────────────────
// Body: { rowId, approved: {...gemini-edited fields}, allMatch }
app.post('/approve', async (req, res) => {
  const { rowId, approved, allMatch } = req.body;
  if (!rowId || !approved) {
    return res.status(400).json({ success: false, error: 'rowId and approved data are required' });
  }

  try {
    console.log(`\n[Agent 2] Approving rowId=${rowId}`);
    const result = await writeApproved(rowId, approved, allMatch);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[/approve]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 2                  │');
  console.log('│       Dual-LLM Consensus + Human Verification        │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Gemini : ${process.env.GEMINI_API_KEY  ? '✓ key set' : '✗ GEMINI_API_KEY missing'}               │`);
  console.log(`│  OpenAI : ${process.env.OPENAI_API_KEY  ? '✓ key set' : '✗ OPENAI_API_KEY missing'}               │`);
  console.log(`│  Sheet  : ${process.env.BILLS_SHEET_ID  ? '✓ set' : '✗ BILLS_SHEET_ID missing'}                  │`);
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
});
