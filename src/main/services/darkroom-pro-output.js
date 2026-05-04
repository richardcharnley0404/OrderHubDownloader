'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const { resolveTemplate } = require('./template-tokens');

/**
 * Darkroom Pro Output Generator
 *
 * Generates a plain-text order file (.txt) for Darkroom Pro's hot folder.
 *
 * Format (Windows CRLF line endings):
 *   OrderFirstName=...
 *   OrderLastName=...
 *   OrderEmail=...
 *   ExtOrderNum=...           ← per-job filename stem (e.g. PXDEMO-D4LNF6-1)
 *   [blank line]
 *   Qty=...                   ┐
 *   Size=...                  │
 *   Media=...                 │ One COMPLETE block per image —
 *   Date= MMMM DD, YYYY       │ all fields repeated for safety
 *   Orderid=...               │ (Qty especially must reset per image
 *   {photoLines, optional}    │  or sticky-field semantics would carry
 *   Filepath=...              ┘  the previous image's qty forward).
 *   [blank line between blocks; no trailing blank]
 *
 * Size is resolved from controller.sizeTranslations using the job's product code.
 * Media is resolved from controller.mediaOptionKey + controller.mediaTranslations
 * using the line item's job options.
 *
 * ExtOrderNum and Orderid both emit `job.outputFilenameStem` (the per-job
 * identifier — typically the OrderHub job_name like "PXDEMO-D4LNF6-1") so the
 * value inside the file matches the .txt filename and uniquely identifies the
 * job within a multi-job order. Falls back to `job.orderRef` if no stem set.
 *
 * Photo lines (controller.photoLines) are operator-configured key/value pairs
 * inserted between Orderid= and Filepath= in every block. Each entry is
 * { darkroomField, ohdTemplate } — the field name is emitted verbatim on the
 * left side of `=` and the template is resolved per image using the shared
 * template-tokens helper. Empty/missing entries are skipped silently. Common
 * use case: writing back-print captions on the reverse of each photo.
 *
 * Output filename: {outputFilenameStem || orderRef}.txt  written to controller.outputPath
 */

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Format a Date (or ISO string) as "MMMM DD, YYYY" (e.g. "April 01, 2026").
 */
function _formatDate(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const month = MONTHS[d.getMonth()];
  const day   = String(d.getDate()).padStart(2, '0');
  const year  = d.getFullYear();
  return `${month} ${day}, ${year}`;
}

// ── Last-name format ──────────────────────────────────────────────────────────

/**
 * Format the OrderLastName field per controller.orderLastNameFormat.
 */
function _formatOrderLastName(job, controller) {
  const fmt = controller.orderLastNameFormat || 'orderRef_lastName';
  switch (fmt) {
    case 'lastName':
      return job.customer.lastName;
    case 'labCode_orderRef_lastName':
      return `${job.labCode}-${job.orderRef} - ${job.customer.lastName}`;
    case 'orderRef_lastName':
    default:
      return `${job.orderRef} - ${job.customer.lastName}`;
  }
}

// ── Translation helpers ───────────────────────────────────────────────────────

/**
 * Resolve the Darkroom Pro size string from the controller's sizeTranslations.
 *
 * Matching is an exact, case-insensitive comparison against the full product code.
 * A per-job manual override (from the Assign modal) takes priority over the table.
 * Returns empty string when no match found.
 *
 * @param {string} productCode       - e.g. "0406-cut-print"
 * @param {Array}  sizeTranslations  - [{ productCodePrefix, darkroomSize }]
 * @param {string} [jobOverride]     - manual size entered via the Assign modal
 * @returns {string}
 */
function resolveSize(productCode, sizeTranslations, jobOverride) {
  if (jobOverride) return jobOverride;
  if (!productCode || !Array.isArray(sizeTranslations) || sizeTranslations.length === 0) {
    return '';
  }
  const match = sizeTranslations.find(
    t => t.productCodePrefix && t.productCodePrefix.toLowerCase() === productCode.toLowerCase()
  );
  return match ? match.darkroomSize : '';
}

