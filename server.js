// server.js — Continental Agent 2
// Dual-LLM Consensus Engine + Human Verification

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { downloadAsBase64 }          = require('./drive');
const { extractDual }               = require('./extractor');
const { getPendingRows, writeApproved } = require('./ledger');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '512kb' })); // approve payload is small (form data only)
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  agent: 'Continental Agent 2',
  status: 'ok',
  timestamp: new Date().toISOString(),
  env: {
    gemini:    !!process.env.GEMINI_API_KEY,
    openai:    !!process.env.OPENAI_API_KEY,
    driveAuth: !!(process.env.GOOGLE_CREDENTIALS_JSON && process.env.GOOGLE_TOKEN_JSON),
    folder:    process.env.GD_PARENT_FOLDER_NAME || 'Continental (default)',
  },
}));

// ── GET /pending ──────────────────────────────────────────────────────────────
app.get('/pending', async (req, res) => {
  try {
    const rows = await getPendingRows();
    res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('[/pending]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /process ─────────────────────────────────────────────────────────────
// Body: { fileId, rowId }
// NOTE: imageBase64 is NOT returned to the client — too large, not needed.
//       The UI fetches a thumbnail separately via /thumbnail/:fileId.
app.post('/process', async (req, res) => {
  const { fileId, rowId } = req.body;
  if (!fileId) return res.status(400).json({ success: false, error: 'fileId is required' });

  try {
    console.log(`\n[Agent 2] Processing rowId=${rowId} fileId=${fileId}`);
    const { base64, mimeType, fileName } = await downloadAsBase64(fileId);
    const result = await extractDual(base64, mimeType);

    // Return extraction results only — no base64 image in response
    res.json({ success: true, rowId, fileId, fileName, ...result });

  } catch (err) {
    console.error('[/process]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /thumbnail/:fileId ─────────────────────────────────────────────────────
// Streams the receipt image directly from Drive to the browser.
// Keeps base64 off the wire entirely.
app.get('/thumbnail/:fileId', async (req, res) => {
  try {
    const { base64, mimeType } = await downloadAsBase64(req.params.fileId);
    const buf = Buffer.from(base64, 'base64');
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── POST /approve ─────────────────────────────────────────────────────────────
// Body: { rowId, approved: {...}, allMatch }
app.post('/approve', async (req, res) => {
  const { rowId, approved, allMatch } = req.body;
  if (!rowId || !approved)
    return res.status(400).json({ success: false, error: 'rowId and approved data are required' });

  try {
    console.log(`\n[Agent 2] Approving rowId=${rowId}`);
    const result = await writeApproved(rowId, approved, allMatch);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[/approve]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const ok = s => s ? '✓' : '✗';
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 2                  │');
  console.log('│       Dual-LLM Consensus + Human Verification        │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Gemini : ${ok(process.env.GEMINI_API_KEY)}  GEMINI_API_KEY                    │`);
  console.log(`│  OpenAI : ${ok(process.env.OPENAI_API_KEY)}  OPENAI_API_KEY                    │`);
  console.log(`│  Drive  : ${ok(process.env.GOOGLE_CREDENTIALS_JSON)}  GOOGLE_CREDENTIALS_JSON           │`);
  console.log(`│  Token  : ${ok(process.env.GOOGLE_TOKEN_JSON)}  GOOGLE_TOKEN_JSON                  │`);
  console.log(`│  Folder : ${process.env.GD_PARENT_FOLDER_NAME || 'Continental (default)'}              │`);
  console.log(`│  Sheet  : auto-discovered from Drive                 │`);
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
});

// ── GET /test-gemini — simple handshake ───────────────────────────────────────
// Sends "Hello" to Gemini and returns the raw response + timing.
// Used to prove API key, network path, and credits without processing an image.
app.get('/test-gemini', async (req, res) => {
  const { GoogleGenAI } = require('@google/genai');
  const start = Date.now();
  const model = 'gemini-2.5-flash';
  console.log(`[Gemini Handshake] Testing model: ${model}`);
  try {
    const ai       = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: 'Hello. Reply with exactly: GEMINI_OK' }] }],
    });
    const text = response.text?.() || response.candidates?.[0]?.content?.parts?.[0]?.text || '(no text)';
    const ms   = Date.now() - start;
    console.log(`[Gemini Handshake] ✓ Response: "${text.trim()}" in ${ms}ms`);
    res.json({ success: true, model, response: text.trim(), durationMs: ms });
  } catch (err) {
    const ms  = Date.now() - start;
    const msg = err.message || String(err);
    console.error(`[Gemini Handshake] ✗ ${msg}`);
    // Parse inner JSON error if present
    let parsed = null;
    try { parsed = JSON.parse(msg); } catch (_) {}
    res.json({
      success: false, model,
      error:   msg,
      code:    parsed?.error?.code || err.status || 'unknown',
      status:  parsed?.error?.status || 'unknown',
      hint:    parsed?.error?.code === 429
        ? 'Credits depleted — top up at https://aistudio.google.com/plan'
        : parsed?.error?.code === 403
        ? 'API key invalid or wrong project'
        : parsed?.error?.code === 404
        ? 'Model not found — check model name'
        : 'Check Render logs for details',
      durationMs: ms,
    });
  }
});
