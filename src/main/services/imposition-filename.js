'use strict';

/**
 * imposition-filename — resolve the output filename for an imposed PDF.
 *
 * Two shapes:
 *
 *   1. Default convention (blank / absent filenameTemplate):
 *      `{orderNumber}_{jobId}_QTY{totalCopies}_IMPQTY{totalSheets}.pdf`
 *      This is the M7 shape, locked byte-identical by a test — every
 *      installation that upgrades without touching filenameTemplate
 *      gets exactly what M7 produced.
 *
 *   2. Custom convention (non-blank filenameTemplate):
 *      Job-level tokens resolve via the SHARED template-tokens.js;
 *      the two imposition-specific tokens {qty} and {impQty} are
 *      substituted AFTER resolveTemplate runs so the shared resolver
 *      stays clean (those tokens are meaningless to back-print,
 *      photo-line, or folder-copy callers). ctx.quantity is set to
 *      totalCopies so the existing {quantity} token behaves sensibly.
 *      Sanitisation borrows the folder-copy filename rules verbatim:
 *      strip UNSAFE_CHARS (which covers path separators too), collapse
 *      whitespace, guard Win32 reserved stems, cap the stem, and
 *      append .pdf exactly once. Empty resolution falls back to the
 *      default convention with a logger.logWarning — same fallback
 *      posture folder-copy uses for its "empty stem" case.
 *
 * Save-time validation of filenameTemplate lives in imposition-service.
 * validateTemplate (§5.2): a non-blank template MUST contain at least
 * one of {orderNumber}, {jobName}, or {jobId} — with flat output (the
 * M8 default), files from different jobs share one folder and a
 * template without a job-distinguishing token would overwrite silently.
 * Same three-token rule and same reasoning as folder-copy root layout.
 */

const { UNSAFE_CHARS } = require('../../shared/printUtils');
const { resolveTemplate } = require('./template-tokens');

const STEM_MAX = 120;
const WIN32_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * The M7 default convention. Exported so tests and any future caller
 * (a "revert to default" button, a log message that names the
 * fallback) all read the same shape from one place.
 *
 * `designSuffix` (M9): inserted between the QTY/IMPQTY tail and .pdf.
 * Empty by default; `_D1`/`_D2`/... in multi-design master mode (one
 * file per design). Single-design master mode gets no suffix.
 */
function defaultImpositionFilename({ orderNumber, jobId, totalCopies, totalSheets, designSuffix = '' }) {
  return `${orderNumber}_${jobId}_QTY${totalCopies}_IMPQTY${totalSheets}${designSuffix}.pdf`;
}

/**
 * Resolve an imposition filename from the template's optional
 * filenameTemplate. Returns the `.pdf`-suffixed basename ready for
 * `path.join(destFolder, ...)`.
 *
 * @param {object} params
 * @param {object} params.template       imposition template (reads filenameTemplate)
 * @param {object} params.job            job object (order_number, id, job_name, etc.)
 * @param {number} params.totalCopies    sum of per-image manifest quantities
 *                                       ('all' mode) OR per-design qty ('master')
 * @param {number} params.totalSheets    sum of composeImposition().sheets
 *                                       ('all' mode) OR per-design sheets ('master')
 * @param {string} [params.designSuffix] M9: '_D1'/'_D2'/... in multi-design
 *                                       master mode; empty otherwise
 * @param {object} [params.logger]       optional; logger.logWarning is called on
 *                                       an empty-resolution fallback
 */
function resolveImpositionFilename({ template, job, totalCopies, totalSheets, designSuffix = '', logger }) {
  const orderNumber = job.order_number || String(job.id || '');
  const jobId       = job.id;
  const defaults    = { orderNumber, jobId, totalCopies, totalSheets, designSuffix };
  const raw = (template && typeof template.filenameTemplate === 'string')
    ? template.filenameTemplate.trim()
    : '';
  if (!raw) return defaultImpositionFilename(defaults);

  // Job-level tokens via the shared resolver. ctx.quantity keeps the
  // existing {quantity} token useful (== total copies across designs).
  // No prefixRules — pdf_copy has no order-number-prefix concept and
  // adding one now would spread the field across another controller
  // type without a use case.
  const ctx = { quantity: totalCopies };
  let resolved;
  try {
    resolved = resolveTemplate(raw, job, ctx, {});
  } catch (err) {
    // resolveTemplate only throws on invalid opts.now — we don't pass
    // one, so this is truly defensive. Fall back to default rather
    // than fail the dispatch.
    if (logger && typeof logger.logWarning === 'function') {
      logger.logWarning(
        `[imposition] filename template '${raw}' failed to resolve — falling back to default convention`,
        { jobId, error: err && err.message },
      );
    }
    return defaultImpositionFilename(defaults);
  }

  // Two imposition-specific tokens the shared resolver doesn't know.
  // Substituted AFTER resolveTemplate so a job-level value that happens
  // to contain the literal string "{qty}" doesn't get re-substituted.
  // Case-sensitive to match the shared resolver's convention (§ tokens
  // are case-sensitive).
  resolved = String(resolved)
    .replace(/\{qty\}/g,    String(totalCopies))
    .replace(/\{impQty\}/g, String(totalSheets));

  // Sanitise — same rule set as folder-copy-filename:
  //   - Strip UNSAFE_CHARS (covers path separators / \ AND :*?"<>|).
  //     No path.dirname / basename call needed; separators just
  //     disappear.
  //   - Collapse whitespace runs to a single space; trim.
  //   - Strip leading and trailing dots + spaces (Win32 silently
  //     drops trailing ones, so a check against a "stripped" name
  //     would lie).
  //   - Strip a trailing .pdf if the template produced one; we always
  //     re-append below (extension is never template-controlled).
  let stem = String(resolved)
    .replace(UNSAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/\.pdf$/i, '')
    .replace(/[. ]+$/g, '');

  if (!stem) {
    if (logger && typeof logger.logWarning === 'function') {
      logger.logWarning(
        `[imposition] filename template '${raw}' resolved to empty for job ${jobId} — falling back to default convention`,
        { jobId },
      );
    }
    return defaultImpositionFilename(defaults);
  }

  if (stem.length > STEM_MAX) stem = stem.slice(0, STEM_MAX);
  // Win32 reserved-name guard (same rule as folder-copy). Prefix the
  // stem so the operator-typed intent stays legible ("_CON" beats
  // "CON_safe" or a UUID rename). Extension isn't part of the match.
  if (WIN32_RESERVED.test(stem)) stem = `_${stem}`;

  // M9 designSuffix inserted between stem and .pdf. `_D1` is short
  // enough that we don't recount against STEM_MAX — a single-digit or
  // small-double-digit design index is what real multi-design jobs
  // look like, and a longer stem staying inside the cap by 3–4 chars
  // isn't a real Windows concern.
  return `${stem}${designSuffix}.pdf`;
}

/**
 * The three tokens that satisfy the "job-distinguishing" requirement
 * on a non-blank filenameTemplate (§5.2 rule). Exported so the
 * validator can share the list and error messages read consistently.
 */
const DISTINGUISHING_TOKENS = ['{orderNumber}', '{jobName}', '{jobId}'];

/**
 * True when `template` contains at least one distinguishing token.
 * Case-sensitive to match resolveTemplate's convention.
 */
function hasDistinguishingToken(template) {
  if (typeof template !== 'string') return false;
  return /\{orderNumber\}|\{jobName\}|\{jobId\}/.test(template);
}

module.exports = {
  resolveImpositionFilename,
  defaultImpositionFilename,
  hasDistinguishingToken,
  DISTINGUISHING_TOKENS,
};
