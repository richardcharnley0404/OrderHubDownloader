#!/usr/bin/env node
'use strict';

/**
 * scripts/rebuild-missing-manifests.js
 *
 * One-shot recovery for jobs delivered via the M1 S3 artwork channel
 * BEFORE the manifest-upsert fix (2026-05-24) landed.
 *
 * Pixfizz Core ships an order-level manifest (`{order_number}.json`) at
 * the order-folder root, sibling to the job subfolders. The print-service
 * dispatch pipeline (`_readManifest` → `_findJobInManifest`) reads it to
 * discover which image files belong to which job. The S3 channel never
 * produced one until late M2; this script walks the download directory
 * and writes the manifest for any order folder where:
 *
 *   - `{order_number}.json` is missing at the order-folder root, AND
 *   - at least one inner `{order_number}_{jobId}/` job subfolder has a
 *     readable sidecar with non-empty `images[]`.
 *
 * Idempotent — already-present manifests are NEVER overwritten (an
 * FTP-delivered manifest in that slot is the source of truth). Malformed
 * existing manifests are logged and skipped for manual operator review.
 *
 * The reconstructed manifest is byte-shape parity with
 * `s3-artwork-downloader.js`'s `_upsertOrderManifest` output (same top-
 * level keys, same per-image keys, `size: null` for the same reason).
 *
 * Usage:
 *   node scripts/rebuild-missing-manifests.js              # writes manifests
 *   node scripts/rebuild-missing-manifests.js --dry-run    # logs only, no writes
 *   node scripts/rebuild-missing-manifests.js --dir <path> # override downloadDirectory
 *
 * Reads `downloadDirectory` from
 *   %APPDATA%/orderhub-downloader/config.json   (Windows)
 *   ~/.config/orderhub-downloader/config.json   (Linux, untested)
 *   ~/Library/Application Support/orderhub-downloader/config.json (macOS, untested)
 * unless `--dir` is supplied.
 *
 * Exit codes:
 *   0  success (zero or more manifests written)
 *   2  could not resolve downloadDirectory or it isn't readable
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DRY_RUN     = process.argv.includes('--dry-run');
const DIR_FLAG_IX = process.argv.indexOf('--dir');
const DIR_OVERRIDE = DIR_FLAG_IX >= 0 ? process.argv[DIR_FLAG_IX + 1] : null;

// ── Config resolution ───────────────────────────────────────────────────────

function defaultConfigPath() {
  // Match electron-store's path layout: app.getPath('userData')/config.json.
  // The platform-specific roots below mirror what Electron uses for the
  // `userData` directory by default.
  switch (process.platform) {
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Roaming', 'orderhub-downloader', 'config.json');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'orderhub-downloader', 'config.json');
    default:
      return path.join(os.homedir(), '.config', 'orderhub-downloader', 'config.json');
  }
}

function resolveDownloadDirectory() {
  if (DIR_OVERRIDE) return DIR_OVERRIDE;
  const cfgPath = defaultConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read config at ${cfgPath}: ${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config at ${cfgPath} is not valid JSON: ${err.message}`);
  }
  if (!cfg.downloadDirectory || typeof cfg.downloadDirectory !== 'string') {
    throw new Error(`config at ${cfgPath} has no downloadDirectory string`);
  }
  return cfg.downloadDirectory;
}

// ── Folder-name parsing ─────────────────────────────────────────────────────

/**
 * Split `{left}_{right}` on the LAST underscore. order_number can contain
 * hyphens; order_id / job_id can be a 16-char hex (Pixfizz) or a full UUID
 * with internal hyphens (POS / OrderHub-direct) — neither contains an
 * underscore in practice, so splitting on the last `_` is reliable.
 */
function splitOnLastUnderscore(name) {
  const i = name.lastIndexOf('_');
  if (i <= 0 || i === name.length - 1) return null;
  return { left: name.slice(0, i), right: name.slice(i + 1) };
}

// ── Per-order reconstruction ────────────────────────────────────────────────

/**
 * Inspect one order folder. Returns one of:
 *   { status: 'write', manifestPath, manifest }
 *   { status: 'already-ok' }                              // manifest present + parses
 *   { status: 'malformed', reason }                       // present but won't parse
 *   { status: 'skip', reason }                            // no jobs / unparsable name / etc
 */
