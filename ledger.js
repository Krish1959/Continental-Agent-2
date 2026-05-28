// ledger.js — Agent 2: Read PENDING rows, write approved data to Bills sheet
// Bills sheet is AUTO-DISCOVERED from Google Drive — no BILLS_SHEET_ID env var needed.

const { google }  = require('googleapis');
const { getAuth } = require('./auth');

const SHEET_NAME = 'Ledger';

const COL = {
  ROW_ID: 0, FILE_DRIVE_ID: 1, FILE_NAME: 2, UPLOAD_TS: 3,
  CONTACT: 4, DATE: 5, DUE_DATE: 6, INVOICE_REF: 7,
  CURRENCY: 8, AMOUNTS_ARE: 9, LINE_DESC: 10, LINE_QTY: 11,
  LINE_UNIT_PRICE: 12, LINE_ACCT_CODE: 13, LINE_TAX_RATE: 14,
  TRACKING_EMP: 15, GEMINI_STATUS: 16, OPENAI_STATUS: 17,
  CONSENSUS_MATCH: 18, XERO_SYNC: 19, XERO_INVOICE_ID: 20,
};

async function getSheets() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ── Auto-discover Bills sheet ID from Google Drive ─────────────────────────
// Finds "Bills" spreadsheet inside the Continental folder.
// Agent 1 creates it; Agent 2 finds it. No hardcoded ID needed.
let _sheetId = null;

async function getSheetId() {
  if (_sheetId) return _sheetId;

  // Optional manual override via env
  if (process.env.BILLS_SHEET_ID) {
    _sheetId = process.env.BILLS_SHEET_ID;
    console.log(`[Ledger] Sheet ID from env override: ${_sheetId}`);
    return _sheetId;
  }

  const auth  = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const folderName = process.env.GD_PARENT_FOLDER_NAME || 'Continental';

  // Step 1: Find the Continental folder
  console.log(`[Ledger] Searching Drive for folder: "${folderName}"…`);
  const folderRes = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (!folderRes.data.files.length) {
    throw new Error(
      `Folder "${folderName}" not found on Google Drive. ` +
      `Has Agent 1 captured at least one receipt?`
    );
  }
  const folderId = folderRes.data.files[0].id;
  console.log(`[Ledger] Found folder: ${folderId}`);

  // Step 2: Find Bills spreadsheet inside it
  const sheetRes = await drive.files.list({
    q: `name='Bills' and '${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id, name)',
  });

  if (!sheetRes.data.files.length) {
    throw new Error(
      `"Bills" spreadsheet not found inside "${folderName}". ` +
      `Re-enable the ledger in Agent 1's server.js (uncomment appendLedgerRow) and capture one receipt first.`
    );
  }

  _sheetId = sheetRes.data.files[0].id;
  console.log(`[Ledger] ✓ Auto-discovered Bills sheet ID: ${_sheetId}`);
  return _sheetId;
}

/**
 * Fetch all rows with Gemini_Status = PENDING.
 */
async function getPendingRows() {
  const sheets  = await getSheets();
  const sheetId = await getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows = res.data.values || [];
  const pending = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row[COL.GEMINI_STATUS] === 'PENDING')
    .map(({ row, i }) => ({
      rowIndex: i + 2,
      rowId:    row[COL.ROW_ID],
      fileId:   row[COL.FILE_DRIVE_ID],
      fileName: row[COL.FILE_NAME],
      uploadTs: row[COL.UPLOAD_TS],
    }));

  console.log(`[Ledger] Found ${pending.length} PENDING row(s)`);
  return pending;
}

/**
 * Write approved extraction data back into the Bills sheet.
 * First line item updates the existing row; additional items are inserted below.
 */
async function writeApproved(rowId, approved, allMatch) {
  const sheets  = await getSheets();
  const sheetId = await getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows     = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[COL.ROW_ID] === rowId);
  if (rowIndex === -1) throw new Error(`Row ID ${rowId} not found in Bills sheet`);

  const sheetRow = rowIndex + 2;
  const baseRow  = rows[rowIndex];
  const today    = new Date().toISOString().slice(0, 10);
  const lineItems = approved.line_items?.length
    ? approved.line_items
    : [{ description: approved.notes || 'Expense', quantity: 1, unit_price: approved.total || 0 }];

  const buildRow = (item, isFirst) => [
    isFirst ? baseRow[COL.ROW_ID]       : '',
    isFirst ? baseRow[COL.FILE_DRIVE_ID] : '',
    isFirst ? baseRow[COL.FILE_NAME]     : '',
    isFirst ? baseRow[COL.UPLOAD_TS]     : '',
    approved.supplier  || 'Unknown',
    approved.date      || today,
    approved.date      || today,
    approved.reference || `Receipt-${approved.date || today}`,
    approved.currency  || 'SGD',
    'Tax Inclusive',
    item.description   || '',
    item.quantity      || 1,
    item.unit_price    || 0,
    'xxx',
    approved.tax_label ? `${approved.tax_label} (${approved.tax_amount})` : 'Zero Rated',
    approved.tracking_employee || 'xxx',
    'COMPLETED',
    'COMPLETED',
    allMatch ? 'TRUE' : 'FALSE',
    'READY',
    '',
  ];

  const allRows = lineItems.map((item, idx) => buildRow(item, idx === 0));

  // Update first row in-place
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A${sheetRow}:U${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [allRows[0]] },
  });

  // Insert extra line item rows below if needed
  if (allRows.length > 1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A${sheetRow + 1}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allRows.slice(1) },
    });
  }

  console.log(`[Ledger] ✓ Row ${rowId} → READY (${lineItems.length} line item(s))`);
  return { rowId, lineItems: lineItems.length, status: 'READY' };
}

module.exports = { getPendingRows, writeApproved };
