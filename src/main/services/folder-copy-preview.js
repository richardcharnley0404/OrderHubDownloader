'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const { buildCopyFilenames, buildDestFolder } = require('./folder-copy-filename');
const { resolveManifestPath } = require('./manifest-path');
const { readOrderNumberPrefixRules } = require('../../shared/printUtils');

/**
 * folder-copy-preview
 *
 * Live-preview service for the Folder Copy settings modal (M5 of
 * docs/folder-copy-filename-templates-brief.md).
 *
 * The preview MUST run the real M1+M2 code path — anything less means
 * the preview will disagree with the actual dispatch exactly when the
 * operator is trusting it. So this module resolves a sample job, builds
 * its images, and calls `buildCopyFilenames` directly. The test asserts
 * equality against `buildCopyFilenames` (not against a literal), so any
 * future change to the planner flows through the preview automatically.
 *
 * The IPC handler (ipc-handlers.js) is a thin wrapper: it wires the
 * default deps to the real services and forwards the payload. Everything
 * else — sample source resolution, dep-injectable manifest read, warning
 * synthesis — lives here where it is testable in isolation.
 *
 * READ-ONLY. This module and its default deps never write anything
 * anywhere. The manifest read is fs.readFileSync only.
 *
 * ── Sample source resolution (order matters) ────────────────────────────
 *
 *   1. Most recent job routed to `controllerId` AND with a readable
 *      manifest under `downloadDirectory`.
 *   2. Most recent job with a readable manifest (any controller).
 *   3. Synthetic sample — labelled clearly so operators cannot mistake
 *      it for a real resolution.
 *
 * Recency is `created_at` desc; jobs without `created_at` sort last.
 *
 * ── Sample size ─────────────────────────────────────────────────────────
 *
 * Up to MAX_PREVIEW_SAMPLES (currently 3). Enough to reveal within-dispatch
 * collision + suffix behaviour on a 3-image job with a template like
 * `{product}`, so an under-specified template shows its problem in the
 * preview rather than at first real dispatch.
 */

const MAX_PREVIEW_SAMPLES = 3;

/**
 * Synthetic job used when no real job with a readable manifest can be
 * found. Deliberately mundane — no unicode, no unsafe chars — so the
 * operator sees the plain resolved shape without sanitisation "helping"
 * with the visual explanation.
 *
 * Field values pick values that make every M1 token resolve to something
 * visible: {customerName}, {product}, {productCode}, {options},
 * {option:finish-options}, {dueDate}, etc. If an operator's template
 * uses a token and it renders blank on the sample, that's a signal.
 */
const SYNTHETIC_JOB = Object.freeze({
  id:             999999,
  order_number:   'PXDEMO-SAMPLE',
  job_name:       'PXDEMO-SAMPLE-1',
  customer_name:  'Sample Customer',
  product:        '4x6 Photo Print',
  product_code:   '0406-cut-print',
  category:       'Prints',
  process:        'Lab',
  due_date:       '2026-08-20T09:00:00Z',
  options: Object.freeze([
    Object.freeze({ name: 'finish-options', value: 'lustre' }),
    Object.freeze({ name: 'layout-options', value: 'full-bleed' }),
  ]),
});

const SYNTHETIC_IMAGES = Object.freeze([
  Object.freeze({ sourcePath: 'IMG_0001.jpg', filename: 'IMG_0001.jpg', quantity: 2, originalFilename: 'IMG_0001.jpg' }),
  Object.freeze({ sourcePath: 'IMG_0002.jpg', filename: 'IMG_0002.jpg', quantity: 1, originalFilename: 'IMG_0002.jpg' }),
  Object.freeze({ sourcePath: 'IMG_0003.jpg', filename: 'IMG_0003.jpg', quantity: 4, originalFilename: 'IMG_0003.jpg' }),
]);

// ── Default deps ────────────────────────────────────────────────────────

