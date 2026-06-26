'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve the best on-disk source for a manifest image at dispatch time.
 *
 * A job folder can hold up to three copies of each image: the root
 * (first-arrival from FTP), `/working/` (the edited / printable set used by
 * Manual Crop review), and `/originals/` (the pristine backup). These can drift
 * out of sync — legacy quarantine artifacts, SMB/AV interference, external
 * cleanup — so a dispatch that reads ONLY the root can throw "Image not found"
 * even though the image is present in `/working/` or `/originals/`. This mirrors
 * the three-layer fallback the reprint path (reprintManager) already uses.
 *
 * Order of preference:
 *   1. `enhancedPath` (AI-enhanced output), when provided
 *   2. `rootPath` (the canonical job-root location)
 *   3. `{jobFolderPath}/working/{basename}`
 *   4. `{jobFolderPath}/originals/{basename}`
 *
 * Returns `rootPath` when none exist, so the caller's existence check throws an
 * error that still references the expected root location.
 *
 * @param {object}  args
 * @param {string}  args.rootPath        canonical root path for the image
 * @param {string}  args.jobFolderPath   the job folder (parent of working/originals)
 * @param {string}  args.basename        bare image filename
 * @param {string} [args.enhancedPath]   AI-enhanced output path, if any
 * @returns {string} the resolved source path
 */
function resolveDispatchImageSource({ rootPath, jobFolderPath, basename, enhancedPath }) {
  if (enhancedPath) return enhancedPath;

  const candidates = [
    rootPath,
    jobFolderPath ? path.join(jobFolderPath, 'working', basename) : null,
    jobFolderPath ? path.join(jobFolderPath, 'originals', basename) : null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore and try the next */
    }
  }
  return rootPath;
}

module.exports = { resolveDispatchImageSource };
