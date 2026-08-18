'use strict';

const { applyOrderNumberPrefixRules } = require('../../shared/printUtils');

/**
 * template-tokens
 *
 * Shared {token} substitution used by emitters that let operators configure
 * free-form template strings:
 *   - Frontline back-print
 *   - Darkroom Pro configurable photo lines
 *   - Fuji JobMaker back-print
 *   - Fuji PIC Pro back-print
 *   - pdf-pipeline steps
 *   - (M4) Folder Copy filenames
 *
 * Tokens are case-sensitive. The values come from three sources:
 *   - `job`  — order-level fields shared across every image in the job
 *   - `ctx`  — per-image context (filename, originalFilename, index, quantity, imageCount)
 *   - `opts` — dispatch-level options (stripPrefixes, injected clock for {date})
 *
 * Empty/missing values resolve to empty string rather than throwing — the
 * resulting line still gets written, just with the token slot blank. This
 * mirrors the long-standing Frontline behaviour and avoids surprising the
 * operator with a blocked job over a missing optional field.
 *
 * Resolution is SINGLE-PASS. A single regex spans every recognised token
 * form and the resolver returns each match's value; resolved values are
 * NEVER re-scanned. This means a customer name that literally contains
 * '{date}' — or an option value that contains '{options}' — survives
 * verbatim into the output rather than getting substituted again. Do not
 * "simplify" this back into chained .replace() calls: chained replaces run
 * on each other's output and any earlier value becomes a re-scannable input
 * for every later token. (M1a, 2026-08-17.)
 *
 * ── Supported tokens ─────────────────────────────────────────────────────
 *
 * Job-level:
 *   {customerName}     Full customer name (e.g. "Richard Charnley")
 *   {firstName}        First word of customer name
 *   {lastName}         Everything after the first space (or empty)
 *   {jobId}            OrderHub job ID (numeric)
 *   {orderNumber}      Order number (e.g. "PXDEMO-091YEC")
 *                      — with opts.prefixRules set to an array of
 *                      {from, to} pairs, matching leading `from` is
 *                      replaced with `to` via
 *                      printUtils.applyOrderNumberPrefixRules
 *                      (longest-first, case-insensitive, consumes one
 *                      trailing '-'/'_' separator, never produces
 *                      empty per rule). Blank `to` = pure strip.
 *   {jobName}          Job name (e.g. "PXDEMO-091YEC-1") — falls back to
 *                      orderNumber; same prefixRules rule as above
 *   {product}          Product display name (e.g. '4x6" Photo Print')
 *   {productCode}      Product code (e.g. '0406-cut-print')
 *   {category}         job.category
 *   {process}          job.process
 *   {dueDate}          job.due_date parsed as a Date and formatted as local
 *                      YYYY-MM-DD (same shape and locality as {date}, and
 *                      matches renderer.js formatDueDate). OrderHub sends
 *                      due_date as a UTC ISO 8601 datetime (e.g.
 *                      '2026-05-22T13:21:15Z' — verified in the API mapper
 *                      at job-service.js:404). Blank when absent or
 *                      unparseable. Bare 'YYYY-MM-DD' inputs parse as UTC
 *                      midnight per ECMAScript, which can shift by a day in
 *                      non-UTC timezones — same wart as formatDueDate; not
 *                      worth diverging from the app's own display.
 *   {options}          All non-empty option values, joined with '_' in array
 *                      order — matches the shape buildFolderName produces
 *   {option:NAME}      Lookup by option name → option value. NAME is
 *                      case-insensitive and trimmed. Absent name or empty
 *                      value → blank. Malformed `{option:}` → blank, token
 *                      consumed (never left literal).
 *
 * Per-image (ctx):
 *   {filename}         Per-image filename including extension
 *   {originalFilename} Per-image customer original upload filename (the
 *                      caller is responsible for reducing manifest-relative
 *                      paths — this resolver just substitutes the string
 *                      it is given)
 *   {quantity}         Per-image quantity from the manifest. Deliberately
 *                      NOT job.quantity — see §3.3 of
 *                      docs/folder-copy-filename-templates-brief.md for why
 *                      a job-level number cannot be trusted.
 *   {index}            1-based image index within the job
 *   {indexPadded}      Zero-padded to the width of ctx.imageCount
 *                      (3 of 20 → '03'; 3 of 200 → '003'). No imageCount →
 *                      unpadded fallback.
 *
 * Dispatch (opts):
 *   {date}             opts.now formatted as local ISO YYYY-MM-DD. If
 *                      opts.now is absent the real clock is used. Tests MUST
 *                      inject opts.now to stay reproducible.
 *
 *                      Historical: prior to M1 this token was UNRESOLVED —
 *                      the seeded Fuji back-print default is
 *                      '{firstName}/{filename}/{date}' and _sanitiseBackprintText
 *                      does not strip braces, so a Fuji controller left on the
 *                      default with backprintMode='text' has been emitting a
 *                      literal '{date}' on the back print. M1 fixes that as a
 *                      side effect — see §3.5 of the brief.
 */

