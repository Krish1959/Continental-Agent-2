// extractor.js — Agent 2: Dual-LLM receipt/invoice extraction
// Sends image to Gemini + OpenAI simultaneously, returns structured data + consensus

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// ── Shared extraction prompt ───────────────────────────────────────────────
const EXTRACTION_PROMPT = `
You are a receipt/invoice data extraction engine for an accounting system.

Analyze the image and extract ALL visible data. Respond ONLY with a valid JSON object — no explanation, no markdown fences, no extra text.

Return exactly this structure:
{
  "document_type": "RECEIPT" or "INVOICE",
  "supplier": "vendor/shop name or null",
  "date": "YYYY-MM-DD or null",
  "reference": "receipt/invoice number or null",
  "currency": "SGD or detected currency code",
  "line_items": [
    {
      "description": "item description",
      "quantity": 1,
      "unit_price": 0.00
    }
  ],
  "subtotal": 0.00,
  "tax_label": "GST" or "VAT" or "Tax" or null,
  "tax_amount": 0.00,
  "discount": 0.00,
  "total": 0.00,
  "payment_method": "Cash/Card/PayNow/etc or null",
  "notes": "any other relevant info or null"
}

Rules:
- Use null for any field not visible in the image.
- line_items must be an array even for single items.
- All price fields must be numbers (not strings).
- If the document is an INVOICE (not a payment receipt), set document_type to "INVOICE".
- A receipt shows payment was made. An invoice is a request for payment.
`.trim();

// ── Gemini extraction ──────────────────────────────────────────────────────
async function extractWithGemini(base64, mimeType) {
  const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    { inlineData: { data: base64, mimeType } },
  ]);

  const text = result.response.text().trim();
  console.log('[Gemini] Raw response length:', text.length);
  return parseJSON(text, 'Gemini');
}

// ── OpenAI extraction ──────────────────────────────────────────────────────
async function extractWithOpenAI(base64, mimeType) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: EXTRACTION_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
      ],
    }],
  });

  const text = res.choices[0].message.content.trim();
  console.log('[OpenAI] Raw response length:', text.length);
  return parseJSON(text, 'OpenAI');
}

// ── JSON parser (strips markdown fences if present) ────────────────────────
function parseJSON(text, source) {
  try {
    const clean = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`[${source}] JSON parse failed:`, e.message);
    console.error(`[${source}] Raw:`, text.slice(0, 200));
    return { _parse_error: `${source} returned unparseable response: ${e.message}`, raw: text };
  }
}

// ── Consensus check ────────────────────────────────────────────────────────
/**
 * Compare two extraction results field by field.
 * Returns a map: field → { match: bool, gemini: val, openai: val }
 */
function computeConsensus(gemini, openai) {
  const SCALAR_FIELDS = [
    'document_type', 'supplier', 'date', 'reference',
    'currency', 'subtotal', 'tax_label', 'tax_amount',
    'discount', 'total', 'payment_method', 'notes',
  ];

  const consensus = {};
  for (const field of SCALAR_FIELDS) {
    const g = normalise(gemini[field]);
    const o = normalise(openai[field]);
    consensus[field] = { match: g === o, gemini: gemini[field], openai: openai[field] };
  }

  // Line items — compare count and totals (deep compare is too fragile)
  const gLines = gemini.line_items || [];
  const oLines = openai.line_items || [];
  consensus.line_items = {
    match: gLines.length === oLines.length,
    gemini: gLines,
    openai: oLines,
  };

  const allMatch = Object.values(consensus).every(v => v.match);
  return { consensus, allMatch };
}

function normalise(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') return val.toFixed(2);
  return String(val).trim().toLowerCase();
}

// ── Main entry ─────────────────────────────────────────────────────────────
/**
 * Run dual extraction on a base64 image.
 * @returns {{ gemini, openai, consensus, allMatch, durationMs }}
 */
async function extractDual(base64, mimeType) {
  const start = Date.now();
  console.log('[Extractor] Starting dual extraction…');

  const [geminiResult, openaiResult] = await Promise.all([
    extractWithGemini(base64, mimeType).catch(err => ({
      _error: `Gemini failed: ${err.message}`,
    })),
    extractWithOpenAI(base64, mimeType).catch(err => ({
      _error: `OpenAI failed: ${err.message}`,
    })),
  ]);

  console.log('[Extractor] Gemini:', geminiResult.document_type, '| OpenAI:', openaiResult.document_type);

  const { consensus, allMatch } = computeConsensus(geminiResult, openaiResult);
  const durationMs = Date.now() - start;

  console.log(`[Extractor] Done in ${durationMs}ms — consensus: ${allMatch}`);
  return { gemini: geminiResult, openai: openaiResult, consensus, allMatch, durationMs };
}

module.exports = { extractDual };
