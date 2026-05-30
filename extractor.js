// extractor.js — Agent 2: Dual-LLM receipt extraction
// SDK: @google/genai v2 (new) + openai v4
// GST rules loaded at runtime from GST_RULES.txt

const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai').default || require('openai');
const fs   = require('fs');
const path = require('path');

// ── Load GST rules from file (runtime, editable without code changes) ─────────
function loadGSTRules() {
  const rulesPath = path.join(__dirname, 'GST_RULES.txt');
  if (!fs.existsSync(rulesPath)) {
    console.warn('[Extractor] GST_RULES.txt not found — using base prompt only');
    return '';
  }
  const raw = fs.readFileSync(rulesPath, 'utf8');
  // Strip comment lines (starting with #) and blank lines for cleaner prompt
  const rules = raw
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#') && line.trim() !== '')
    .join('\n');
  console.log(`[Extractor] GST_RULES.txt loaded — ${rules.length} chars`);
  return rules;
}

// Load once at startup (cached for performance)
const GST_RULES = loadGSTRules();

// ── Base extraction prompt ────────────────────────────────────────────────────
const BASE_PROMPT = `
You are a receipt/invoice data extraction engine for an accounting system.
Analyze the image and extract ALL visible data.
Respond ONLY with a valid JSON object — no explanation, no markdown, no code fences.

Return exactly this structure:
{
  "document_type": "RECEIPT",
  "supplier": "vendor/shop name or null",
  "date": "YYYY-MM-DD or null",
  "reference": "receipt/invoice number or null",
  "currency": "SGD",
  "line_items": [
    { "description": "item name", "quantity": 1, "unit_price": 0.00 }
  ],
  "subtotal": 0.00,
  "tax_label": "GST",
  "tax_amount": 0.00,
  "discount": 0.00,
  "total": 0.00,
  "payment_method": "Cash or Card or null",
  "notes": "any other info or null"
}

Rules:
- Use null for any field not visible. Do NOT guess.
- line_items must be an array even for a single item.
- All price fields must be numbers, not strings.
- document_type: "RECEIPT" (paid) or "INVOICE" (request for payment).
- Default currency to SGD if not visible.
`.trim();

// Full prompt = base + GST rules (injected as additional context)
function buildPrompt() {
  if (!GST_RULES) return BASE_PROMPT;
  return BASE_PROMPT + '\n\n## SINGAPORE-SPECIFIC GST RULES — APPLY THESE STRICTLY:\n' + GST_RULES;
}

// ── Extract text from @google/genai response (defensive) ──────────────────────
function extractGeminiText(response) {
  console.log('[Gemini] response keys      :', Object.keys(response || {}).join(', '));
  console.log('[Gemini] typeof .text       :', typeof response?.text);

  // Path 1: string property (v2 getter — most common)
  if (typeof response?.text === 'string' && response.text.length > 0) {
    console.log('[Gemini] text via: response.text (string property)');
    return response.text;
  }
  // Path 2: method (some builds)
  if (typeof response?.text === 'function') {
    console.log('[Gemini] text via: response.text() (method)');
    return response.text();
  }
  // Path 3: candidates array
  const t3 = response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (t3) {
    console.log('[Gemini] text via: candidates[0].content.parts[0].text');
    return t3;
  }
  // Path 4: nested response wrapper
  const t4 = response?.response?.text?.();
  if (t4) {
    console.log('[Gemini] text via: response.response.text()');
    return t4;
  }
  console.warn('[Gemini] No text path matched. Full response:',
    JSON.stringify(response, null, 2).slice(0, 500));
  return '';
}

// ── Gemini extraction ─────────────────────────────────────────────────────────
async function extractWithGemini(base64, mimeType) {
  const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = 'gemini-2.5-flash';
  console.log(`[Gemini] Calling model: ${model}`);

  const prompt = buildPrompt();

  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
  });

  const text = extractGeminiText(response);
  console.log(`[Gemini] Response length: ${text.length}`);
  if (text.length > 0) console.log(`[Gemini] First 200: ${text.slice(0, 200)}`);
  return parseJSON(text, 'Gemini');
}

// ── Gemini Hello handshake (text only, no image) ──────────────────────────────
async function geminiHello() {
  const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = 'gemini-2.5-flash';
  console.log(`[Gemini Hello] Handshake to ${model}…`);
  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: 'Hello. Reply with exactly: GEMINI_OK' }] }],
  });
  const text = extractGeminiText(response);
  console.log(`[Gemini Hello] Response: "${text.trim()}"`);
  return text.trim();
}

// ── OpenAI extraction ─────────────────────────────────────────────────────────
async function extractWithOpenAI(base64, mimeType) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = buildPrompt();

  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'text',      text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
      ],
    }],
  });
  const text = res.choices[0].message.content.trim();
  console.log(`[OpenAI] Response length: ${text.length}`);
  return parseJSON(text, 'OpenAI');
}

// ── JSON parser ───────────────────────────────────────────────────────────────
function parseJSON(text, source) {
  if (!text || text.length === 0) {
    console.error(`[${source}] Empty response`);
    return { _parse_error: `${source}: empty response from API` };
  }
  try {
    const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`[${source}] JSON parse failed: ${e.message}`);
    console.error(`[${source}] Raw: ${text.slice(0, 300)}`);
    return { _parse_error: `${source}: ${e.message}`, _raw: text.slice(0, 300) };
  }
}

// ── Consensus ─────────────────────────────────────────────────────────────────
function computeConsensus(gemini, openai) {
  const FIELDS = [
    'document_type','supplier','date','reference','currency',
    'subtotal','tax_label','tax_amount','discount','total',
    'payment_method','notes',
  ];
  const consensus = {};
  for (const f of FIELDS) {
    const g = norm(gemini[f]);
    const o = norm(openai[f]);
    consensus[f] = { match: g === o, gemini: gemini[f], openai: openai[f] };
  }
  const gl = (gemini.line_items || []).length;
  const ol = (openai.line_items  || []).length;
  consensus.line_items = {
    match:  gl === ol,
    gemini: gemini.line_items || [],
    openai: openai.line_items  || [],
  };
  const allMatch = Object.values(consensus).every(v => v.match);
  return { consensus, allMatch };
}

function norm(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return val.toFixed(2);
  return String(val).trim().toLowerCase();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function extractDual(base64, mimeType) {
  const start = Date.now();
  console.log('[Extractor] Starting dual extraction…');

  const [gemini, openai] = await Promise.all([
    extractWithGemini(base64, mimeType).catch(e => {
      console.error('[Gemini API Error]');
      console.error('  Status :', e.status || e.code || 'n/a');
      console.error('  Message:', e.message);
      if (e.details)        console.error('  Details:', JSON.stringify(e.details));
      if (e.response?.data) console.error('  Body   :', JSON.stringify(e.response.data));
      return { _error: e.message, _status: String(e.status || e.code || 'unknown') };
    }),
    extractWithOpenAI(base64, mimeType).catch(e => {
      console.error('[OpenAI API Error]');
      console.error('  Status :', e.status || 'n/a');
      console.error('  Message:', e.message);
      return { _error: e.message, _status: String(e.status || 'unknown') };
    }),
  ]);

  const { consensus, allMatch } = computeConsensus(gemini, openai);
  const durationMs = Date.now() - start;
  console.log(`[Extractor] Done in ${durationMs}ms — allMatch: ${allMatch}`);
  console.log(`[Extractor] Gemini ok: ${!gemini._error} | OpenAI ok: ${!openai._error}`);
  return { gemini, openai, consensus, allMatch, durationMs };
}

module.exports = { extractDual, geminiHello };
