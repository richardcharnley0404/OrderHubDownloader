'use strict';

/**
 * src/main/services/fuji-pic-pro-generator.js
 *
 * Pure function that emits the `.txt` order file consumed by
 * `OrderGateway.exe` in a Fuji PIC Pro deployment.
 *
 * Spec: docs/fuji-pic-pro-investigation-and-plan.md §2 (which cites the
 * *PIC Pro v3.0 User Guide — order.txt Specification*, pp. 339–370).
 * Full field list + rationale for what's included/omitted lives there.
 *
 * The generator is intentionally I/O-free — no fs, no Electron. Staging
 * + delivery + release commands are all `fuji-pic-pro-file-writer.js`
 * (M3). Callers give this function a job + controller and get back a
 * `{ filename, contents }` pair.
 *
 * Output shape — INI-style, case-sensitive, one file per order:
 *
 *   [Order]
 *   OrderId={orderId}
 *   CustomerName={customer.fullName}      ← only when includeCustomerName && set
 *   [Neg]
 *   NegNumber={image.negNumber}
 *   Backprint1={resolved}                 ← omitted when null/empty
 *   Backprint2={resolved}                 ← omitted when null/empty
 *   [Unit]
 *   Code={image.printCode}
 *   Qty={image.quantity ?? 1}
 *   Color={image.color || 'C'}
 *                                         ← [Neg]/[Unit] pair repeats per image
 *
 * Deliberately omitted (see the brief §M2 for the why):
 *   - Crop=, UnitCrop=, Orient= — the file that ships is already
 *     pre-cropped and pre-oriented by Manual Crop, so per-spec these
 *     fields aren't required for digital files (spec p. 351).
 *   - Retouch=, Logo=, LogoPos=, SlimText*, [Comp], [Node], *Product=
 *     — pre-cropped prints only; templates / composites / crop-cards /
 *     greeting cards / CD / index prints are out of scope for v0.
 *
 * Line endings are CRLF with a trailing CRLF at EOF — matches the
 * JobMaker generator's byte pattern so both files behave identically on
 * Windows shares.
 *
 * Back-print resolution reuses `_sanitiseBackprintText` from the
 * JobMaker generator (imported via its `_internals` export) so the
 * 40-char cap and the `[%(;']`/`~` substitutions can't drift between
 * the two Fuji types.
 */

const { resolveTemplate, originalDisplayName } = require('./template-tokens');
const jobMakerGenerator = require('./fuji-jobmaker-generator');

const CRLF = '\r\n';

// Spec: NegNumber is the digital filename with the extension stripped
// and MUST be ≤ 15 characters (p. 347). M3 stages images as
// 0001.<ext> / 0002.<ext> / … so the basename is always 4 chars — the
// cap can never realistically be hit, but the guard is here so a
// caller passing raw source basenames fails fast rather than silently
// emitting a `.txt` PIC Pro will reject.
const NEG_NUMBER_MAX_LEN = 15;

// ── Field helpers ────────────────────────────────────────────────────────────

/**
 * Reshape the generator's `job` into the snake_case shape template-tokens
 * expects. Duplicated from the JobMaker generator so the two Fuji
 * emitters stay independently modifiable — the JobMaker helper is a
 * private `_toTokenJob` there for the same reason.
 */
function _toTokenJob(job) {
  return {
    customer_name: job.customer ? job.customer.fullName : '',
    id:            job.id || '',
    order_number:  job.orderId || '',
    job_name:      job.jobName || job.orderId || '',
  };
}

/**
 * Resolve one back-print template line (Backprint1 or Backprint2) via
 * the shared token engine and the JobMaker sanitiser (40-char cap,
 * character replacements). Returns null when nothing should be
 * emitted — the caller drops the line entirely rather than write an
 * empty `Backprint1=`.
 */
function _resolveBackPrintLine(template, job, image) {
  if (!template) return null;
  const resolved = resolveTemplate(template, _toTokenJob(job), {
    filename:         image.filename || image.negNumber || '',
    // Manifest-relative original filename — same {originalFilename}
    // semantics Darkroom Pro + JobMaker use. Blank when the order
    // didn't ship one (e.g. non-Pixfizz sources).
    originalFilename: originalDisplayName(image.originalFilename),
  });
  const cleaned = jobMakerGenerator._internals._sanitiseBackprintText(resolved);
  return cleaned || null;
}

/**
 * Assemble the order file's lines. Separated from the public entry so
 * validation can happen before any string concatenation.
 */
