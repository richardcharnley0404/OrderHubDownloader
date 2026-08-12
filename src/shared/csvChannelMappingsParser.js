'use strict';

/**
 * src/shared/csvChannelMappingsParser.js
 *
 * Pure parser for the Channel Mappings CSV import format. Electron-free
 * so `node --test` can load it directly (matches the
 * `src/shared/__tests__/*.test.js` glob in package.json).
 *
 * ── Why this lives in the main process, not the renderer ─────────────────
 *
 * Previously the parser lived inline in renderer.js. renderer.js loads
 * as a plain <script> under context isolation and cannot `require()`,
 * so a shared module and an inline copy would have been two
 * implementations of one rule — the same class of duplication that put
 * the DPOF-family list in three places (routing-service.js:1205,
 * renderer.js:5780, and a fresh copy that missing-print-size M5 was
 * about to add).
 *
 * The renderer sends the raw CSV text over IPC
 * (`ohd:routing:parse-mappings-csv`) and main returns `{rows, skipped}`
 * built by this module. One implementation, the tested one, actually
 * runs.
 *
 * ── Format contract ──────────────────────────────────────────────────────
 *
 * The CSV is header-driven with a strict backwards-compatible fallback:
 *
 *   - No header row → strictly positional, exactly as pre-v1.10.1:
 *     `cols[0]` = channel, `cols[1]` = product, `cols[2+]` = options
 *     (each shaped `name:value`; junk cells are silently dropped).
 *   - Header row detected → known columns are RE-MAPPED by name:
 *     `channel` / `product` / `printSizeCode` (plus aliases below).
 *     Any column at a name we don't recognise is treated as an option
 *     candidate — same shape check, still silently drops junk.
 *   - Column order is free: `product,channel,printSizeCode` parses
 *     identically to `channel,product,printSizeCode`.
 *
 * The `printSizeCode` column is OPTIONAL and added in v1.10.1 so
 * DPOF-family CSV imports can carry the print size. Absent → `''` on
 * every row (the pre-v1.10.1 default). Non-DPOF controllers
 * (Fuji / DarkroomPro / Frontline / folder_copy / pdf_copy) ignore
 * a populated value at save time — `validateDPOFPrintSizeCode`
 * early-returns `{valid:true}` for those types.
 *
 * Comment lines beginning with `#` are ignored; blank lines are
 * ignored. Line numbers on `rows` and `skipped` are 1-based and count
 * comments/blanks so operators can jump straight to the CSV row.
 *
 * See docs/csv-channel-mappings.md for the operator-facing spec.
 */

/**
 * Parse one CSV line into cells. Handles double-quoted fields and
 * escaped double-quotes (`""` inside a quoted field). No newline
 * handling — callers split the input by `\r?\n` first.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

// Recognised header-column names, normalised via `_normHeaderName`. Any
// header cell whose normalised value matches a key here relocates that
// column; cells at unrecognised header names stay in the positional
// stream and become option candidates. Aliases exist because operators
// hand-write CSVs and print-size in particular gets spelled
// inconsistently in the wild — the `size` alias matches the dual-source
// read in validateDPOFPrintSizeCode which accepts either `printSizeCode`
// or the legacy `size` field.
const KNOWN_HEADER_NAMES = {
  channel:                 'channel',
  channelnumber:           'channel',
  product:                 'product',
  productcode:             'product',
  printsizecode:           'printSize',
  printsize:               'printSize',
  size:                    'printSize',
};

function _normHeaderName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a Channel Mappings CSV.
 *
 * @param {string} content  raw CSV text
 * @returns {{
 *   rows: Array<{
 *     lineNum: number,
 *     channelNumber: number,
 *     productCode: string,
 *     printSizeCode: string,
 *     options: Array<{name:string, value:string}>,
 *   }>,
 *   skipped: Array<{ lineNum:number, raw:string, reason:string }>,
 * }}
 */
function parseChannelMappingsCsv(content) {
  const lines   = String(content == null ? '' : content).split(/\r?\n/);
  const rows    = [];
  const skipped = [];
  let firstDataLine = true;

  // Column layout. Defaults are the pre-v1.10.1 positional shape —
  // channel at 0, product at 1, no print-size column, options at
  // cols[2+]. A detected header row rewrites these in place by NAME.
  let channelCol   = 0;
  let productCol   = 1;
  let printSizeCol = -1;  // -1 sentinel = "no column"

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols = parseCsvLine(line);
    const firstCellTrimmed = (cols[0] || '').trim();

    if (firstDataLine) {
      firstDataLine = false;
      // Header detection preserved from the pre-v1.10.1 parser: first
      // non-blank/non-comment row is a header iff its first cell is not
      // numeric (or is literally "channel", the legacy convention). If
      // that fires, remap known columns by name; otherwise fall through
      // and parse this row as data with positional defaults.
      const looksLikeHeader =
        isNaN(parseInt(firstCellTrimmed, 10)) ||
        firstCellTrimmed.toLowerCase() === 'channel';
      if (looksLikeHeader) {
        const seen = {};
        for (let c = 0; c < cols.length; c++) {
          const key = KNOWN_HEADER_NAMES[_normHeaderName(cols[c])];
          // First match wins for a given canonical name — a CSV with two
          // `channel` columns is malformed, and taking the earlier one
          // matches how a human would read it.
          if (key && !(key in seen)) seen[key] = c;
        }
        if ('channel'   in seen) channelCol   = seen.channel;
        if ('product'   in seen) productCol   = seen.product;
        if ('printSize' in seen) printSizeCol = seen.printSize;
        continue;
      }
    }

    const channelRaw    = (cols[channelCol] || '').trim();
    const channelNumber = parseInt(channelRaw, 10);
    const productCode   = (cols[productCol] || '').trim();
    const printSizeCode = printSizeCol >= 0
      ? (cols[printSizeCol] || '').trim()
      : '';

    if (!channelRaw || isNaN(channelNumber)) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Channel number missing or non-numeric' });
      continue;
    }
    if (!productCode) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Product code is empty' });
      continue;
    }

    const options = [];
    for (let j = 0; j < cols.length; j++) {
      if (j === channelCol || j === productCol || j === printSizeCol) continue;
      const val = (cols[j] || '').trim();
      if (!val) continue;
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        options.push({ name: val.slice(0, colonIdx).trim(), value: val.slice(colonIdx + 1).trim() });
      }
    }

    rows.push({ lineNum: i + 1, channelNumber, productCode, printSizeCode, options });
  }

  return { rows, skipped };
}

module.exports = { parseChannelMappingsCsv, parseCsvLine };
