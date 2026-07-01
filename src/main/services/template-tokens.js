'use strict';

/**
 * template-tokens
 *
 * Shared {token} substitution used by emitters that let operators configure
 * free-form template strings (Frontline back-print lines, Darkroom Pro
 * configurable photo lines).
 *
 * Tokens are case-sensitive. The values come from two sources:
 *   - `job` — order-level fields shared across every image in the job
 *   - `ctx` — per-image context supplied by the caller (currently `filename`)
 *
 * Supported tokens:
 *
 *   {customerName}  Full customer name (e.g. "Richard Charnley")
 *   {firstName}     First word of customer name
 *   {lastName}      Everything after the first space (or empty if no space)
 *   {jobId}         OrderHub job ID (numeric)
 *   {orderNumber}   Order number (e.g. "PXDEMO-091YEC")
 *   {jobName}       Job name (e.g. "PXDEMO-091YEC-1") — falls back to orderNumber
 *   {filename}      Per-image filename including extension — supplied via ctx
 *   {originalFilename} Per-image customer original upload filename — supplied
 *                   via ctx. The caller is responsible for reducing the stored
 *                   manifest-relative path to whatever display form it wants
 *                   (this resolver just substitutes the string it's given).
 *
 * Empty/missing values resolve to empty string rather than throwing — the
 * resulting line still gets written, just with the token slot blank. This
 * mirrors the long-standing Frontline behaviour and avoids surprising the
 * operator with a blocked job over a missing optional field.
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

/**
 * Resolve {token} placeholders in `template` using values drawn from `job`
 * and per-image `ctx`.
 *
 * @param {string} template - The raw template string (may contain 0+ tokens)
 * @param {object} job - Job-level fields. Recognised: customer_name,
 *   id, order_number, job_name. Extra fields are ignored.
 * @param {object} [ctx] - Per-image context. Recognised: filename.
 * @returns {string}
 */
function resolveTemplate(template, job = {}, ctx = {}) {
  if (!template) return '';
  const { firstName, lastName } = _splitName(job.customer_name);
  return String(template)
    .replace(/\{customerName\}/g, job.customer_name  || '')
    .replace(/\{firstName\}/g,    firstName)
    .replace(/\{lastName\}/g,     lastName)
    .replace(/\{jobId\}/g,        String(job.id || ''))
    .replace(/\{orderNumber\}/g,  job.order_number   || '')
    .replace(/\{jobName\}/g,      job.job_name       || job.order_number || '')
    .replace(/\{filename\}/g,     ctx.filename       || '')
    .replace(/\{originalFilename\}/g, ctx.originalFilename || '');
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
 */
const SUPPORTED_TOKENS = [
  '{customerName}',
  '{firstName}',
  '{lastName}',
  '{jobId}',
  '{orderNumber}',
  '{jobName}',
  '{filename}',
  '{originalFilename}',
];

module.exports = { resolveTemplate, SUPPORTED_TOKENS, originalDisplayName };
