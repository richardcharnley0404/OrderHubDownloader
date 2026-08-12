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
 * The renderer now sends the raw CSV text over IPC
 * (`ohd:routing:parse-mappings-csv`) and main returns `{rows, skipped}`
 * built by this module. One implementation, the tested one, actually
 * runs.
 *
 * ── Format contract ──────────────────────────────────────────────────────
 *
 * Positional CSV:
 *   - `cols[0]` — channel number (integer ≥ 1)
 *   - `cols[1]` — product code (non-empty string)
 *   - `cols[2+]` — option cells shaped `name:value` (any cell without a
 *                  colon is silently dropped)
 *
 * A leading header row is DETECTED (first non-blank / non-comment line
 * whose first cell is non-numeric, or is literally "channel") and
 * discarded — its column names are not consulted. Comment lines
 * beginning with `#` are ignored; blank lines are ignored.
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

/**
 * Parse a Channel Mappings CSV.
 *
 * @param {string} content  raw CSV text
 * @returns {{
 *   rows: Array<{
 *     lineNum: number,
 *     channelNumber: number,
 *     productCode: string,
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const cols       = parseCsvLine(line);
    const channelRaw = (cols[0] || '').trim();

    // Header row detection: first non-blank / non-comment line whose
    // first cell is non-numeric (or is literally "channel"). Skipped
    // entirely — the header's column names are not consulted.
    if (firstDataLine && (isNaN(parseInt(channelRaw, 10)) || channelRaw.toLowerCase() === 'channel')) {
      firstDataLine = false;
      continue;
    }
    firstDataLine = false;

    const channelNumber = parseInt(channelRaw, 10);
    const productCode   = (cols[1] || '').trim();

    if (!channelRaw || isNaN(channelNumber)) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Channel number missing or non-numeric' });
      continue;
    }
    if (!productCode) {
      skipped.push({ lineNum: i + 1, raw: line, reason: 'Product code is empty' });
      continue;
    }

    const options = [];
    for (let j = 2; j < cols.length; j++) {
      const val = (cols[j] || '').trim();
      if (!val) continue;
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        options.push({ name: val.slice(0, colonIdx).trim(), value: val.slice(colonIdx + 1).trim() });
      }
    }

    // lineNum carried through so the import loop can name IPC-rejected
    // rows in the summary alongside the parser-side `skipped` shape.
    rows.push({ lineNum: i + 1, channelNumber, productCode, options });
  }

  return { rows, skipped };
}

module.exports = { parseChannelMappingsCsv, parseCsvLine };