function planManifestForOrder(orderFolderPath, orderFolderName) {
  const parts = splitOnLastUnderscore(orderFolderName);
  if (!parts) return { status: 'skip', reason: 'cannot parse folder name (no underscore)' };
  const orderNumber = parts.left;
  const orderId     = parts.right;

  const manifestPath = path.join(orderFolderPath, `${orderNumber}.json`);
  if (fs.existsSync(manifestPath)) {
    try {
      JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { status: 'already-ok' };
    } catch (err) {
      return { status: 'malformed', reason: err.message };
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(orderFolderPath, { withFileTypes: true });
  } catch (err) {
    return { status: 'skip', reason: `readdir failed: ${err.message}` };
  }

  const jobs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const jobFolderName = ent.name;
    const jobParts = splitOnLastUnderscore(jobFolderName);
    if (!jobParts) continue;
    // The job folder's order-number prefix must match the order folder's.
    if (jobParts.left !== orderNumber) continue;

    const jobId = jobParts.right;
    const sidecarPath = path.join(orderFolderPath, jobFolderName, `${jobFolderName}.json`);
    let sidecar;
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch (_err) {
      // No sidecar / unparsable — skip this job folder rather than block
      // the whole order. (Operator can investigate the orphan separately.)
      continue;
    }
    const images = Array.isArray(sidecar.images) ? sidecar.images : [];
    if (images.length === 0) continue;

    jobs.push({
      jobId: String(jobId),
      images: images.map((img) => ({
        filename:         `${jobFolderName}/${img.filename}`,
        originalFilename: img.originalFilename || null,
        size:             null,
        quantity:         Number.isFinite(img.qtyOriginal) ? img.qtyOriginal : 1,
      })),
    });
  }

  if (jobs.length === 0) {
    return { status: 'skip', reason: 'no readable job sidecars with images in this order folder' };
  }

  return {
    status: 'write',
    manifestPath,
    manifest: { orderId, orderNumber, jobs },
  };
}

// ── Atomic write ────────────────────────────────────────────────────────────

function writeManifestAtomic(manifestPath, manifest) {
  const tmpPath = manifestPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, manifestPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    throw err;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  let downloadDir;
  try {
    downloadDir = resolveDownloadDirectory();
  } catch (err) {
    console.error(`[rebuild-manifests] ${err.message}`);
    process.exit(2);
  }

  let topEntries;
  try {
    topEntries = fs.readdirSync(downloadDir, { withFileTypes: true });
  } catch (err) {
    console.error(`[rebuild-manifests] could not read downloadDirectory ${downloadDir}: ${err.message}`);
    process.exit(2);
  }

  console.log(`[rebuild-manifests] mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`[rebuild-manifests] downloadDirectory: ${downloadDir}`);
  console.log('');

  const counts = {
    scanned:      0,
    written:      0,
    wouldWrite:   0,
    alreadyOk:    0,
    malformed:    0,
    skipped:      0,
    writeFailed:  0,
  };
  const wouldWritePlan = [];

  for (const ent of topEntries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    counts.scanned++;

    const orderFolderPath = path.join(downloadDir, ent.name);
    const plan = planManifestForOrder(orderFolderPath, ent.name);

    switch (plan.status) {
      case 'already-ok':
        counts.alreadyOk++;
        // Quiet — no output for the common no-op case. Tally only.
        break;
      case 'malformed':
        counts.malformed++;
        console.warn(`  ! ${ent.name}  (existing manifest malformed — left in place: ${plan.reason})`);
        break;
      case 'skip':
        counts.skipped++;
        console.log(`  - ${ent.name}  (skip: ${plan.reason})`);
        break;
      case 'write':
        if (DRY_RUN) {
          counts.wouldWrite++;
          wouldWritePlan.push({ name: ent.name, jobs: plan.manifest.jobs.length });
          console.log(`  + ${ent.name}  (would write manifest: ${plan.manifest.jobs.length} job(s))`);
        } else {
          try {
            writeManifestAtomic(plan.manifestPath, plan.manifest);
            counts.written++;
            console.log(`  + ${ent.name}  (manifest written: ${plan.manifest.jobs.length} job(s))`);
          } catch (err) {
            counts.writeFailed++;
            console.error(`  x ${ent.name}  (write failed: ${err.message})`);
          }
        }
        break;
      default:
        // Defensive — should never happen.
        console.warn(`  ? ${ent.name}  (unknown plan status: ${plan.status})`);
    }
  }

  console.log('');
  console.log('[rebuild-manifests] summary');
  console.log(`  scanned          ${counts.scanned}`);
  console.log(`  already ok       ${counts.alreadyOk}`);
  console.log(`  malformed        ${counts.malformed}`);
  console.log(`  skipped          ${counts.skipped}`);
  if (DRY_RUN) {
    console.log(`  would write      ${counts.wouldWrite}`);
  } else {
    console.log(`  written          ${counts.written}`);
    if (counts.writeFailed > 0) console.log(`  write failed     ${counts.writeFailed}`);
  }
}

main();