/**
 * Resolve the Darkroom Pro media string from the controller's media config.
 *
 * Resolution order:
 *   1. Per-job manual override (Assign modal) — wins outright.
 *   2. Translation table lookup: find the option named mediaOptionKey on the
 *      line item, then look up its value in mediaTranslations and return `to`.
 *   3. Otherwise return ''.
 *
 * No raw-value fallback. If the option exists on the job but no translation
 * matches, this returns '' on purpose — the upstream gate in routing-service
 * (mediaConfigured && !resolvedMedia → unrouted) and the dispatch-time
 * pre-flight (`if (!media) throw`) both depend on '' meaning "I cannot
 * resolve this; surface Assign or fail loudly". Returning the raw option
 * value silently masks option-name mismatches and writes values to the
 * Darkroom Pro hot folder that customers never see in the OHD UI.
 *
 * Empty-string return cases:
 *   - mediaOptionKey not configured (caller is expected to skip the field)
 *   - lineItemOptions not an array
 *   - option not present on the line item (name mismatch)
 *   - option present but value doesn't match any translation `from`
 *
 * @param {Array}  lineItemOptions   - [{ name, value }] from the job
 * @param {string} mediaOptionKey    - e.g. "finish-options"
 * @param {Array}  mediaTranslations - [{ from, to }]
 * @param {string} [jobOverride]     - manual media entered via the Assign modal
 * @returns {string}
 */
