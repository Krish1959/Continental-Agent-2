// extractor.js — Agent 2: Dual-LLM receipt/invoice extraction

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai').default || require('openai'); // v4 compat

const EXTRACTION_PROMPT = `
You are a receipt/invoice data extraction engine for an accounting system.
Analyze the image and extract ALL visible data.
Respond ONLY with a valid JSON object — no explanation, no markdown fences, no extra text.

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
- line_items must be an array, even for a single item.
- All price fields must be numbers, not strings.
- document_type must be "RECEIPT" (paid) or "INVOICE" (request for payment).
- Default currency to SGD if not visible.
`.trim();

async function extractWithGemini(base64, mimeType) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent([
    EXTRACTION_PROMPT,
    { inlineData: { data: base64, mimeType } },
  ]);
  const text = result.response.text().trim();
  console.log('[Gemini] Response length:', text.length);
  return parseJSON(text, 'Gemini');
}

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
  console.log('[OpenAI] Response length:', text.length);
  return parseJSON(text, 'OpenAI');
}

function parseJSON(text, source) {
  try {
    const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`[${source}] JSON parse failed:`, e.message, '| Raw:', text.slice(0, 120));
    return { _parse_error: `${source}: ${e.message}` };
  }
}

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
  // Line items — compare count only (deep compare too fragile)
  const gl = (gemini.line_items || []).length;
  const ol = (openai.line_items  || []).length;
  consensus.line_items = {
    match: gl === ol,
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

async function extractDual(base64, mimeType) {
  const start = Date.now();
  console.log('[Extractor] Starting dual extraction…');
  const [gemini, openai] = await Promise.all([
    extractWithGemini(base64, mimeType).catch(e => {
      console.error('[Gemini API Error Debug]');
      console.error('  Status Code :', e.status || e.statusCode || e.code || 'n/a');
      console.error('  Message     :', e.message);
      console.error('  Error type  :', e.constructor?.name);
      if (e.details)       console.error('  Details     :', JSON.stringify(e.details, null, 2));
      if (e.errorDetails)  console.error('  errorDetails:', JSON.stringify(e.errorDetails, null, 2));
      if (e.response?.data) console.error('  Response    :', JSON.stringify(e.response.data, null, 2));
      return { _error: `Gemini: ${e.message}`, _status: e.status || e.code };
    }),
    extractWithOpenAI(base64, mimeType).catch(e => {
      console.error('[OpenAI API Error Debug]');
      console.error('  Status Code :', e.status || e.statusCode || 'n/a');
      console.error('  Message     :', e.message);
      if (e.error) console.error('  Error body  :', JSON.stringify(e.error, null, 2));
      return { _error: `OpenAI: ${e.message}`, _status: e.status };
    }),
  ]);
  const { consensus, allMatch } = computeConsensus(gemini, openai);
  const durationMs = Date.now() - start;
  console.log(`[Extractor] Done in ${durationMs}ms — consensus: ${allMatch}`);
  return { gemini, openai, consensus, allMatch, durationMs };
}

module.exports = { extractDual };
