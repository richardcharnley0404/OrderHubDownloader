'use strict';

/**
 * Source-scan tripwires for operator-facing UI text invariants.
 *
 * Same style as the modal tripwires in modal-dismiss.test.js — read
 * the source, regex-check, fail loudly on drift.
 *
 * First invariant: no live UI text in index.html may claim a
 * "default folder" fallback for unrouted jobs. The global Default
 * Folder feature (`processFolderPath`) was removed in commit
 * d18f73b — any UI copy still referring to it is a factually wrong
 * claim to the operator that unmapped process types are being
 * handled when in fact nothing is. That was the exact misdirection
 * the removal existed to end.
 *
 * Explanatory HTML comments about the removal (e.g. the
 * `<!-- "Process Folders" fieldset REMOVED. … -->` block at
 * index.html:419-429) are legitimate and stay — the tripwire
 * distinguishes live text from comment prose.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const INDEX_HTML = path.resolve(__dirname, '..', 'index.html');

// Strip HTML comments from a source string. `<!-- … -->` may span
// lines; the non-greedy `[\s\S]*?` matches minimally.
function _stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

test('index.html: no live UI text claims a "default folder" fallback for unrouted jobs (processFolderPath removal)', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const live = _stripHtmlComments(html);

  // Case-insensitive because the operator-visible wording drifts
  // freely between "Default Folder" / "default folder". The removal
  // took out the shipped fallback entirely — any remaining live
  // text describing one is a false claim to the operator.
  const violations = [];

  const defaultFolderRe = /default[- ]folder/gi;
  let m;
  while ((m = defaultFolderRe.exec(live))) {
    // Give the assertion a 60-char window around the match so a
    // failure message shows the operator where to look.
    const start = Math.max(0, m.index - 30);
    const end   = Math.min(live.length, m.index + 30);
    violations.push(`live text mentions "${m[0]}" — context: "…${live.slice(start, end)}…"`);
  }

  assert.deepEqual(violations, [],
    'index.html live UI text must NOT reference a "default folder" — the global ' +
    'processFolderPath fallback was removed in d18f73b. Any live copy still ' +
    'describing it tells operators unmapped process types are being handled ' +
    'when in fact nothing is (the exact misdirection the removal existed to ' +
    'end). Explanatory HTML comments about the removal are stripped before ' +
    'this scan and stay allowed.');
});

test('index.html: no live UI text claims processes are "copied to" any implicit destination for unrouted jobs', () => {
  // Adjacent invariant. The stale note at index.html:858 (rewritten
  // as part of this fix) previously said "Processes not listed here
  // will be copied to the default folder." Someone could restate the
  // same misclaim with different words ("automatically routed",
  // "sent to fallback", etc). This tripwire catches the specific
  // "copied to" wording pattern applied to unmapped-processes text.
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const live = _stripHtmlComments(html);

  // Scoped to text mentioning "not listed" (the pattern this note
  // shape uses) followed within ~200 chars by "copied to" / "copied
  // here" / similar destination-implying language. Avoids false
  // positives on legitimate uses of "copied to" elsewhere in the
  // file (e.g. Folder Copy help text describing what happens for
  // configured controllers).
  const suspect = /not\s+listed[\s\S]{0,200}\bcopied\s+(?:to|here)\b/i;
  const found = suspect.exec(live);
  assert.equal(found, null,
    'index.html live UI text describes unmapped processes as being "copied ' +
    'somewhere" — a false claim after the processFolderPath removal. ' +
    `Match: "${found ? found[0] : ''}"`);
});
