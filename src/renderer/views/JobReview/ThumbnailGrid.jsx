import { useRef, useEffect } from 'react';
import { ThumbnailCard } from './ThumbnailCard.jsx';

/**
 * src/renderer/views/JobReview/ThumbnailGrid.jsx
 *
 * Scrollable 3-column grid of ThumbnailCard components, with a header
 * row that hosts the bulk "Flag all for reprint" / "Clear all" control.
 *
 * Styling: classes defined in src/renderer/job-review.css.
 *
 * Props (passed down from useJobReview via index.jsx):
 *   images               ImageEntry[]
 *   selectedId           string        Currently selected filename
 *   jobPath              string        Absolute path to job root (for image file:// URLs)
 *   onSelect             (filename) => void   Set selected image for main preview
 *   onToggleReprint      (filename) => void   Toggle reprint flag on one image
 *   onFlagAllReprints    () => void           Bulk flag every image for reprint
 *   onClearAllReprints   () => void           Bulk clear every reprint flag
 *   aiQualityThreshold   number        Threshold below which the per-card score badge turns red
 */

export function ThumbnailGrid({
  images,
  selectedId,
  jobPath,
  jobArtworkSource = null,   // S3 Artwork Channel M2 — passed through to ThumbnailCard for the per-file source tag
  onSelect,
  onToggleReprint,
  onFlagAllReprints,
  onClearAllReprints,
  aiQualityThreshold,
  onOpenOriginal,
  onRevealOriginal,
}) {
  const scrollRef = useRef(null);

  // Auto-scroll the selected card into view whenever selectedId changes
  // (covers keyboard nav, prev/next buttons, and initial open).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !selectedId) return;
    // ThumbnailCard sets aria-pressed="true" on the selected card's root div.
    const el = container.querySelector('[aria-pressed="true"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  // Bulk-toggle state: counts drive the header button label + the
  // secondary "Clear" link that only shows when state is mixed.
  const flaggedCount = images.reduce((n, img) => n + (img.reprint ? 1 : 0), 0);
  const total        = images.length;
  const allFlagged   = total > 0 && flaggedCount === total;
  const noneFlagged  = flaggedCount === 0;
  const mixed        = !allFlagged && !noneFlagged;

  // Single primary action:
  //   - none flagged       → "Flag all for reprint"
  //   - mixed              → "Flag remaining (N)"
  //   - all flagged        → "Clear all reprint flags"
  // Mixed state also exposes a secondary "Clear all" link so operators
  // can bail out without having to first complete the flag-all step.
  let primaryLabel;
  let primaryAction;
  if (allFlagged) {
    primaryLabel  = 'Clear all reprint flags';
    primaryAction = onClearAllReprints;
  } else if (mixed) {
    primaryLabel  = `Flag remaining (${total - flaggedCount})`;
    primaryAction = onFlagAllReprints;
  } else {
    primaryLabel  = 'Flag all for reprint';
    primaryAction = onFlagAllReprints;
  }

  const headerHidden = total === 0;

  return (
    <div className="jr-grid-col">
      {!headerHidden && (
        <div className="jr-grid-header">
          <button
            type="button"
            onClick={primaryAction}
            className={'jr-grid-bulk-btn' + (allFlagged ? ' is-clear' : '')}
          >
            {primaryLabel}
          </button>
          {mixed && (
            <button
              type="button"
              onClick={onClearAllReprints}
              className="jr-grid-bulk-link"
            >
              Clear
            </button>
          )}
          <div className="jr-grid-header__count">
            {flaggedCount > 0
              ? `${flaggedCount} / ${total} flagged`
              : `${total} image${total !== 1 ? 's' : ''}`}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="jr-grid-scroll">
        {images.map(img => {
          // Construct the absolute path to the image file in /working/.
          // We join client-side because jobPath is already an absolute Windows path.
          const imagePath = jobPath
            ? `${jobPath}\\working\\${img.filename}`
            : null;

          // Resolve the customer original's absolute file:// URL for the
          // small in-card thumbnail. originalFilename is manifest-relative
          // (e.g. "PXDEMO-…/original-files/1-IMG.jpg"); the order root is
          // path.dirname(jobPath). null when the manifest didn't ship one
          // — ThumbnailCard skips the whole affordance in that case.
          let originalPath = null;
          if (jobPath && img.originalFilename) {
            const orderRoot = jobPath.replace(/[\\/][^\\/]+[\\/]?$/, '');
            originalPath = `${orderRoot}\\${img.originalFilename.replace(/\//g, '\\')}`;
          }

          return (
            <ThumbnailCard
              key={img.filename}
              image={img}
              imagePath={imagePath}
              originalPath={originalPath}
              isSelected={img.filename === selectedId}
              onClick={() => onSelect(img.filename)}
              onToggleReprint={() => onToggleReprint(img.filename)}
              aiQualityThreshold={aiQualityThreshold}
              jobArtworkSource={jobArtworkSource}
              onOpenOriginal={onOpenOriginal}
              onRevealOriginal={onRevealOriginal}
            />
          );
        })}

        {images.length === 0 && (
          <div className="jr-grid-empty">No images found in /working/</div>
        )}
      </div>
    </div>
  );
}