/**
 * Split a customer name into first/last on the first space.
 * If there is no space, the whole value becomes firstName and lastName is ''.
 */
function _splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  const trimmed = String(fullName).trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.substring(0, spaceIdx),
    lastName:  trimmed.substring(spaceIdx + 1).trim(),
  };
}

/** Format a Date as local ISO YYYY-MM-DD. */
function _isoLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format job.due_date as local YYYY-MM-DD, matching {date} and the
 * renderer's formatDueDate. Blank when absent or unparseable.
 */
function _resolveDueDate(v) {
  if (v == null || v === '') return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return _isoLocalDate(d);
}

/** Look up a single option value by name — case-insensitive, trimmed. */
function _resolveOption(job, rawName) {
  const trimmed = String(rawName || '').trim();
  if (!trimmed) return '';
  const target = trimmed.toLowerCase();
  const opts = Array.isArray(job.options) ? job.options : [];
  for (const opt of opts) {
    if (opt && typeof opt.name === 'string' && opt.name.toLowerCase() === target) {
      return opt.value == null ? '' : String(opt.value);
    }
  }
  return '';
}

/** All non-empty option values, joined with '_' in array order. */
function _resolveAllOptions(job) {
  const opts = Array.isArray(job.options) ? job.options : [];
  return opts
    .map(o => (o && o.value != null) ? String(o.value) : '')
    .filter(Boolean)
    .join('_');
}

/**
 * Zero-pad `index` to the width of `imageCount`. If imageCount is not a
 * positive integer, fall back to an unpadded stringification of index. If
 * index is missing entirely, return blank (same convention as every other
 * optional token).
 */
function _padIndex(index, imageCount) {
  if (index == null || index === '') return '';
  const idx = String(index);
  const count = Number(imageCount);
  if (!Number.isInteger(count) || count < 1) return idx;
  const width = String(count).length;
  return idx.padStart(width, '0');
}

/**
 * Resolve {token} placeholders in `template`.
 *
 * @param {string} template
 * @param {object} [job]  — job-level fields (customer_name, id, order_number,
 *   job_name, product, product_code, category, process, due_date, options[]).
 *   Extra fields are ignored.
 * @param {object} [ctx]  — per-image context (filename, originalFilename,
 *   quantity, index, imageCount).
 * @param {object} [opts] — dispatch-level options.
 * @param {Array<{from:string,to:string}>} [opts.prefixRules] — array of
 *   {from, to} pairs; the longest matching `from` against {orderNumber}
 *   / {jobName} is replaced with `to`, consuming one following '-' or
 *   '_'. Blank `to` = pure strip. Empty array / absent = no rules
 *   applied. See printUtils.applyOrderNumberPrefixRules for the full
 *   semantics (separator required, never-empty guard, etc.).
 * @param {Date}   [opts.now] — injected clock for {date}. Absent = real
 *   clock. Tests MUST inject.
 * @returns {string}
 */
// Single regex covering every recognised token form. Alternation puts the
// parameterised `option:NAME` variant first (it's the only one with a
// dynamic body); the fixed-name group lists `indexPadded` before `index`
// so the more-specific match wins without relying on regex backtracking.
// Any `{unknown}` token does NOT match this regex and is left literal —
// same behaviour as the pre-M1a chained replaces.
const TOKEN_RE = /\{(?:option:([^}]*)|(customerName|firstName|lastName|jobId|orderNumber|jobName|product|productCode|category|process|dueDate|date|options|filename|originalFilename|quantity|indexPadded|index))\}/g;

