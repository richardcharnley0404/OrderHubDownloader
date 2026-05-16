'use strict';

const { resolveTemplate } = require('./template-tokens');

/**
 * Fuji JobMaker Output Generator
 *
 * Produces the plain-text `.txt` order files consumed by Fujifilm Frontier
 * Workflow Management Software (MS01) via the JobMaker API.
 *
 * Spec: docs/print-controllers/FUJI-JOBMAKER-FORMAT.md
 *
 * Pixfizz emits ONE FILE PER SURFACE. A job whose images span multiple paper
 * types (e.g. some Lustre, some Glossy) produces one `.txt` per surface, each
 * with its own `[OrderInfo]` header and its own Order_ID.
 *
 * File shape (Windows CRLF line endings):
 *
 *   [OrderInfo]
 *   Order_ID={surfaceCode}-{orderRef}
 *   ImagePath={imageStagingRoot}\{orderRef}\         ← trailing backslash
 *   Printer={printerName}              ← optional
 *   CustomerName={fullName}            ← optional
 *   Surface={surface}                  ← always emitted (grouping key)
 *   AutoCorrect=0|1                    ← optional, omitted when controller.autoCorrect is nullish
 *   Phone=...                          ← optional
 *   Email=...                          ← optional
 *   DueTime=mm/dd/yyyy HH:MM:SS AM/PM  ← optional, OHD-local tz
 *
 *   [ImageInfo]
 *   ImageFile={basename}               ← relative to ImagePath
 *   BackPrint={text or filename}       ← optional, mode-dependent
 *   [Print]
 *   PrintCode={frontier quick print code}
 *   PrintQty={n}                       ← always emitted (defaults to 1)
 *
 *   [ImageInfo] ...                    ← repeats per image; blank line between blocks
 *
 * The generator is a PURE function — no fs, no fs.watch. Callers handle image
 * staging and file writes via FujiJobMakerFileWriter (planned).
 *
 * v0 supports backprintMode 'none' and 'text'. 'image' mode is deferred until
 * the OH-side source of the back-print image is defined (Outstanding Q1).
 */

// ── Constants ────────────────────────────────────────────────────────────────

const CRLF = '\r\n';

