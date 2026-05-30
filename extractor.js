// extractor.js — Agent 2: Dual-LLM receipt extraction
// SDK: @google/genai v2 (new) + openai v4

const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai').default || require('openai');

const EXTRACTION_PROMPT = `
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

// ── Extract text from @google/genai response (defensive, logs structure) ──────
function extractGeminiText(response) {
  // Log exact shape so we can see what the SDK returns
  console.log('[Gemini] response type      :', typeof response);
  console.log('[Gemini] response keys      :', Object.keys(response || {}).join(', '));
  console.log('[Gemini] typeof .text       :', typeof response?.text);
  console.log('[Gemini] typeof .candidates :', typeof response?.candidates);

  // Try every known path in @google/genai v1 and v2
  // Path 1: response.text as a string property (v2 getter)
  if (typeof response?.text === 'string' && response.text.length > 0) {
    console.log('[Gemini] Text via: response.text (string property)');
    return response.text;
  }
  // Path 2: response.text() as a method (old SDK / some builds)
  if (typeof response?.text === 'function') {
    const t = response.text();
    console.log('[Gemini] Text via: response.text() (method)');
    return t;
  }
  // Path 3: candidates array
  const t3 = response?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (t3) {
    console.log('[Gemini] Text via: candidates[0].content.parts[0].text');
    return t3;
  }
  // Path 4: response.response (some SDK versions wrap it)
  const t4 = response?.response?.text?.();
  if (t4) {
    console.log('[Gemini] Text via: response.response.text()');
    return t4;
  }
  // Path 5: stringify and return raw for debugging
  console.warn('[Gemini] No known text path found. Full response:',
    JSON.stringify(response, null, 2).slice(0, 500));
  return '';
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function extractWithGemini(base64, mimeType) {
  const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = 'gemini-2.5-flash';
  console.log(`[Gemini] Calling model: ${model}`);

  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { text: EXTRACTION_PROMPT },
        { inlineData: { mimeType, data: base64 } },
      ],
    }],
  });

  const text = extractGeminiText(response);
  console.log(`[Gemini] Extracted text length: ${text.length}`);
  if (text.length > 0) console.log(`[Gemini] First 200 chars: ${text.slice(0, 200)}`);
  return parseJSON(text, 'Gemini');
}

// ── Gemini Hello handshake (text only, no image) ──────────────────────────────
async function geminiHello() {
  const ai    = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = 'gemini-2.5-flash';
  console.log(`[Gemini Hello] Sending handshake to ${model}…`);

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: 'Hello. Reply with exactly: GEMINI_OK' }] }],
  });

  const text = extractGeminiText(response);
  console.log(`[Gemini Hello] Response: "${text.trim()}"`);
  return text.trim();
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function extractWithOpenAI(base64, mimeType) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res    = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text',      text: EXTRACTION_PROMPT },
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
    console.error(`[${source}] Empty response — cannot parse`);
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
      console.error('  Status :', e.status || e.statusCode || e.code || 'n/a');
      console.error('  Message:', e.message);
      if (e.details)        console.error('  Details:', JSON.stringify(e.details));
      if (e.errorDetails)   console.error('  ErrDets:', JSON.stringify(e.errorDetails));
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
