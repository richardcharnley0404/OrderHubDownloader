'use strict';

/**
 * src/main/services/s3-artwork-downloader.js
 *
 * S3 artwork download — sibling of s3-service.js (which stays upload-only).
 * Downloads files listed in `job.artwork_files[]` via stable public URLs
 * served by OrderHub. The on-disk layout matches today's FTP-produced
 * layout byte-for-byte (files land flat in the job folder), so existing
 * pipelines (sidecarManager, working/, recrops/, sendReprint, AI scoring)
 * work unchanged.
 *
 * Design notes:
 *   - Native https/http (no AWS SDK, no external HTTP libs) — matches
 *     project style; see presign-service.js for the request shape this
 *     mirrors (timeout 15s, `req.on('error')`/`req.on('timeout')` shape).
 *     Adds a small (max 3-hop) redirect follower so a CDN-fronted URL
 *     doesn't fail outright; presign-service.js doesn't need this because
 *     its endpoint never redirects.
 *   - Streams to a `*.tmp` file, fsyncs, then renames into place so a
 *     partial download never gets picked up by anything that scans the
 *     job folder. Orphan `*.tmp` files left behind by a process-kill or
 *     network-drop are swept at the start of the next downloadJobArtwork().
 *   - Idempotent: dedup on `artwork_files[].id` via the sidecar's
 *     job-level `s3ArtworkFileIdsKnown` array. Safety net: if a disk
 *     file exists for an id that isn't yet in known, treat as already
 *     downloaded and self-heal the sidecar (registers the id + appends
 *     an image entry without re-downloading).
 *   - Bounded concurrency: max 4 parallel downloads PER JOB. Caller
 *     serialises across jobs (the polling loop).
 *   - Logs by `file.id`, NEVER logs `file_url` — the URLs grant read
 *     access until manually rotated and are treated as sensitive.
 *
 * Public surface (returned from the factory):
 *
 *   async downloadJobArtwork(job, downloadDirectory) → {
 *     downloaded: [{ id, fileName, diskName, artworkType, source, productionReady }],
 *     skipped:    [{ id, fileName, reason }],
 *     failed:     [{ id, fileName, error }],
 *   }
 *
 * Never throws — failures land in `failed[]`.
 */

const httpsLib   = require('https');
const httpLib    = require('http');
const fsPromises = require('fs/promises');
const fssync     = require('fs');
const path       = require('path');
const { URL }    = require('url');

const { saveSidecar: defaultSaveSidecar } = require('../jobs/sidecarManager');
const { createImageEntry, createSidecar } = require('../../shared/jobSchema');
// loadSidecar is deliberately NOT used here — see "Read the sidecar directly"
// note inside downloadJobArtwork for the markReceived-bait bug it would cause.