function _defaultReadManifest(orderFolderPath, orderNumber) {
  try {
    const manifestPath = resolveManifestPath(orderFolderPath, orderNumber);
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ── Sample resolution ───────────────────────────────────────────────────

function _pickJobFromManifest(manifest, job) {
  if (!manifest || !Array.isArray(manifest.jobs)) return null;
  const jobId          = String(job.id);
  const internalJobId  = job.internal_job_id ? String(job.internal_job_id) : null;
  return manifest.jobs.find(j => {
    const mid = String(j.jobId);
    return mid === jobId || (internalJobId && mid === internalJobId);
  }) || null;
}

function _sortByRecency(jobs) {
  return [...jobs].sort((a, b) => {
    const da = a && a.created_at ? Date.parse(a.created_at) : 0;
    const db = b && b.created_at ? Date.parse(b.created_at) : 0;
    return (db || 0) - (da || 0);
  });
}

function _extractImages(jobManifest) {
  if (!jobManifest || !Array.isArray(jobManifest.images)) return [];
  return jobManifest.images.map(img => {
    const filename = path.basename(img.filename || '');
    return {
      // sourcePath only feeds path.extname for the M2 planner; the real
      // file path is not needed for preview. Using the basename keeps
      // extension resolution correct without touching fs.
      sourcePath:       filename,
      filename,
      quantity:         img.quantity,
      originalFilename: img.originalFilename,
    };
  });
}

async function _resolveSample({ controllerId, listJobs, resolveRouteFor, readManifest, getDownloadDirectory }) {
  const jobs  = (listJobs && listJobs()) || [];
  const dlDir = (getDownloadDirectory && getDownloadDirectory()) || null;

  const readJobManifest = (job) => {
    if (!dlDir || !job || !job.order_number || !job.order_id) return null;
    const orderFolder = path.join(dlDir, `${job.order_number}_${job.order_id}`);
    const manifest    = readManifest(orderFolder, job.order_number);
    return manifest ? _pickJobFromManifest(manifest, job) : null;
  };

  const sorted = _sortByRecency(jobs);

  // 1. Most recent job routed to `controllerId` with a readable manifest.
  if (controllerId && resolveRouteFor) {
    for (const job of sorted) {
      let route;
      try { route = resolveRouteFor(job); } catch (_) { continue; }
      if (!route || route.controllerId !== controllerId) continue;
      const jm = readJobManifest(job);
      if (!jm) continue;
      const images = _extractImages(jm);
      if (images.length === 0) continue;   // a manifest that parses but has no images is not a useful preview
      return { kind: 'routed-job', label: `Preview using job ${job.id}`, job, images };
    }
  }

  // 2. Any job with a readable manifest.
  for (const job of sorted) {
    const jm = readJobManifest(job);
    if (!jm) continue;
    const images = _extractImages(jm);
    if (images.length === 0) continue;
    return { kind: 'any-manifest', label: `Preview using job ${job.id}`, job, images };
  }

  // 3. Synthetic — LABELLED so an operator can never confuse it with a
  // real resolution.
  return {
    kind:   'synthetic',
    label:  'Preview using sample data',
    job:    SYNTHETIC_JOB,
    // Copy to unfreeze — buildCopyFilenames mutates nothing but future
    // callers might, and passing frozen arrays around is a footgun.
    images: SYNTHETIC_IMAGES.map(i => ({ ...i })),
  };
}

// ── Warning synthesis ───────────────────────────────────────────────────

// The pattern regex could live inline; broken out here so the "what counts
// as machine-shaped" definition is one line and the tests can lock it.
// - Starts with "db:" (case-insensitive) — Pixfizz photo-database keys.
// - OR all digits and longer than 8 characters — Shopify variant ids,
//   OrderHub internal ids, etc. Length 8+ is chosen so common short
//   numeric options like "12x18" widths or a two-digit border thickness
//   never trip the check.
function _looksLikeMachineValue(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (/^db:/i.test(s)) return true;
  if (/^\d+$/.test(s) && s.length > 8) return true;
  return false;
}

function _synthWarnings(stats, sampleSize, filenameTemplate, jobOptions) {
  const warnings = [];
  if (stats.suffixed > 0) {
    warnings.push({
      kind: 'suffixed',
      text: `${stats.suffixed} of ${sampleSize} preview names needed an auto-suffix — add {index} or {indexPadded} to the template so every filename is distinct.`,
    });
  }
  if (stats.truncated > 0) {
    warnings.push({
      kind: 'truncated',
      text: `${stats.truncated} of ${sampleSize} preview names hit the 120-character stem limit and were truncated. Shorten the template.`,
    });
  }
  if (stats.fallbacks.length > 0) {
    warnings.push({
      kind: 'fallback',
      text: `${stats.fallbacks.length} of ${sampleSize} preview names resolved to empty and fell back to the original basename. Check the tokens in the template.`,
    });
  }
  // {options} machine-value warning (M8). Only fires when the template
  // ACTUALLY uses the {options} token AND at least one option on the
  // sample job resolves to a machine-shaped value — otherwise there is
  // nothing to fix. Regex is `\{options\}` (literal): the closing `}`
  // after `s` distinguishes it from `{option:NAME}` which has `:` after
  // `option`. Doesn't match inside a resolved value because the check
  // runs on the RAW template string.
  const templateUsesOptions = typeof filenameTemplate === 'string' && /\{options\}/.test(filenameTemplate);
  if (templateUsesOptions && Array.isArray(jobOptions)) {
    const machineHits = jobOptions
      .filter(o => o && _looksLikeMachineValue(o.value))
      .map(o => `${o.name}=${String(o.value).trim()}`);
    if (machineHits.length > 0) {
      warnings.push({
        kind: 'machine-value',
        text:
          `{options} on this job resolves to include a machine value (${machineHits.join(', ')}). ` +
          `That will land in the filename. Use {option:NAME} for the specific option you want — ` +
          `the option chips above show what's available on this job.`,
      });
    }
  }
  return warnings;
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Build a preview response for the Folder Copy settings modal.
 *
 * @param {object} input
 * @param {string} [input.controllerId]           — optional controller id;
 *   when present, the sample-source resolver prefers a job routed to this
 *   controller. Absent (new-controller modal) skips step 1.
 * @param {string} [input.outputPath]             — the controller's output
 *   path. If blank, the returned destPath strings are relative.
 * @param {string} [input.filenameTemplate]       — free-text template.
 *   Blank keeps the original filenames (§4.1 no-change lock).
 * @param {'job'|'root'} [input.destinationLayout]— defaults to 'job'.
 * @param {Array<{from:string,to:string}>} [input.orderNumberPrefixRules] —
 *   controller prefix rules (M7b). Also accepts the legacy M7 shape
 *   (`stripOrderNumberPrefixes: string[]`) and legacy 1.13.0 shape
 *   (`stripOrderNumberPrefix: string`) via the tolerant reader —
 *   whatever the modal has locally, unsaved or not.
 *
 * @param {object} [deps] — injectable dependencies (all optional; sensible
 *   defaults for production wiring in the IPC handler).
 * @param {() => object[]}      [deps.listJobs]            — snapshot of local jobs
 * @param {(job) => object|null}[deps.resolveRouteFor]     — routing-service.resolveRoute
 * @param {() => string|null}   [deps.getDownloadDirectory]— configService.get('downloadDirectory')
 * @param {(orderFolder, orderNumber) => object|null} [deps.readManifest] — see _defaultReadManifest
 *
 * @returns {Promise<PreviewResponse>}
 */
async function buildFolderCopyPreview(input = {}, deps = {}) {
  const controllerId      = input.controllerId || null;
  const outputPath        = typeof input.outputPath === 'string' ? input.outputPath : '';
  const filenameTemplate  = typeof input.filenameTemplate === 'string' ? input.filenameTemplate.trim() : '';
  const destinationLayout = input.destinationLayout === 'root' ? 'root' : 'job';
  // M7b: orderNumberPrefixRules is Array<{from,to}>. Coerce via the ONE
  // tolerant reader — so a modal that still has the M7 string[] or the
  // 1.13.0 single-string in an unsaved buffer is still previewable, and
  // the coercion rule stays in one place (printUtils).
  const rawRules = readOrderNumberPrefixRules(input);
  // Trim each side so the preview reflects what save-time trimming
  // will produce; drop rules that go empty on `from` after trim.
  const prefixRules = rawRules
    .map(r => ({ from: r.from.trim(), to: (r.to || '').trim() }))
    .filter(r => r.from.length > 0);

  const {
    listJobs             = () => [],
    resolveRouteFor      = () => null,
    getDownloadDirectory = () => null,
    readManifest         = _defaultReadManifest,
  } = deps;

  const source = await _resolveSample({
    controllerId, listJobs, resolveRouteFor, readManifest, getDownloadDirectory,
  });

  // Run the planner on the FULL image list (M5a fix). Slicing to 3 BEFORE
  // the planner call was two lies:
  //   - ctx.imageCount = 3 → {indexPadded} widths derived from 3, not
  //     the real image count. Preview showed 1/2/3; dispatch shipped
  //     01..40. The preview was showing filenames that were not the
  //     filenames.
  //   - Within-call collision detection only saw 3 of 40, so
  //     stats.suffixed under-reported. A template without an index
  //     token previewed with no auto-suffix warning and then suffixed
  //     39 files at dispatch — the warning went quiet exactly when it
  //     mattered.
  // The planner is pure and cheap; running it on 40 iterations of
  // string replacement costs nothing. Slice for display only.
  const { files: allFiles, stats } = buildCopyFilenames(source.images, source.job, {
    template:    filenameTemplate,
    prefixRules,
  });
  const displayedFiles = allFiles.slice(0, MAX_PREVIEW_SAMPLES);

  // Destination folder — ONE implementation of §6.2, shared with the M4
  // dispatch path via folder-copy-filename.buildDestFolder. Preview and
  // dispatch cannot disagree on where a file will land.
  const destFolder = buildDestFolder({
    outputPath,
    orderNumber: source.job.order_number,
    jobId:       source.job.id,
    destinationLayout,
    prefixRules,
  });

  const filesWithPaths = displayedFiles.map(f => ({
    destFilename: f.destFilename,
    // path.join('', name) → name, so this handles blank destFolder cleanly.
    destPath:     path.join(destFolder, f.destFilename),
  }));

  // M8 — surface the sample job's option NAMES so the renderer can render
  // them as clickable chips ("what options does this job actually have?").
  // `{option:NAME}` is unusable without knowing the name; nothing else in
  // the app tells the operator. Names come straight from the resolved
  // sample so no second lookup is needed; if the sample has no options
  // (some products don't) this is [].
  const sampleOptionNames = Array.isArray(source.job.options)
    ? source.job.options
        .map(o => (o && typeof o.name === 'string') ? o.name.trim() : '')
        .filter(Boolean)
    : [];

  return {
    source: {
      kind:  source.kind,
      label: source.label,
      jobId: source.job.id != null ? source.job.id : null,
    },
    outputPath,
    destinationLayout,
    destFolder,
    totalImageCount:   source.images.length,
    sampleSize:        displayedFiles.length,
    files:             filesWithPaths,
    sampleOptionNames,
    // Warnings synthesised from the FULL-run stats — sampleSize below is
    // deliberately allFiles.length so the wording ("N of M preview names")
    // reflects the honest count the planner just computed on every image,
    // not the display truncation. `filenameTemplate` and the sample's
    // options are also passed in so the M8 {options}-with-machine-value
    // check knows what to warn about.
    warnings:          _synthWarnings(stats, allFiles.length, filenameTemplate, source.job.options),
    // Full-run stats passed through so the equality-with-M2 test can lock
    // the preview against buildCopyFilenames' return for the FULL list.
    stats,
  };
}

module.exports = {
  buildFolderCopyPreview,
  SYNTHETIC_JOB,
  SYNTHETIC_IMAGES,
  MAX_PREVIEW_SAMPLES,
  // Exported for tests that want to override the default fs-based reader.
  _defaultReadManifest,
  // Exported for the M8 machine-value test to lock the "what counts as
  // machine-shaped" definition in one place.
  _looksLikeMachineValue,
};
