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
    .replace(/\{filename\}/g,     ctx.filename       || '');
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
];

module.exports = { resolveTemplate, SUPPORTED_TOKENS };