function _buildOrderFile(job, controller) {
  const mode = controller.backprintMode || 'none';
  const wantsBackPrint = mode === 'text';

  const lines = [];
  lines.push('[Order]');
  lines.push(`OrderId=${job.orderId}`);

  // Emitted only when both the toggle is on AND we actually have a
  // name to write — a blank CustomerName= would just carry the
  // back-print-on-every-print side effect (spec p. 343) without any
  // real value.
  if (controller.includeCustomerName === true
      && job.customer && job.customer.fullName) {
    lines.push(`CustomerName=${job.customer.fullName}`);
  }

  for (const image of job.images) {
    lines.push('[Neg]');
    lines.push(`NegNumber=${image.negNumber}`);

    if (wantsBackPrint) {
      const bp1 = _resolveBackPrintLine(controller.backprintTemplate,  job, image);
      const bp2 = _resolveBackPrintLine(controller.backprintTemplate2, job, image);
      if (bp1) lines.push(`Backprint1=${bp1}`);
      if (bp2) lines.push(`Backprint2=${bp2}`);
    }

    lines.push('[Unit]');
    lines.push(`Code=${image.printCode}`);
    lines.push(`Qty=${image.quantity != null ? image.quantity : 1}`);
    // Fall back to 'C' rather than emit a blank Color= — the field is
    // mandatory (spec p. 353) and 'C' is the default Colour value.
    lines.push(`Color=${image.color || 'C'}`);
  }

  // Joining with CRLF then appending CRLF gives the trailing-CRLF-at-
  // EOF pattern the JobMaker writer produces. Frontier / OrderGateway
  // are permissive about the trailer, but matching bytes across the two
  // Fuji types makes disk diffs cleaner during debugging.
  return lines.join(CRLF) + CRLF;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate the single `{orderId}.txt` order file for a Fuji PIC Pro job.
 *
 * PIC Pro is one-file-per-order (unlike JobMaker's one-file-per-
 * surface), because OrderGateway ties surface to the per-image `Code=`
 * value rather than the file itself.
 *
 * @param {object} job
 *   {
 *     orderId:  string,             // written as `OrderId=`
 *     id?:      string|number,      // OH job id — used by {jobId} in back-print
 *     jobName?: string,             // used by {jobName} in back-print
 *     customer?: {
 *       fullName?: string,          // written as CustomerName= (guarded)
 *     },
 *     images:   Array<{
 *       negNumber:         string,  // basename without extension, ≤ 15 chars
 *       printCode:         string,  // written as `Code=`
 *       quantity?:         number,  // written as `Qty=`, defaults to 1
 *       color?:            string,  // written as `Color=`, defaults to 'C'
 *       originalFilename?: string,  // used by {originalFilename} in back-print
 *       filename?:         string,  // used by {filename} in back-print
 *                                   // (defaults to negNumber if unset)
 *     }>,
 *   }
 *
 * @param {object} controller
 *   {
 *     backprintMode?:      'none'|'text'|'image', // default 'none'
 *     backprintTemplate?:  string,               // line 1 — text mode
 *     backprintTemplate2?: string,               // line 2 — text mode, optional
 *     includeCustomerName?: boolean,             // default false
 *   }
 *
 * @returns {{ filename: string, contents: string }}
 * @throws  when any required field is missing or when a NegNumber
 *          exceeds the 15-char spec cap.
 */
function generateFujiPicProOrderFile(job, controller) {
  if (!job || typeof job !== 'object') {
    throw new Error('Fuji PIC Pro: `job` is required');
  }
  if (!job.orderId) {
    throw new Error('Fuji PIC Pro: `job.orderId` is required');
  }
  if (!Array.isArray(job.images) || job.images.length === 0) {
    throw new Error('Fuji PIC Pro: `job.images` must contain at least one image');
  }
  if (!controller || typeof controller !== 'object') {
    throw new Error('Fuji PIC Pro: `controller` is required');
  }

  for (let i = 0; i < job.images.length; i++) {
    const img = job.images[i];
    if (!img || !img.negNumber) {
      throw new Error(`Fuji PIC Pro: images[${i}] is missing a negNumber`);
    }
    if (String(img.negNumber).length > NEG_NUMBER_MAX_LEN) {
      throw new Error(
        `Fuji PIC Pro: images[${i}].negNumber "${img.negNumber}" exceeds the ${NEG_NUMBER_MAX_LEN}-char PIC Pro cap`
      );
    }
    if (!img.printCode) {
      throw new Error(`Fuji PIC Pro: images[${i}] (negNumber "${img.negNumber}") is missing a printCode`);
    }
  }

  return {
    filename: `${job.orderId}.txt`,
    contents: _buildOrderFile(job, controller),
  };
}

module.exports = {
  generateFujiPicProOrderFile,
  // Exported for unit testing only — not part of the public contract.
  _internals: {
    _toTokenJob,
    _resolveBackPrintLine,
    NEG_NUMBER_MAX_LEN,
  },
};