// Logger is lazy-required because services/logger.js depends on `electron`
// at module load (app.getPath('userData') for the logs dir). That breaks
// plain `node --test` runs where Electron isn't present. Tests inject
// `deps.logger`; production code triggers the real require on first factory
// invocation, by which time Electron's `app` is initialised.
let _defaultLogger = null;
function _getDefaultLogger() {
  if (_defaultLogger) return _defaultLogger;
  // eslint-disable-next-line global-require
  _defaultLogger = require('./logger');
  return _defaultLogger;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PARALLEL_DOWNLOADS_PER_JOB = 4;
const REQUEST_TIMEOUT_MS = 15000;     // matches presign-service.js
const MAX_REDIRECTS      = 3;

// M4 (2026-05-25): artwork_type === 'original' files land in a sub-folder
// instead of the flat job folder. This is the same path Pixfizz Customer
// Originals Phase 1+2 reads via the manifest's `originalFilename` field
// (e.g. "PXDEMO-XYZ_123/original-files/1-IMG.jpg"), so once the
// downloader back-fills the sibling sidecar entry's lowercase-N
// `originalFilename`, the existing Customer Originals UI lights up for
// S3-delivered manual jobs with zero renderer changes.
const ORIGINAL_FILES_SUBDIR = 'original-files';

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the downloader. Deps are injectable so tests can stub the HTTP layer
 * and the sidecar I/O without touching real network. Production callers use
 * the no-arg form.
 *
 * @param {object} [deps]
 * @param {object} [deps.https]        — node:https-compatible (default real)
 * @param {object} [deps.http]         — node:http-compatible  (default real)
 * @param {object} [deps.fs]           — fs/promises-compatible
 * @param {object} [deps.fsSync]       — node:fs (only `createWriteStream` used)
 * @param {Function} [deps.saveSidecar]
 * @param {object} [deps.logger]       — winston-like { info, warn, logError, logWarning }
 * @returns {{ downloadJobArtwork: Function }}
 */
function createS3ArtworkDownloader(deps = {}) {
  const https      = deps.https      || httpsLib;
  const http       = deps.http       || httpLib;
  const fs         = deps.fs         || fsPromises;
  const fsSync     = deps.fsSync     || fssync;
  const saveSidecar = deps.saveSidecar || defaultSaveSidecar;
  const log        = deps.logger     || _getDefaultLogger();

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function _exists(p) {
    try { await fs.access(p); return true; }
    catch { return false; }
  }

  /**
   * Unlink any *.tmp files in the job folder — defensive against a previous
   * process-kill or network-drop leaving partial writes behind. Idempotent;
   * errors per-file are logged but non-fatal.
   */
  async function _cleanOrphanTmps(jobPath) {
    let entries;
    try {
      entries = await fs.readdir(jobPath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith('.tmp')) continue;
      try {
        await fs.unlink(path.join(jobPath, name));
        log.info?.('[s3-artwork] cleaned orphan tmp', { jobPath, name });
      } catch (err) {
        log.logWarning?.('[s3-artwork] failed to clean orphan tmp', { jobPath, name, error: err.message });
      }
    }
  }

  /**
   * Compute the on-disk name for an artwork file. Defaults to `file_name`;
   * collision-renames to `${stem}__${id.slice(0,8)}.${ext}` when a DIFFERENT
   * id already owns that disk name in this job folder. Same id owning the
   * name → returns it unchanged (idempotent re-poll).
   */
  function _resolveDiskName(file, takenByOther) {
    const base  = file.file_name;
    const owner = takenByOther.get(base);
    if (!owner || owner === file.id) return base;
    const ext  = path.extname(base);
    const stem = path.basename(base, ext);
    return `${stem}__${file.id.slice(0, 8)}${ext}`;
  }

  /**
   * HTTPS/HTTP GET, streaming the response body to `destPath` (expected to
   * be a `.tmp` path). Follows up to MAX_REDIRECTS 3xx redirects. Rejects
   * on non-2xx final status, request timeout, or socket error. The `.tmp`
   * file is best-effort-unlinked on failure so a partial write never
   * lingers (a process-kill at the wrong moment may still leave one, which
   * the next call's _cleanOrphanTmps sweeps).
   */
  function _downloadToTmp(url, destPath, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
      let urlObj;
      try {
        urlObj = new URL(url);
      } catch (err) {
        return reject(new Error(`Invalid file_url: ${err.message}`));
      }
      const protocol = urlObj.protocol === 'https:' ? https : http;

      const opts = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = protocol.request(opts, (res) => {
        // Redirect — follow up to MAX_REDIRECTS hops. presign-service.js
        // doesn't do this because its endpoint never redirects; artwork
        // URLs may go through a CDN that does.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            return reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
          }
          const nextUrl = new URL(res.headers.location, urlObj).toString();
          res.resume();
          return resolve(_downloadToTmp(nextUrl, destPath, redirectsLeft - 1));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.code = `HTTP_${res.statusCode}`;
          err.statusCode = res.statusCode;

          // 4xx — capture the response body (truncated to ~500 bytes) so the
          // caller can surface the underlying diagnostic. S3 and Supabase
          // return XML / JSON error envelopes — AccessDenied, RequestExpired,
          // signature mismatches — that are essential for diagnosing auth /
          // URL problems. Without an explicit read, res.resume() drains
          // those bytes and we're left with just "HTTP 403" in the log.
          //
          // Cap at ~500 bytes so a hostile or accidentally-huge body cannot
          // flood the log. Chunks beyond the cap are discarded; we never
          // store more than the cap in memory at any point.
          //
          // 5xx + other non-2xx are intentionally drained without capture —
          // less actionable bodies (proxy error HTML, etc.), and avoiding a
          // wider capture surface keeps log noise predictable.
          if (res.statusCode >= 400 && res.statusCode < 500) {
            let body = '';
            const MAX_BODY_BYTES = 500;
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              if (body.length >= MAX_BODY_BYTES) return;
              body += chunk;
              if (body.length > MAX_BODY_BYTES) body = body.slice(0, MAX_BODY_BYTES);
            });
            res.on('end',   () => { err.bodyPreview = body; reject(err); });
            res.on('error', () => { err.bodyPreview = body; reject(err); }); // partial-but-useful
            return;
          }

          res.resume();
          return reject(err);
        }

        // Stream to .tmp file.
        let bytes = 0;
        const write = fsSync.createWriteStream(destPath);
        res.on('data', (chunk) => { bytes += chunk.length; });
        res.pipe(write);

        const onFailure = (err) => {
          try { res.destroy(); } catch (_) { /* noop */ }
          try { write.destroy(); } catch (_) { /* noop */ }
          fs.unlink(destPath).catch(() => { /* best-effort */ });
          reject(err);
        };

        write.on('error', onFailure);
        res.on('error',   onFailure);
        // 'aborted' fires when the server destroys the socket mid-stream.
        // Without an explicit handler the pipe may emit 'finish' on the
        // partial bytes — guard against that by failing here.
        res.on('aborted', () => onFailure(new Error('Response aborted by server')));

        write.on('finish', () => {
          // fsync the underlying fd before resolving. createWriteStream
          // emits 'finish' once buffers are flushed at the JS layer, not
          // necessarily fsync'd to disk. Re-open for sync since we don't
          // have direct access to the writeStream's fd.
          (async () => {
            try {
              const fh = await fs.open(destPath, 'r+');
              try { await fh.sync(); } catch (_) { /* fsync unsupported on some FS — non-fatal */ }
              await fh.close();
            } catch (_) {
              // sync failed but bytes are on disk; don't fail the download.
            }
            resolve({ bytes });
          })();
        });
      });

      req.on('error', (err) => {
        fs.unlink(destPath).catch(() => {});
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        fs.unlink(destPath).catch(() => {});
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Run `worker` over each of `items` with at most `concurrency` in flight.
   * Awaits all of them. `worker` is responsible for catching its own errors
   * — this helper does not rethrow.
   */
  async function _runWithConcurrency(items, concurrency, worker) {
    let next = 0;
    async function runOne() {
      while (next < items.length) {
        const i = next++;
        await worker(items[i], i);
      }
    }
    const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
    await Promise.all(pool);
  }

  /**
   * Upsert the order-level manifest at `{orderFolderPath}/{order_number}.json`.
   *
   * Pixfizz Core ships this file via FTP alongside the JPEGs; the print-
   * service dispatch pipeline (`_readManifest` → `_findJobInManifest` in
   * print-service.js) reads it to discover which image files belong to which
   * job. S3-delivered jobs don't get a manifest from OrderHub, so we
   * construct one here from the sidecar entries — without it, the dispatch
   * loop throws "Order manifest not found" and held-for-review release /
   * folder_copy auto-print both fail.
   *
   * Shape is byte-shape parity with FTP-delivered manifests (see
   * s3-artwork-downloader.test.js byte-shape parity test). Top-level keys:
   * orderId, orderNumber, jobs. Per-image keys: filename, originalFilename,
   * size, quantity.
   *
   * `size` is intentionally null today — OrderHub's /pending-jobs doesn't
   * expose a print-size string and the project chose NOT to derive it from
   * product_code or job.options. folder_copy controllers ignore size and
   * dispatch cleanly; DPOF / Darkroom Pro routes will throw "size is
   * missing on one or more images" (print-service.js:242) until OrderHub
   * adds a print_size field to the API.
   *
   * Idempotent. Multi-job orders share the manifest — a subsequent call
   * for a different jobId in the same order appends/updates that job's
   * entry without touching siblings. Atomic write via .tmp + rename so a
   * crash mid-write cannot corrupt the manifest readers see.
   */
  async function _upsertOrderManifest(job, downloadDirectory, sidecarImages) {
    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const orderFolderPath = path.join(downloadDirectory, orderFolderName);
    const manifestPath    = path.join(orderFolderPath, `${job.order_number}.json`);
    const tmpPath         = manifestPath + '.tmp';

    // Read existing manifest if present; start fresh on ENOENT / parse error.
    // Treat parse error as corruption — log + replace rather than silently
    // failing the dispatch on the next poll.
    let manifest = null;
    let manifestPreExisted = false;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) {
        manifest = parsed;
        manifestPreExisted = true;
      } else {
        log.logWarning?.('[s3-artwork] order manifest malformed shape — replacing', { manifestPath, jobId: job.id });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.logWarning?.('[s3-artwork] could not read existing order manifest — replacing', {
          manifestPath, jobId: job.id, error: err.message,
        });
      }
    }
    if (!manifest) {
      manifest = {
        orderId:     job.order_id,
        orderNumber: job.order_number,
        jobs:        [],
      };
    }

    // Build this job's manifest entry from the sidecar's images[] — sidecar
    // is the source of truth for what's actually on disk.
    const jobEntry = {
      jobId: String(job.id),
      images: sidecarImages.map((img) => ({
        filename:         `${jobFolderName}/${img.filename}`,
        originalFilename: img.originalFilename || null,
        size:             null, // see header comment — pending OrderHub print_size
        quantity:         Number.isFinite(img.qtyOriginal) ? img.qtyOriginal : 1,
      })),
    };

    // Replace or append by jobId — multi-job orders preserve sibling entries.
    //
    // FTP-shape detection (2026-05-24, Fix 2): when an existing manifest
    // already holds an entry for this jobId, decide whether to overwrite
    // by sniffing the existing entry's shape. FTP-delivered manifests
    // populate per-image `size` (e.g. "4x6"); S3-channel writes leave it
    // null pending OrderHub's print_size field. If we see ANY existing
    // image with non-null `size`, treat the entry as FTP-authoritative and
    // skip the write entirely — our reconstruction would downgrade `size`
    // to null and (worse) scope `images[]` to whatever the S3 sidecar saw,
    // wiping the FTP-delivered page list. Without this guard, a Pixfizz
    // job that also has `artwork_files[]` populated (e.g. book thumbnails)
    // would have its 40-image manifest entry replaced with a single-thumb
    // entry on first poll after restart — destroying dispatch.
    //
    // The "non-null size" heuristic relies on S3-channel entries staying
    // null in that slot. IF OrderHub later adds a print_size field and
    // our entries gain populated sizes, the heuristic mis-classifies our
    // own re-writes as FTP and we'll never refresh after the first write.
    // At that point switch to either a `__writer: 'ohd-s3-downloader'`
    // marker (would break the byte-shape parity test that asserts FTP-
    // identical keys — adjust both sides) or a merge-by-image strategy.
    const idx = manifest.jobs.findIndex((j) => j && String(j.jobId) === String(job.id));
    if (idx >= 0 && manifestPreExisted) {
      const existing = manifest.jobs[idx];
      const isFTPShape = existing
        && Array.isArray(existing.images)
        && existing.images.some((img) => img && img.size != null);
      if (isFTPShape) {
        log.info?.('[s3-artwork] order manifest entry is FTP-shape — preserving', {
          manifestPath, jobId: job.id, existingImageCount: existing.images.length,
        });
        return;
      }
      // OHD-written entry (size all null) — fall through and update normally.
      manifest.jobs[idx] = jobEntry;
    } else if (idx >= 0) {
      // Fresh manifest we just built — shouldn't have a matching entry,
      // but defensive: replace.
      manifest.jobs[idx] = jobEntry;
    } else {
      manifest.jobs.push(jobEntry);
    }

    const serialised = JSON.stringify(manifest, null, 2);
    try {
      await fs.writeFile(tmpPath, serialised, 'utf8');
      await fs.rename(tmpPath, manifestPath);
      log.info?.('[s3-artwork] order manifest written', {
        manifestPath, jobId: job.id, jobCount: manifest.jobs.length, imageCount: jobEntry.images.length,
      });
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      log.logError?.('[s3-artwork] failed to write order manifest', err, { manifestPath, jobId: job.id });
    }
  }

  /**
   * Build a fresh sidecar image entry for an S3-delivered file.
   *
   * M3 qty fix (2026-05-25): `qtyOriginal = file.copies` (default 1 when
   * missing/zero/NaN). The original Lovable spec said
   * `job.quantity × file.copies`; live testing against POS-539M6D
   * (job.quantity=5; three files with copies 1+1+3 summing to 5) showed
   * the spec was empirically wrong — multiplying inflated qtyOriginal
   * 5× across the order (25 instead of 5). In practice `file.copies` IS
   * the per-file print count for the whole order; `job.quantity` is the
   * EXPECTED total (the sum of copies should match it) and is
   * informational only — NOT a multiplier. The `job` parameter is kept
   * in the signature for future product types that may need it.
   *
   * Called ONLY when a file's id is not in `s3ArtworkFileIdsKnown` (i.e.
   * first import) — the diff in `downloadJobArtwork` skips known ids
   * before reaching here, so existing sidecar entries are never
   * recomputed. See the no-migration guard test for the contract lock
   * that protects POS-EFZ9UK / PXDEMO-AUXZWJ / etc. from silent rewrite.
   * Entries written under the buggy formula stay on disk with their
   * inflated qtyOriginal until operator action (manual sidecar edit, or
   * dismiss-and-re-flow).
   *
   * `originalFileName` (camelCase, capital F-N) is the API's `file_name`,
   * preserved so the renderer can show the original upload name when our
   * on-disk name was collision-renamed. DISTINCT from `originalFilename`
   * (lowercase n), which is the manifest-relative path to the customer's
   * pre-crop upload (Customer Originals subsystem) — unrelated, stays null
   * for S3-delivered entries.
   */
  function _buildImageEntry(file, diskName, job) { // eslint-disable-line no-unused-vars
    // qtyOriginal = file.copies. Lovable's `job.quantity × file.copies`
    // spec was empirically wrong (POS-539M6D, 2026-05-25): live data
    // shows quantity is the expected-total informational value, not a
    // multiplier. Sum of copies SHOULD equal quantity but enforce only
    // loosely (no assertion) — bad upstream data shouldn't block ingest.
    const copies = Number.isFinite(file.copies) && file.copies > 0 ? file.copies : 1;
    const qty    = copies;
    return createImageEntry(diskName, qty, null, {
      artworkFileId:    file.id,
      artworkSource:    file.source       || null,
      artworkType:      file.artwork_type || null,
      productionReady:  file.production_ready !== false, // default true when absent
      originalFileName: file.file_name,
      copies,
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async function downloadJobArtwork(job, downloadDirectory) {
    const result = { downloaded: [], skipped: [], failed: [] };

    if (!job || !Array.isArray(job.artwork_files) || job.artwork_files.length === 0) {
      return result; // no-op: nothing to fetch
    }

    // Defensive: OrderHub filters artwork_source:'none' server-side per the
    // brief. Log loudly if it ever surfaces here so the contract drift is
    // visible — but proceed (the downloader just iterates artwork_files[],
    // which would be empty for a 'none' job anyway).
    if (job.artwork_source === 'none') {
      log.logWarning?.('[s3-artwork] artwork_source "none" reached OHD — OrderHub should filter these server-side', {
        jobId: job.id,
      });
    }

    if (!downloadDirectory) {
      log.logError?.('[s3-artwork] no downloadDirectory configured — cannot download', null, { jobId: job.id });
      for (const file of job.artwork_files) {
        result.failed.push({ id: file.id, fileName: file.file_name, error: 'No downloadDirectory configured' });
      }
      return result;
    }

    // Job folder shape matches checkLocalFiles's expectation
    // (job-download-service.js:38-40) — byte-identical to FTP layout.
    const orderFolderName = `${job.order_number}_${job.order_id}`;
    const jobFolderName   = `${job.order_number}_${job.id}`;
    const jobPath = path.join(downloadDirectory, orderFolderName, jobFolderName);
    try {
      await fs.mkdir(jobPath, { recursive: true });
    } catch (err) {
      log.logError?.('[s3-artwork] failed to create job folder', err, { jobId: job.id, jobPath });
      for (const file of job.artwork_files) {
        result.failed.push({ id: file.id, fileName: file.file_name, error: `mkdir failed: ${err.message}` });
      }
      return result;
    }

    // Sweep orphan .tmp files from any previous interrupted run. Original-
    // files subfolder is swept too — it's lazy-created on first need so
    // _cleanOrphanTmps' ENOENT-tolerance handles the not-yet-existing case.
    await _cleanOrphanTmps(jobPath);
    await _cleanOrphanTmps(path.join(jobPath, ORIGINAL_FILES_SUBDIR));

    // Sidecar filename follows the codebase-wide convention
    // `{order_number}_{job_id}.json` — same as the inner job folder name.
    // Confirmed against FTP-delivered (Pixfizz) sidecars (e.g.
    // PXDEMO-VRGAMF_38439878.json) and historical POS sidecars (e.g.
    // POS-79GTFJ_c3852f28-….json); ipc-handlers (Job Review load, reprint,
    // crop) all call loadSidecar with this id form. M1's first pass passed
    // `job.id` alone, producing a parallel `{job.id}.json` filename and a
    // dual-sidecar bug — surfaced by POS-5MAMUF-1 manual testing 2026-05-24.
    const sidecarJobId    = `${job.order_number}_${job.id}`;
    const sidecarFilePath = path.join(jobPath, `${sidecarJobId}.json`);

    // Read the sidecar DIRECTLY — do NOT call loadSidecar. loadSidecar auto-
    // creates + saves a fresh empty sidecar when the file is missing, which
    // lands a `.json` in the job folder BEFORE any artwork is written. The
    // polling loop's checkLocalFiles uses _countFiles which counts every
    // file recursively (including .json), so the lone empty sidecar
    // materialises as `fileCount: 1` → premature `markReceived` even when
    // zero artwork landed. Build the sidecar IN MEMORY; the tail-end
    // saveSidecar (gated on at least one downloaded entry or known-id
    // change) is the first time it hits disk.
    let sidecar;
    try {
      const raw = await fs.readFile(sidecarFilePath, 'utf8');
      sidecar = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.logError?.('[s3-artwork] failed to read sidecar', err, { jobId: job.id, sidecarFilePath });
        for (const file of job.artwork_files) {
          result.failed.push({ id: file.id, fileName: file.file_name, error: `sidecar read failed: ${err.message}` });
        }
        return result;
      }
      // ENOENT → fresh in-memory sidecar; not persisted until a download
      // succeeds. createSidecar already seeds s3ArtworkFileIdsKnown:[].
      sidecar = createSidecar(sidecarJobId);
    }

    // Hydrate the job-level id set on legacy sidecars that pre-date the
    // M1 schema bump. sidecarManager.loadSidecar does the same on behalf
    // of other consumers; this is the read-direct equivalent.
    if (!Array.isArray(sidecar.s3ArtworkFileIdsKnown)) {
      sidecar = { ...sidecar, s3ArtworkFileIdsKnown: [] };
    }
    const knownIds = new Set(sidecar.s3ArtworkFileIdsKnown);

    // Build the disk-name → owning artworkFileId map from existing sidecar
    // entries so the collision rule sees other S3-delivered files in this job.
    const takenByOther = new Map();
    for (const img of sidecar.images) {
      if (img && img.filename && img.artworkFileId) {
        takenByOther.set(img.filename, img.artworkFileId);
      }
    }

    const newImageEntries = [];
    const downloadsToRun  = [];
    // M4: originals that landed (either fresh-downloaded or self-healed
    // from disk) so the back-fill pass below can match them against a
    // single non-original sibling sidecar entry.
    const originalsToBackfill = [];

    for (const file of job.artwork_files) {
      // M4 (2026-05-25): only the literal string 'original' routes to the
      // sub-folder. Per the brief, unknown artwork_types ('pages', 'text',
      // …) are NOT treated as originals — they continue to land flat.
      // (The non-manual source filter below excludes the Pixfizz reference
      // entries that carry those types in practice.)
      const isOriginal = file.artwork_type === 'original';
      const targetDir  = isOriginal ? path.join(jobPath, ORIGINAL_FILES_SUBDIR) : jobPath;
      // Originals don't use the flat-folder takenByOther collision map —
      // they live in their own subfolder and have no sidecar.images[]
      // entries to record ownership. In the rare two-different-originals-
      // sharing-file_name case the second one overwrites the first
      // (silent degrade — back-fill heuristic still works for the
      // surviving disk file).
      const diskName = isOriginal ? file.file_name : _resolveDiskName(file, takenByOther);
      const diskPath = path.join(targetDir, diskName);

      // Source-based filter (2026-05-24): the S3 channel is for
      // operator-uploaded manual artwork only. For Pixfizz orders the
      // real print artwork arrives via FTP; anything that shows up in
      // `artwork_files[]` with `source !== 'manual'` is reference /
      // preview material — book-thumbnails on photo books, low-res
      // mirrors, etc. — that we should NOT download.
      //
      // Third manifestation of the same source-based gating pattern:
      //   1. M2 hold-rule narrowing — production_ready: false on
      //      Pixfizz-source files is the API's default state, not a
      //      meaningful hold reason. Hold fires on manual source only.
      //   2. M3 chip narrowing — same logic: the "Not finalised" chip
      //      only fires when artworkSource === 'manual'.
      //   3. This — the downloader follows the same rule. The three
      //      surfaces (hold gate, display chip, ingest) now agree:
      //      production_ready and pixfizz-source are not operator-
      //      actionable on the S3 channel.
      //
      // Placed BEFORE the knownIds / on-disk-already checks so non-
      // manual files always log the same `non-manual-source` reason
      // regardless of whether they've been seen before — clean audit.
      // EXISTING sidecar entries for non-manual files (created before
      // this filter shipped, e.g. PXDEMO-YUED5N's book-thumbnails) are
      // not auto-cleaned; operators dismiss + re-flow the order or
      // edit the sidecar by hand (see CHANGELOG).
      if (file.source !== 'manual') {
        log.info?.('[s3-artwork] skipped non-manual file', {
          jobId: job.id,
          fileId: file.id,
          fileName: file.file_name,
          source: file.source || null,
          artworkType: file.artwork_type || null,
        });
        result.skipped.push({
          id: file.id,
          fileName: file.file_name,
          reason: 'non-manual-source',
        });
        continue;
      }

      if (knownIds.has(file.id)) {
        result.skipped.push({ id: file.id, fileName: file.file_name, reason: 'already-known' });
        continue;
      }

      if (await _exists(diskPath)) {
        // Safety-net idempotency: file is on disk but sidecar didn't know
        // (typically because a previous run's rename succeeded but
        // saveSidecar didn't). Self-heal without re-downloading.
        result.skipped.push({ id: file.id, fileName: file.file_name, reason: 'on-disk-already' });
        knownIds.add(file.id);
        if (isOriginal) {
          // No sidecar.images[] entry for originals — only the back-fill
          // updates an existing sibling. Re-attempt the back-fill in case
          // the prior run failed between rename and saveSidecar.
          originalsToBackfill.push({ file, diskName });
        } else {
          newImageEntries.push(_buildImageEntry(file, diskName, job));
          takenByOther.set(diskName, file.id);
        }
        continue;
      }

      if (!isOriginal && diskName !== file.file_name) {
        log.logWarning?.('[s3-artwork] collision-renamed', {
          jobId: job.id, fileId: file.id, originalName: file.file_name, diskName,
        });
      }

      downloadsToRun.push({ file, diskName, diskPath, isOriginal, targetDir });
      // Reserve the name so subsequent files in the same job don't grab it.
      // Originals share their own subfolder + no sidecar tracking — no
      // reservation needed.
      if (!isOriginal) takenByOther.set(diskName, file.id);
    }

    // M4: lazy-create the original-files/ subfolder when any original is
    // about to be written there. Skipping the mkdir when no original is in
    // play keeps manual jobs that only ship optimized/manipulated files
    // from cluttering disk with an empty subfolder.
    const willWriteOriginals = downloadsToRun.some((d) => d.isOriginal);
    if (willWriteOriginals) {
      try {
        await fs.mkdir(path.join(jobPath, ORIGINAL_FILES_SUBDIR), { recursive: true });
      } catch (err) {
        log.logError?.('[s3-artwork] failed to create original-files subfolder', err, {
          jobId: job.id, jobPath,
        });
        for (const item of downloadsToRun.filter((d) => d.isOriginal)) {
          result.failed.push({
            id: item.file.id,
            fileName: item.file.file_name,
            error: `mkdir original-files failed: ${err.message}`,
          });
        }
        // Drop originals from the run list — they cannot be written.
        for (let i = downloadsToRun.length - 1; i >= 0; i--) {
          if (downloadsToRun[i].isOriginal) downloadsToRun.splice(i, 1);
        }
      }
    }

    // Track which downloads completed so we can append their sidecar entries
    // and id-known marks after the whole batch settles.
    const completed = [];

    await _runWithConcurrency(downloadsToRun, PARALLEL_DOWNLOADS_PER_JOB, async (item) => {
      const { file, diskName, diskPath, isOriginal } = item;
      const tmpPath   = diskPath + '.tmp';
      const startedAt = Date.now();

      log.info?.('[s3-artwork] download start', {
        jobId: job.id, fileId: file.id, fileName: file.file_name,
        artworkType: file.artwork_type, source: file.source,
      });

      try {
        const { bytes } = await _downloadToTmp(file.file_url, tmpPath);
        // Atomic rename. If a crash happens between this rename and the
        // sidecar save, the next poll's self-heal branch (on-disk-already)
        // reconciles.
        await fs.rename(tmpPath, diskPath);

        const durationMs = Date.now() - startedAt;
        log.info?.('[s3-artwork] download success', {
          jobId: job.id, fileId: file.id, diskName, sizeBytes: bytes, durationMs,
          isOriginal: !!isOriginal,
        });

        result.downloaded.push({
          id: file.id,
          fileName: file.file_name,
          diskName,
          artworkType: file.artwork_type || null,
          source: file.source || null,
          productionReady: file.production_ready !== false,
        });
        completed.push({ file, diskName, isOriginal: !!isOriginal });
      } catch (err) {
        // Best-effort .tmp cleanup; _downloadToTmp usually already removed it.
        await fs.unlink(tmpPath).catch(() => {});
        log.logError?.('[s3-artwork] download failed', err, {
          jobId: job.id, fileId: file.id, errorCode: err.code || null,
        });
        // 4xx response bodies (S3/Supabase XML or JSON error envelopes —
        // AccessDenied, RequestExpired, signature mismatches) carry the
        // actionable diagnostic. Surface as a separate WARN line so log
        // analysis can grep `[s3-artwork] 4xx response body` cleanly. By
        // id only, never the URL (URLs grant read access until rotated).
        if (err.bodyPreview) {
          log.logWarning?.('[s3-artwork] 4xx response body', {
            jobId: job.id,
            fileId: file.id,
            statusCode: err.statusCode || null,
            bodyPreview: err.bodyPreview,
          });
        }
        result.failed.push({
          id: file.id,
          fileName: file.file_name,
          error: err.message || String(err),
        });
      }
    });

    // Materialise sidecar entries for successful downloads. Originals are
    // intentionally NOT added to images[] — Customer Originals references
    // them only via the lowercase-N `originalFilename` on a sibling entry,
    // matching the Pixfizz FTP convention so `_scanJobImages`, AI scoring,
    // and the print dispatcher all stay scoped to printable JPEGs.
    for (const { file, diskName, isOriginal } of completed) {
      knownIds.add(file.id);
      if (isOriginal) {
        originalsToBackfill.push({ file, diskName });
      } else {
        newImageEntries.push(_buildImageEntry(file, diskName, job));
      }
    }

    // ── M4 back-fill: link each completed original to a single sibling ──
    //
    // For every original that landed this poll (fresh-downloaded OR self-
    // healed from disk), find a non-original sibling sidecar entry whose
    // API `originalFileName` (capital F-N) matches the original's
    // `file.file_name` AND whose lowercase-N `originalFilename` is still
    // empty. Strict single-match contract: 0 or 2+ candidates → silent
    // degrade (Customer Originals UI doesn't activate for that file).
    //
    // CASING TRAP: matching on `originalFileName` (capital N — the API's
    // `file_name`); back-filling into `originalFilename` (lowercase n —
    // the manifest-relative path consumed by Customer Originals Phase
    // 1+2). They are unrelated fields that happen to differ only in
    // capitalisation. project_ohd_customer_originals_phase1 / _s3_artwork_
    // channel memory entries document the distinction.
    //
    // Candidate pool: existing sidecar.images + newImageEntries built
    // this poll. Existing entries with originalFilename already set
    // (from a prior back-fill or an FTP manifest's first load) are
    // excluded — never clobber first-write, matching reconcile B in
    // sidecarManager.js. Once-per-poll claim: a sibling that's been
    // claimed by one original this poll is excluded from subsequent
    // candidate lists so two originals with identical file_name can't
    // each fight over the same sibling.
    const backfillByEntry = new Map();
    for (const { file, diskName } of originalsToBackfill) {
      const candidates = [...sidecar.images, ...newImageEntries].filter((e) =>
        e
        && e.originalFileName === file.file_name
        && e.artworkType !== 'original'
        && !e.originalFilename
        && !backfillByEntry.has(e)
      );
      if (candidates.length === 1) {
        // Manifest-relative path verbatim — Customer Originals consumes
        // it as `path.join(path.dirname(jobPath), entry.originalFilename)`.
        // Do not bake the literal "original-files" string into anything
        // that reads it (the resolver is folder-agnostic by design).
        const relPath = `${jobFolderName}/${ORIGINAL_FILES_SUBDIR}/${diskName}`;
        backfillByEntry.set(candidates[0], relPath);
        log.info?.('[s3-artwork] original back-fill', {
          jobId: job.id,
          originalFileId: file.id,
          siblingFileId: candidates[0].artworkFileId || null,
          siblingDiskName: candidates[0].filename,
          originalFilename: relPath,
        });
      } else {
        log.info?.('[s3-artwork] original back-fill skipped (no unique sibling)', {
          jobId: job.id,
          originalFileId: file.id,
          originalFileName: file.file_name,
          candidateCount: candidates.length,
        });
      }
    }
    const applyBackfill = (entries) => entries.map((e) =>
      backfillByEntry.has(e) ? { ...e, originalFilename: backfillByEntry.get(e) } : e
    );

    // Persist sidecar (single write per job). Skip the write when nothing
    // changed (all-skipped + nothing-new + no back-fill) so modifiedAt
    // stays stable on pure re-poll.
    const knownIdsChanged   = knownIds.size !== sidecar.s3ArtworkFileIdsKnown.length;
    const backfillApplied   = backfillByEntry.size > 0;
    if (newImageEntries.length > 0 || knownIdsChanged || backfillApplied) {
      // Reassign so the manifest write below sees the merged image list
      // even if saveSidecar throws — in-memory truth is what the manifest
      // records; disk catches up on the next poll's self-heal.
      sidecar = {
        ...sidecar,
        images: [
          ...applyBackfill(sidecar.images),
          ...applyBackfill(newImageEntries),
        ],
        s3ArtworkFileIdsKnown: Array.from(knownIds),
      };
      try {
        await saveSidecar(sidecar, jobPath);
      } catch (err) {
        log.logError?.('[s3-artwork] saveSidecar failed', err, { jobId: job.id });
        // Files are on disk regardless; checkLocalFiles will still fire
        // markReceived. The next poll's load+self-heal path reconciles.
      }
    }

    // Order-level manifest (M2.1 fix, 2026-05-24). Always run when the
    // sidecar has at least one image — so existing buggy-M1 job folders
    // (sidecar correct, manifest missing) self-heal on the next poll
    // without operator intervention. `_upsertOrderManifest` is idempotent
    // and preserves sibling job entries (multi-job orders share one file).
    // Skipped when sidecar.images is empty so we don't write a manifest
    // entry with zero images that would mislead the dispatch pipeline
    // into a no-op "successful" print.
    if (Array.isArray(sidecar.images) && sidecar.images.length > 0) {
      try {
        await _upsertOrderManifest(job, downloadDirectory, sidecar.images);
      } catch (err) {
        log.logError?.('[s3-artwork] upsertOrderManifest threw', err, { jobId: job.id });
        // Non-fatal — files + sidecar are intact, next poll retries the
        // manifest write.
      }
    }

    return result;
  }

  return { downloadJobArtwork };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { createS3ArtworkDownloader };