function resolveMedia(lineItemOptions, mediaOptionKey, mediaTranslations, jobOverride) {
  if (jobOverride) return jobOverride;
  if (!mediaOptionKey || !Array.isArray(lineItemOptions)) return '';

  const entry = lineItemOptions.find(
    o => o.name && o.name.toLowerCase() === mediaOptionKey.toLowerCase()
  );
  if (!entry) return '';

  const translation = Array.isArray(mediaTranslations)
    ? mediaTranslations.find(t => t.from && t.from.toLowerCase() === entry.value.toLowerCase())
    : null;

  return translation ? translation.to : '';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a Darkroom Pro order file and write it to controller.outputPath.
 *
 * @param {object} job
 *   {
 *     orderRef:    string,
 *     productCode: string,
 *     customer:    { firstName, lastName, email },
 *     labCode:     string,
 *     orderDate:   Date | string,
 *     lineItems: [{
 *       qty:     number,
 *       options: [{ name, value }],   // job options for this line item
 *       images:  [{ filename: string, sourcePath: string }]
 *     }]
 *   }
 * @param {object} controller
 *   {
 *     artworkRootPath:     string,
 *     orderLastNameFormat: string,
 *     outputPath:          string,
 *     sizeTranslations:    [{ productCodePrefix, darkroomSize }],
 *     mediaOptionKey:      string,
 *     mediaTranslations:   [{ from, to }]
 *   }
 * @returns {Promise<string>} Absolute path of the written .txt file
 */
async function generateDarkroomProFile(job, controller) {
  const formattedDate     = _formatDate(job.orderDate || new Date());
  const formattedLastName = _formatOrderLastName(job, controller);

  // ── Pre-flight validation ─────────────────────────────────────────────────
  // Resolve Size once (product-code level) and Media per line item up front.
  // Per-job manual overrides (_sizeOverride / _mediaOverride) set via the
  // Assign modal take priority over the translation tables.
  // Throw with a descriptive message rather than writing an unusable file with
  // empty Size= or Media= fields.

  const size = resolveSize(job.productCode, controller.sizeTranslations, job._sizeOverride);
  if (!size) {
    throw new Error(
      `Darkroom Pro: No size translation found for product code "${job.productCode}". ` +
      `Add a Size Translation entry for this product code in the controller settings.`
    );
  }

  // Media is only required when the controller has mediaOptionKey
  // configured. For fixed-size products without media variation, the
  // controller can be set up with size translations only — media is
  // emitted as an empty value in the file. This mirrors the routing-time
  // gate in routing-service.js (resolveRoute → mediaConfigured).
  const mediaConfigured = !!controller.mediaOptionKey;
  if (mediaConfigured) {
    for (const lineItem of job.lineItems) {
      const media = resolveMedia(
        lineItem.options || [],
        controller.mediaOptionKey,
        controller.mediaTranslations,
        job._mediaOverride
      );
      if (!media) {
        // The job either (a) doesn't carry an option named mediaOptionKey, or
        // (b) carries one whose value isn't in mediaTranslations. Either way,
        // dispatch is unsafe — Darkroom Pro would receive Media= blank and
        // pick whatever default is configured on its side, which is rarely
        // what the customer ordered. Operators should see the Assign button
        // for this job instead of a silent dispatch.
        const optionNames = (lineItem.options || []).map(o => o.name).join(', ') || '(none)';
        throw new Error(
          `Darkroom Pro: Could not resolve Media for option key "${controller.mediaOptionKey}". ` +
          `Job options: [${optionNames}]. ` +
          `Either the option is missing on this job, or its value isn't in the Media Translations table. ` +
          `Add a translation entry, fix the Paper Type Option Key, or use Assign to set Media manually.`
        );
      }
    }
  }

  // The per-job identifier emitted as ExtOrderNum and Orderid. Use the same
  // stem that the .txt filename uses so the value inside the file matches the
  // filename and uniquely identifies this job within a multi-job order
  // (orderRef alone is shared across all jobs in an order). Fall back to
  // orderRef for back-compat with any caller that hasn't set the stem.
  const jobIdentifier = job.outputFilenameStem || job.orderRef;

  // Sanitise photoLines once up front — drop entries with no darkroomField
  // (the left side of `=`); empty templates are allowed (resolves to '').
  const photoLines = (controller.photoLines || [])
    .filter(pl => pl && typeof pl.darkroomField === 'string' && pl.darkroomField.trim() !== '')
    .map(pl => ({
      darkroomField: pl.darkroomField.trim(),
      ohdTemplate:   typeof pl.ohdTemplate === 'string' ? pl.ohdTemplate : '',
    }));

  // Build a job-shaped object the shared template resolver understands. The
  // resolver expects OrderHub's snake_case fields (customer_name, id, etc.)
  // — the dpJob shape print-service builds doesn't carry those, so reconstruct
  // what we can from what we have. customer_name is rebuilt from firstName +
  // lastName so {customerName}/{firstName}/{lastName} all resolve correctly.
  const tokenJob = {
    customer_name: [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' '),
    id:            job.id || '',
    order_number:  job.orderRef,
    job_name:      job.outputFilenameStem || job.orderRef,
  };

  // Flatten line items into a single per-image stream. The grouping by qty
  // in print-service.js was an artifact of an older sticky-field design; the
  // current emitter treats every image as its own complete block so Qty etc.
  // can never accidentally apply to the wrong image.
  const allImages = [];
  for (const lineItem of job.lineItems) {
    const media = resolveMedia(
      lineItem.options || [],
      controller.mediaOptionKey,
      controller.mediaTranslations,
      job._mediaOverride
    );
    for (const image of lineItem.images) {
      allImages.push({ image, qty: lineItem.qty, media });
    }
  }

  const lines = [];

  // ── Order header ─────────────────────────────────────────────────────────
  lines.push(`OrderFirstName=${job.customer.firstName}`);
  lines.push(`OrderLastName=${formattedLastName}`);
  lines.push(`OrderEmail=${job.customer.email}`);
  lines.push(`ExtOrderNum=${jobIdentifier}`);
  lines.push(''); // blank line after header block

  // ── Per-image blocks ──────────────────────────────────────────────────────
  // One complete block per image. Qty/Size/Media/Date/Orderid are repeated
  // even when they don't change — explicit-per-image is safer than relying
  // on Darkroom Pro's sticky-field inheritance, especially for Qty which
  // would otherwise carry forward from the previous image.
  for (let i = 0; i < allImages.length; i++) {
    const { image, qty, media } = allImages[i];

    // sourcePath is the resolved absolute local path (enhanced → corrected → raw download).
    // Normalise to Windows backslashes as Darkroom Pro requires them.
    const filepath = image.sourcePath.replace(/\//g, '\\');
    const filename = image.filename || path.basename(filepath);

    lines.push(`Qty=${qty}`);
    lines.push(`Size=${size}`);
    lines.push(`Media=${media}`);
    lines.push(`Date= ${formattedDate}`);
    lines.push(`Orderid=${jobIdentifier}`);

    // Configurable photo lines — resolved per image so {filename} and any
    // future per-image tokens reflect the current image, not the first one.
    for (const pl of photoLines) {
      const value = resolveTemplate(pl.ohdTemplate, tokenJob, { filename });
      lines.push(`${pl.darkroomField}=${value}`);
    }

    lines.push(`Filepath=${filepath}`);

    // Blank line between blocks — not after the last one
    if (i < allImages.length - 1) {
      lines.push('');
    }
  }

  // ── Write file ────────────────────────────────────────────────────────────
  const content  = lines.join('\r\n');
  // Filename uses the same per-job stem written into ExtOrderNum / Orderid
  // above, so the value inside the file matches the filename. Multi-job
  // orders need unique filenames or the second job's .txt overwrites the
  // first — orderRef alone is shared across all jobs in an order.
  const filename = `${jobIdentifier}.txt`;
  const destPath = path.join(controller.outputPath, filename);

  await fs.promises.mkdir(controller.outputPath, { recursive: true });
  await fs.promises.writeFile(destPath, content, 'utf8');

  logger.info('[DarkroomPro] Order file written', { destPath, orderRef: job.orderRef, filename });

  return destPath;
}

module.exports = { generateDarkroomProFile, resolveSize, resolveMedia };