// Characters Fuji rejects on Line 2 of the backprint (per v3.1 spec §BackPrint).
// Replaced with a space when found in the resolved template output.
const BACKPRINT_FORBIDDEN = /[%(;']/g;

// Tilde is converted to a hyphen by the IC on emission — we pre-convert so the
// 40-char truncation reflects what the customer actually receives.
const BACKPRINT_TILDE = /~/g;

const BACKPRINT_MAX_LEN = 40;

// ── Field formatters ────────────────────────────────────────────────────────

/**
 * Format a Date (or ISO string) as `mm/dd/yyyy HH:MM:SS AM/PM` in the OHD
 * machine's local time. Tz-naive — confirmed working at the Bally site.
 */
function _formatDueTime(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return '';

  const pad = (n) => String(n).padStart(2, '0');
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const year = d.getFullYear();

  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${pad(month)}/${pad(day)}/${year} ${pad(hours)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
}

/**
 * Sanitise + truncate a backprint string to Frontier's Line 2 rules:
 *   - Replace `%`, `(`, `;`, `'` with a space
 *   - Replace `~` with `-` (matches IC's own substitution)
 *   - Truncate to 40 chars
 */
function _sanitiseBackprintText(text) {
  if (!text) return '';
  return String(text)
    .replace(BACKPRINT_FORBIDDEN, ' ')
    .replace(BACKPRINT_TILDE, '-')
    .slice(0, BACKPRINT_MAX_LEN);
}

/**
 * Build the `Order_ID=` value for a surface group.
 *   {surfaceCode}-{orderRef}   when surfaceCode is set
 *   {firstChar(surface)}-{orderRef}  when surfaceCode is missing
 *   {orderRef}                 when neither surface nor surfaceCode is usable
 */
function _buildOrderId(orderRef, surfaceCode, surface) {
  const code = (surfaceCode && String(surfaceCode).trim())
    || (surface && String(surface).trim().charAt(0).toUpperCase())
    || '';
  return code ? `${code}-${orderRef}` : String(orderRef || '');
}

/**
 * Build the `ImagePath=` value with a guaranteed trailing backslash.
 *   {imageStagingRoot}\{orderRef}\
 */
function _buildImagePath(imageStagingRoot, orderRef) {
  const root = String(imageStagingRoot || '').replace(/[\\/]+$/, '');
  return `${root}\\${orderRef}\\`;
}

/**
 * Build the `.txt` filename for a surface group.
 *   {orderRef}_{surface}.txt    e.g. BALLY-Q7F39E_Lustre.txt
 */
function _buildFilename(orderRef, surface) {
  return `${orderRef}_${surface}.txt`;
}

// ── Job → file content ───────────────────────────────────────────────────────

/**
 * Resolve the BackPrint value for one image according to the controller's mode.
 *
 *   'none'  → returns null (field omitted)
 *   'text'  → resolves controller.backprintTemplate via template-tokens,
 *             sanitises and truncates to 40 chars
 *   'image' → returns image.backPrint verbatim (filename relative to ImagePath).
 *             v0 will NOT be wired in via the UI — but the emit path is here so
 *             the moment a back-print source is decided we can flip the switch.
 *
 * Returns null when nothing should be written.
 */
function _resolveBackPrint(controller, job, image) {
  const mode = controller.backprintMode || 'none';
  if (mode === 'none') return null;

  if (mode === 'text') {
    if (!controller.backprintTemplate) return null;
    const resolved = resolveTemplate(controller.backprintTemplate, _toTokenJob(job), {
      filename: image.filename,
    });
    const cleaned = _sanitiseBackprintText(resolved);
    return cleaned || null;
  }

  if (mode === 'image') {
    // image.backPrint should be a filename present in ImagePath. v0 does not
    // populate this — the field is here ready for the image-mode rollout.
    return image.backPrint || null;
  }

  return null;
}

/**
 * Reshape the generator's `job` into the snake_case shape expected by
 * template-tokens.resolveTemplate (which is shared with Frontline / Darkroom
 * Pro and predates the camelCase Fuji job shape).
 */
function _toTokenJob(job) {
  return {
    customer_name: job.customer ? job.customer.fullName : '',
    id: job.id || '',
    order_number: job.orderRef || '',
    job_name: job.jobName || job.orderRef || '',
  };
}

/**
 * Emit one complete surface file as an array of lines (joined with CRLF later).
 */
function _buildSurfaceFile(group, job, controller) {
  const lines = [];

  // ── [OrderInfo] ─────────────────────────────────────────────────────────
  lines.push('[OrderInfo]');
  lines.push(`Order_ID=${_buildOrderId(job.orderRef, group.surfaceCode, group.surface)}`);
  lines.push(`ImagePath=${_buildImagePath(controller.imageStagingRoot, job.orderRef)}`);

  if (controller.printerName) {
    lines.push(`Printer=${controller.printerName}`);
  }
  if (job.customer && job.customer.fullName) {
    lines.push(`CustomerName=${job.customer.fullName}`);
  }
  if (group.surface) {
    lines.push(`Surface=${group.surface}`);
  }
  if (controller.autoCorrect === true || controller.autoCorrect === 1) {
    lines.push('AutoCorrect=1');
  } else if (controller.autoCorrect === false || controller.autoCorrect === 0) {
    lines.push('AutoCorrect=0');
  }
  if (job.customer && job.customer.phone) {
    lines.push(`Phone=${job.customer.phone}`);
  }
  if (job.customer && job.customer.email) {
    lines.push(`Email=${job.customer.email}`);
  }
  if (job.dueAt) {
    const dueTime = _formatDueTime(job.dueAt);
    if (dueTime) lines.push(`DueTime=${dueTime}`);
  }

  // ── Image blocks ────────────────────────────────────────────────────────
  for (const image of group.images) {
    lines.push('');                                     // blank line between blocks
    lines.push('[ImageInfo]');
    lines.push(`ImageFile=${image.filename}`);

    const backPrint = _resolveBackPrint(controller, job, image);
    if (backPrint !== null && backPrint !== '') {
      lines.push(`BackPrint=${backPrint}`);
    }

    lines.push('[Print]');
    lines.push(`PrintCode=${image.printCode}`);
    lines.push(`PrintQty=${image.quantity != null ? image.quantity : 1}`);
  }

  // Trailing blank line — matches the production BALLY example which ends
  // with a CRLF after the last PrintQty. Joining with CRLF then appending CRLF
  // produces the same byte pattern.
  return lines.join(CRLF) + CRLF;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate one `.txt` per surface group for a job.
 *
 * The generator is intentionally agnostic about how images were grouped into
 * surfaces — the caller (a routing / channel-resolution step upstream) has
 * already resolved each image's printCode, surface, surfaceCode and grouped
 * them. This keeps the emitter testable from a pure data input.
 *
 * @param {object} job
 *   {
 *     orderRef:       string,              // e.g. 'BALLY-Q7F39E'
 *     id?:            string|number,       // OH job id (used by {jobId} token)
 *     jobName?:       string,              // OH job_name (used by {jobName} token)
 *     dueAt?:         Date | string | null,// emitted as DueTime in OHD-local tz
 *     customer: {
 *       fullName?:    string,              // e.g. 'Jersey Smith'
 *       email?:       string,
 *       phone?:       string,
 *     },
 *     surfaceGroups: [{
 *       surface:      string,              // 'Lustre' — written as Surface= AND part of filename
 *       surfaceCode?: string,              // 'L' — written as Order_ID prefix
 *       images: [{
 *         filename:   string,              // basename only; relative to ImagePath
 *         printCode:  string,              // 'PrintCode=' value
 *         quantity:   number,              // 'PrintQty=' value
 *         backPrint?: string,              // 'image' mode only — verbatim
 *       }]
 *     }]
 *   }
 *
 * @param {object} controller
 *   {
 *     imageStagingRoot:  string,           // '\\\\MASTER\\Pixfizz\\Artwork\\'
 *     printerName?:      string,           // 'DL650-A1'
 *     autoCorrect?:      boolean|0|1|null, // null → omit AutoCorrect=
 *     backprintMode?:    'none'|'text'|'image', // default 'none'
 *     backprintTemplate?:string,           // text-mode template
 *   }
 *
 * @returns {Array<{ filename: string, contents: string }>}
 *   One entry per surface group, in input order.
 */
function generateFujiJobMakerFiles(job, controller) {
  if (!job || typeof job !== 'object') {
    throw new Error('Fuji JobMaker: `job` is required');
  }
  if (!job.orderRef) {
    throw new Error('Fuji JobMaker: `job.orderRef` is required');
  }
  if (!Array.isArray(job.surfaceGroups) || job.surfaceGroups.length === 0) {
    throw new Error('Fuji JobMaker: `job.surfaceGroups` must contain at least one group');
  }
  if (!controller || typeof controller !== 'object') {
    throw new Error('Fuji JobMaker: `controller` is required');
  }
  if (!controller.imageStagingRoot) {
    throw new Error('Fuji JobMaker: `controller.imageStagingRoot` is required');
  }

  return job.surfaceGroups.map((group) => {
    if (!group.surface) {
      throw new Error('Fuji JobMaker: every surface group must have a `surface` value');
    }
    if (!Array.isArray(group.images) || group.images.length === 0) {
      throw new Error(`Fuji JobMaker: surface group "${group.surface}" has no images`);
    }
    return {
      filename: _buildFilename(job.orderRef, group.surface),
      contents: _buildSurfaceFile(group, job, controller),
    };
  });
}

module.exports = {
  generateFujiJobMakerFiles,
  // Exported for unit testing only — not part of the public contract.
  _internals: {
    _formatDueTime,
    _sanitiseBackprintText,
    _buildOrderId,
    _buildImagePath,
    _buildFilename,
    _resolveBackPrint,
  },
};
