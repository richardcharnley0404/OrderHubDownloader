'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

/**
 * Darkroom Pro Output Generator
 *
 * Generates a plain-text order file (.txt) for Darkroom Pro's hot folder.
 *
 * Format (Windows CRLF line endings):
 *   OrderFirstName=...
 *   OrderLastName=...
 *   OrderEmail=...
 *   ExtOrderNum=...
 *   [blank line]
 *   Qty=...
 *   Size=...
 *   Media=...
 *   Date= MMMM DD, YYYY
 *   Orderid=...
 *   Photo.First Name=...
 *   Photo.Last Name=...
 *   Filepath=...    ← one per image
 *   [blank line between line item blocks; no trailing blank]
 *
 * Size is resolved from controller.sizeTranslations using the job's product code.
 * Media is resolved from controller.mediaOptionKey + controller.mediaTranslations
 * using the line item's job options.
 *
 * Output filename: {orderRef}.txt  written to controller.outputPath
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
 * A per-job manual override (from the Assign modal) takes priority over the
 * translation table lookup.
 * Looks up the value of the configured mediaOptionKey in the line item's options,
 * then translates it via mediaTranslations.
 * Falls back to the raw option value if no translation entry matches —
 * this is intentional (passing `lustre` is better than an empty string).
 *
 * Returns empty string only when mediaOptionKey is not configured or the option
 * is not present on this line item (and no job override is supplied).
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

  return translation ? translation.to : entry.value; // raw fallback
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

  for (const lineItem of job.lineItems) {
    const media = resolveMedia(
      lineItem.options || [],
      controller.mediaOptionKey,
      controller.mediaTranslations,
      job._mediaOverride
    );
    if (!media) {
      throw new Error(
        `Darkroom Pro: No media translation found for option key "${controller.mediaOptionKey || '(not set)'}". ` +
        `Check the Media Option Key and Media Translations in the controller settings.`
      );
    }
  }

  const lines = [];

  // ── Order header ─────────────────────────────────────────────────────────
  lines.push(`OrderFirstName=${job.customer.firstName}`);
  lines.push(`OrderLastName=${formattedLastName}`);
  lines.push(`OrderEmail=${job.customer.email}`);
  lines.push(`ExtOrderNum=${job.orderRef}`);
  lines.push(''); // blank line after header block

  // ── Line item blocks ──────────────────────────────────────────────────────
  for (let i = 0; i < job.lineItems.length; i++) {
    const lineItem = job.lineItems[i];

    // Size is product-code level (resolved above); Media is per line item.
    const media = resolveMedia(
      lineItem.options || [],
      controller.mediaOptionKey,
      controller.mediaTranslations,
      job._mediaOverride
    );

    lines.push(`Qty=${lineItem.qty}`);
    lines.push(`Size=${size}`);
    lines.push(`Media=${media}`);
    lines.push(`Date= ${formattedDate}`);
    lines.push(`Orderid=${job.orderRef}`);
    lines.push(`Photo.First Name=${lineItem.images[0]?.filename || ''}`);
    lines.push(`Photo.Last Name=${job.customer.lastName}`);

    for (const image of lineItem.images) {
      // sourcePath is the resolved absolute local path (enhanced → corrected → raw download).
      // Normalise to Windows backslashes as Darkroom Pro requires them.
      const filepath = image.sourcePath.replace(/\//g, '\\');
      lines.push(`Filepath=${filepath}`);
    }

    // Blank line between blocks — not after the last one
    if (i < job.lineItems.length - 1) {
      lines.push('');
    }
  }

  // ── Write file ────────────────────────────────────────────────────────────
  const content  = lines.join('\r\n');
  const filename = `${job.orderRef}.txt`;
  const destPath = path.join(controller.outputPath, filename);

  await fs.promises.mkdir(controller.outputPath, { recursive: true });
  await fs.promises.writeFile(destPath, content, 'utf8');

  logger.info('[DarkroomPro] Order file written', { destPath, orderRef: job.orderRef });

  return destPath;
}

module.exports = { generateDarkroomProFile, resolveSize, resolveMedia };