function resolveTemplate(template, job = {}, ctx = {}, opts = {}) {
  if (!template) return '';

  const { firstName, lastName } = _splitName(job.customer_name);
  // opts.prefixRules: array of {from, to} pairs; anything else
  // (missing, wrong type, non-array) is treated as no-rules-applied.
  // Malformed entries are filtered by applyOrderNumberPrefixRules so
  // we don't have to.
  const prefixRules = (opts && Array.isArray(opts.prefixRules)) ? opts.prefixRules : [];
  const rawOrderNumber = job.order_number || '';
  const rawJobName     = job.job_name || job.order_number || '';
  const orderNumber = prefixRules.length > 0 ? applyOrderNumberPrefixRules(rawOrderNumber, prefixRules) : rawOrderNumber;
  const jobName     = prefixRules.length > 0 ? applyOrderNumberPrefixRules(rawJobName,     prefixRules) : rawJobName;

  // opts.now: null/undefined = real clock; anything else must be a valid
  // Date. A test that meant to be deterministic and passed a timestamp
  // number (or an Invalid Date) now fails loudly here rather than silently
  // dropping back to the wall clock and becoming non-reproducible.
  let dateSource;
  if (opts && opts.now != null) {
    if (!(opts.now instanceof Date) || Number.isNaN(opts.now.getTime())) {
      throw new TypeError(
        `resolveTemplate: opts.now must be a valid Date (got ${typeof opts.now === 'object' ? 'Invalid Date' : typeof opts.now})`
      );
    }
    dateSource = opts.now;
  } else {
    dateSource = new Date();
  }

  return String(template).replace(TOKEN_RE, (_match, optionName, tokenName) => {
    // `option:NAME` branch — optionName is a string (possibly empty for the
    // malformed `{option:}` case, which resolves blank and consumes the
    // token). The non-option branch always leaves optionName as undefined.
    if (optionName !== undefined) return _resolveOption(job, optionName);

    switch (tokenName) {
      case 'customerName':     return job.customer_name  || '';
      case 'firstName':        return firstName;
      case 'lastName':         return lastName;
      case 'jobId':            return String(job.id || '');
      case 'orderNumber':      return orderNumber;
      case 'jobName':          return jobName;
      case 'product':          return job.product        || '';
      case 'productCode':      return job.product_code   || '';
      case 'category':         return job.category       || '';
      case 'process':          return job.process        || '';
      case 'dueDate':          return _resolveDueDate(job.due_date);
      case 'date':             return _isoLocalDate(dateSource);
      case 'options':          return _resolveAllOptions(job);
      case 'filename':         return ctx.filename       || '';
      case 'originalFilename': return ctx.originalFilename || '';
      case 'quantity':         return (ctx.quantity != null && ctx.quantity !== '') ? String(ctx.quantity) : '';
      case 'indexPadded':      return _padIndex(ctx.index, ctx.imageCount);
      case 'index':            return (ctx.index != null && ctx.index !== '') ? String(ctx.index) : '';
      default:                 return _match; // unreachable: alternation is exhaustive
    }
  });
}

/**
 * Reduce a stored manifest-relative originalFilename to the value emitted for
 * the {originalFilename} token.
 *
 * The manifest stores a path like "PXDEMO-XYZ_123/original-files/5_IMG.jpg".
 * We emit just the customer's original filename with Pixfizz's leading
 * image-index prefix removed, e.g. "5_576629810005.jpg" -> "576629810005.jpg"
 * (the "5" is the image ordinal Pixfizz prepends; separator may be "-" or "_").
 *
 * Splits on both slash styles so it's correct on Linux (tests) and Windows.
 * Returns '' for a falsy/missing value so the token resolves blank, matching
 * every other optional token. Shared by the Darkroom Pro and Fuji JobMaker
 * emitters.
 */
function originalDisplayName(rel) {
  if (!rel || typeof rel !== 'string') return '';
  const base = rel.split(/[\\/]/).pop() || '';
  return base.replace(/^\d+[-_]/, '');
}

/**
 * Canonical list of supported tokens — exported so UI code can render the
 * click-to-copy reference panel without duplicating the list.
 *
 * Note: per §5.2 of docs/folder-copy-filename-templates-brief.md, the Folder
 * Copy Settings UI will maintain its OWN list rather than reuse this one,
 * because per-image tokens (index, quantity) resolve blank on photo-line and
 * back-print callers and would mis-advertise capability there. This export
 * remains the module's canonical list — filter as needed at the UI layer.
 */
const SUPPORTED_TOKENS = [
  '{customerName}',
  '{firstName}',
  '{lastName}',
  '{jobId}',
  '{orderNumber}',
  '{jobName}',
  '{product}',
  '{productCode}',
  '{category}',
  '{process}',
  '{dueDate}',
  '{date}',
  '{options}',
  '{option:NAME}',
  '{filename}',
  '{originalFilename}',
  '{quantity}',
  '{index}',
  '{indexPadded}',
];

module.exports = { resolveTemplate, SUPPORTED_TOKENS, originalDisplayName };
