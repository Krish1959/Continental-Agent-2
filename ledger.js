// ledger.js — Agent 2: Read PENDING rows, write approved data to Bills sheet
const { google }  = require('googleapis');
const { getAuth } = require('./auth');

const SHEET_NAME = 'Ledger';

// Column positions (0-indexed, matching Bills schema)
const COL = {
  ROW_ID:          0,
  FILE_DRIVE_ID:   1,
  FILE_NAME:       2,
  UPLOAD_TS:       3,
  CONTACT:         4,
  DATE:            5,
  DUE_DATE:        6,
  INVOICE_REF:     7,
  CURRENCY:        8,
  AMOUNTS_ARE:     9,
  LINE_DESC:       10,
  LINE_QTY:        11,
  LINE_UNIT_PRICE: 12,
  LINE_ACCT_CODE:  13,
  LINE_TAX_RATE:   14,
  TRACKING_EMP:    15,
  GEMINI_STATUS:   16,
  OPENAI_STATUS:   17,
  CONSENSUS_MATCH: 18,
  XERO_SYNC:       19,
  XERO_INVOICE_ID: 20,
};

async function getSheets() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

function getSheetId() {
  const id = process.env.BILLS_SHEET_ID;
  if (!id) throw new Error('BILLS_SHEET_ID env var is not set. Copy it from the Bills sheet URL.');
  return id;
}

/**
 * Fetch all rows with Gemini_Status = PENDING.
 * @returns {Array<{ rowIndex, rowId, fileId, fileName, uploadTs }>}
 */
async function getPendingRows() {
  const sheets = await getSheets();
  const sheetId = getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows = res.data.values || [];
  const pending = [];

  rows.forEach((row, i) => {
    if (row[COL.GEMINI_STATUS] === 'PENDING') {
      pending.push({
        rowIndex:  i + 2, // 1-indexed, +1 for header
        rowId:     row[COL.ROW_ID],
        fileId:    row[COL.FILE_DRIVE_ID],
        fileName:  row[COL.FILE_NAME],
        uploadTs:  row[COL.UPLOAD_TS],
      });
    }
  });

  console.log(`[Ledger] Found ${pending.length} PENDING row(s)`);
  return pending;
}

/**
 * Write approved extraction data back into the Bills sheet.
 * Handles multiple line items by writing the first into the existing row
 * and appending additional rows below it.
 *
 * @param {string}   rowId       - UUID of the record
 * @param {object}   approved    - Gemini-edited, user-approved data
 * @param {boolean}  allMatch    - consensus result
 */
async function writeApproved(rowId, approved, allMatch) {
  const sheets  = await getSheets();
  const sheetId = getSheetId();

  // Find the row by Row_ID
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[COL.ROW_ID] === rowId);
  if (rowIndex === -1) throw new Error(`Row ID ${rowId} not found in Bills sheet`);

  const sheetRow = rowIndex + 2; // 1-indexed + header
  const baseRow  = rows[rowIndex];

  const lineItems = approved.line_items || [{ description: approved.notes || '', quantity: 1, unit_price: approved.total }];
  const today     = new Date().toISOString().slice(0, 10);

  // Build updated values for each line item row
  const updatedRows = lineItems.map((item, idx) => {
    const isFirst = idx === 0;
    return [
      isFirst ? baseRow[COL.ROW_ID]        : '',          // A: Row_ID (only first row)
      isFirst ? baseRow[COL.FILE_DRIVE_ID]  : '',          // B: File_Drive_ID
      isFirst ? baseRow[COL.FILE_NAME]      : '',          // C: File_Name
      isFirst ? baseRow[COL.UPLOAD_TS]      : '',          // D: Upload_Timestamp
      approved.supplier  || 'Unknown',                     // E: Contact
      approved.date      || today,                         // F: Date
      approved.date      || today,                         // G: Due_Date (default = Date for receipts)
      approved.reference || `Receipt-${approved.date || today}`, // H: Invoice_Ref
      approved.currency  || 'SGD',                         // I: Currency
      'Tax Inclusive',                                     // J: Amounts_Are
      item.description   || '',                            // K: Line_Description
      item.quantity      || 1,                             // L: Line_Qty
      item.unit_price    || 0,                             // M: Line_Unit_Price
      'xxx',                                               // N: Line_Account_Code (Agent 3)
      approved.tax_label ? `${approved.tax_label} (${approved.tax_amount})` : 'Zero Rated', // O: Tax_Rate
      approved.tracking_employee || 'xxx',                 // P: Tracking_Employee
      'COMPLETED',                                         // Q: Gemini_Status
      'COMPLETED',                                         // R: OpenAI_Status
      allMatch ? 'TRUE' : 'FALSE',                         // S: Consensus_Match
      'READY',                                             // T: Xero_Sync_Status
      '',                                                  // U: Xero_Invoice_ID
    ];
  });

  // Update first row in-place
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A${sheetRow}:U${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [updatedRows[0]] },
  });

  // Append additional line item rows if needed
  if (updatedRows.length > 1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${SHEET_NAME}!A${sheetRow + 1}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: updatedRows.slice(1) },
    });
  }

  console.log(`[Ledger] ✓ Row ${rowId} written → READY (${lineItems.length} line item(s))`);
  return { rowId, lineItems: lineItems.length, status: 'READY' };
}

module.exports = { getPendingRows, writeApproved };
