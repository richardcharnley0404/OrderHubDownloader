import { useRef, useEffect, useState } from 'react';

/**
 * src/renderer/views/JobReview/ThumbnailCard.jsx
 *
 * A single thumbnail card.  The image is rendered onto an HTML <canvas>
 * element so CMY colour corrections can be previewed live without modifying
 * any file on disk.
 *
 * Correction preview logic (brief §ThumbnailCard):
 *   - A coloured RGBA overlay is composited over the canvas image.
 *   - Cyan    positive → cyan tint   (removes red)
 *   - Magenta positive → magenta tint (removes green)
 *   - Yellow  positive → yellow tint  (removes blue)
 *   - Overlay opacity scales with total correction magnitude (max ~0.35).
 *
 * Top-left badges:
 *   - FLAG / REPRINT toggle (always present) — click to toggle the
 *     image's reprint flag without changing which image is selected
 *     in the main preview. Solid red when flagged, faint dark when not.
 *   - MOD      (green) — when qty or corrections differ from original
 *   - AI    (purple)   — when this image has been AI-enhanced
 *
 * Top-right badge:
 *   - ×{qty}   (grey)  — when qtyCurrent !== qtyOriginal
 *
 * Selection border is drawn by CSS (.jr-card.is-selected) — earlier
 * implementation drew it on the canvas as well, which was redundant.
 *
 * Props:
 *   image                ImageEntry  Full sidecar image entry
 *   imagePath            string      Absolute path to the image file in /working/
 *   isSelected           boolean
 *   onClick              () => void   Selects this image for the main preview
 *   onToggleReprint      () => void   Toggles the reprint flag (no selection change)
 *   cardSize             number      Width of the card in px (default 140)
 *   aiQualityThreshold   number      Threshold below which the score badge turns red
 */

const CANVAS_ASPECT = 0.75;   // height = width × 0.75

// ── Canvas rendering ──────────────────────────────────────────────────────────

function useImageCanvas(canvasRef, imagePath, corrections, reprint, size) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    function applyOverlays() {
      // CMY correction overlay.
      const { cyan, magenta, yellow } = corrections;
      if (cyan !== 0 || magenta !== 0 || yellow !== 0) {
        // Positive cyan   → adds cyan   tint by overlaying cyan   (R=0, G=255, B=255)
        // Positive magenta→ adds magenta tint (R=255, G=0,   B=255)
        // Positive yellow → adds yellow  tint (R=255, G=255, B=0)
        // Negative values → opposite hue with same logic
        const totalMag = (Math.abs(cyan) + Math.abs(magenta) + Math.abs(yellow));
        const alpha    = Math.min(0.35, totalMag / 60);

        if (alpha > 0) {
          // Mix: cyan contributes to G+B, magenta to R+B, yellow to R+G.
          // We approximate by blending the three contribution colours.
          const r = Math.round(
            (Math.max(0, -cyan)    * 255 +  // no red from cyan positive
             Math.max(0,  magenta) * 255 +
             Math.max(0,  yellow)  * 255) / (totalMag || 1)
          );
          const g = Math.round(
            (Math.max(0,  cyan)    * 255 +
             Math.max(0, -magenta) * 255 +  // no green from magenta positive
             Math.max(0,  yellow)  * 255) / (totalMag || 1)
          );
          const b = Math.round(
            (Math.max(0,  cyan)    * 255 +
             Math.max(0,  magenta) * 255 +
             Math.max(0, -yellow)  * 255) / (totalMag || 1)
          );
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
          ctx.fillRect(0, 0, w, h);
        }
      }

      // Reprint tint.
      if (reprint) {
        ctx.fillStyle = 'rgba(220, 50, 50, 0.18)';
        ctx.fillRect(0, 0, w, h);
      }
    }

    // Attempt to load the actual image from disk.
    // In Electron with contextIsolation, file:// URLs are allowed for local images.
    if (imagePath) {
      const img = new Image();
      img.onload = () => {
        // Draw image scaled to fill the canvas, centred (cover behaviour).
        const imgAspect    = img.naturalWidth / img.naturalHeight;
        const canvasAspect = w / h;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;

        if (imgAspect > canvasAspect) {
          // Image wider than canvas — crop sides.
          sw = img.naturalHeight * canvasAspect;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          // Image taller than canvas — crop top/bottom.
          sh = img.naturalWidth / canvasAspect;
          sy = (img.naturalHeight - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        applyOverlays();
      };
      img.onerror = () => {
        // Image couldn't load — draw a placeholder.
        drawPlaceholder(ctx, w, h);
        applyOverlays();
      };
      // Electron allows loading file:// URLs in the renderer.
      img.src = `file://${imagePath.replace(/\\/g, '/')}`;
    } else {
      drawPlaceholder(ctx, w, h);
      applyOverlays();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath, corrections.cyan, corrections.magenta, corrections.yellow, reprint, size]);
}

function drawPlaceholder(ctx, w, h) {
  // Grey gradient placeholder when image path is unknown.
  // Colours are intentionally hardcoded — the placeholder reads against
  // both light and dark card surfaces.
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#3a5060');
  grad.addColorStop(1, '#243040');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Photo icon symbol.
  ctx.strokeStyle = '#4a6070';
  ctx.lineWidth   = 1.5;
  const m = w * 0.2;
  ctx.strokeRect(m, m * 1.2, w - m * 2, h - m * 2.4);
  ctx.beginPath();
  ctx.arc(w * 0.4, h * 0.42, w * 0.08, 0, Math.PI * 2);
  ctx.stroke();
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * Per-image AI Quality score pill, bottom-right corner of the thumbnail.
 *
 *   - unscored (no aiQuality block, or scored:false)  → render nothing
 *   - errored  (aiQuality.error populated)            → "n/a" + tooltip with error
 *   - scored, above threshold                         → white text on dark pill
 *   - scored, below threshold                         → red text + red border
 *
 * Tooltip carries the calibration context: scored timestamp, model version,
 * mode at score time, threshold at score time.
 */
function ScoreBadge({ aiQuality, threshold }) {
  if (!aiQuality || !aiQuality.scored) return null;

  const hasError = !!aiQuality.error;
  const score = typeof aiQuality.score === 'number' ? aiQuality.score : null;
  const subThreshold = !hasError && score !== null && score < threshold;
  const display = hasError || score === null ? 'n/a' : score.toFixed(1);

  // Tooltip — newline-separated lines via the title attribute (browsers
  // render \n as line breaks in native tooltips).
  const tipLines = [];
  if (hasError) tipLines.push(`Error: ${aiQuality.error}`);
  if (aiQuality.scoredAt) {
    try {
      tipLines.push(`Scored: ${new Date(aiQuality.scoredAt).toLocaleString()}`);
    } catch { /* ignore parse failure */ }
  }
  if (aiQuality.modelVersion) tipLines.push(`Model: ${aiQuality.modelVersion}`);
  if (aiQuality.modeAtScoreTime) tipLines.push(`Mode: ${aiQuality.modeAtScoreTime}`);
  if (aiQuality.thresholdAtScoreTime != null) {
    tipLines.push(`Threshold at scoring: ${aiQuality.thresholdAtScoreTime}`);
  }
  const tooltip = tipLines.join('\n');

  return (
    <div
      title={tooltip}
      className={'jr-score' + (subThreshold ? ' jr-score--sub' : '')}
    >
      {display}
    </div>
  );
}

// ── ThumbnailCard ─────────────────────────────────────────────────────────────

export function ThumbnailCard({
  image,
  imagePath,
  originalPath,
  isSelected,
  onClick,
  onToggleReprint,
  cardSize = 140,
  aiQualityThreshold = 50,
  jobArtworkSource = null,    // S3 Artwork Channel M2 — null when job-level lookup hasn't resolved or job is FTP-only
  onOpenOriginal,
  onRevealOriginal,
}) {
  const canvasRef = useRef(null);

  const {
    corrections, reprint, qtyCurrent, qtyOriginal, filename, enhanced, aiQuality,
    originalFilename, artworkSource,
    // M3 (2026-05-24): per-file production_ready + copies. Both null for
    // pre-M3 / FTP-delivered entries; chips suppress in that case.
    productionReady, copies,
  } = image;

  // S3 Artwork Channel M2 (2026-05-24): per-file source tag, only when
  // this file's source differs from the job-level source (the brief calls
  // for clutter avoidance — uniform-source jobs show nothing). FTP-delivered
  // entries carry artworkSource:null and are skipped. The tag sits in the
  // filename label strip below the canvas, never overlaying the thumbnail.
  const showSourceTag = artworkSource != null
    && jobArtworkSource != null
    && artworkSource !== jobArtworkSource;
  const sourceTagLabel = artworkSource === 'manual' ? 'Manual' : 'Pixfizz';

  // M3 (2026-05-24): "Not finalised" warning chip.
  //
  // Tightened 2026-05-24 to mirror the M2 hold-rule narrowing:
  // production_ready: false is OrderHub's DEFAULT state for non-manual
  // Pixfizz-source files (e.g. book-thumbnails on a photo book order),
  // where there's no operator finalisation workflow — the chip is
  // meaningless in that context. Only manual-source files have an
  // operator-driven finalisation cycle, so the chip is scoped to that
  // case only. Pixfizz-source and legacy/null-source files never show
  // the chip regardless of productionReady value. Keeps M3 display
  // behaviour consistent with the M2 hold rule (both fire only on
  // manual artwork) so the warning surfaces speak the same language.
  const showNotFinalisedTag = artworkSource === 'manual'
    && productionReady === false;

  // M3 (2026-05-24): "×N copies" chip. Fires only when copies is a finite
  // number AND not the common copies=1 case. null suppresses (legacy /
  // FTP-delivered entries — no API copies value persisted). The
  // multiplied quantity already lives in qtyOriginal and drives dispatch;
  // this chip is the operator-visible breakdown.
  const showCopiesTag = Number.isFinite(copies) && copies !== 1;

  // Inline error notice when the customer original turns out to be missing
  // from disk (race / partial download / manual deletion). Clears itself
  // after a short delay so the card returns to its idle state.
  const [originalError, setOriginalError] = useState(null);
  useEffect(() => {
    if (!originalError) return undefined;
    const t = setTimeout(() => setOriginalError(null), 4000);
    return () => clearTimeout(t);
  }, [originalError]);

  async function handleOriginalAction(action) {
    if (!onOpenOriginal && !onRevealOriginal) return;
    const fn = action === 'reveal' ? onRevealOriginal : onOpenOriginal;
    if (!fn) return;
    try {
      const result = await fn(originalFilename);
      if (result && result.ok === false) {
        setOriginalError(result.error === 'not-found'
          ? 'Original file no longer on disk'
          : (result.error || 'Could not open original'));
      } else {
        setOriginalError(null);
      }
    } catch (err) {
      setOriginalError(err && err.message ? err.message : 'Could not open original');
    }
  }
  function handleOpenOriginal(e)   { e.stopPropagation(); handleOriginalAction('open');   }
  function handleRevealOriginal(e) { e.stopPropagation(); handleOriginalAction('reveal'); }

  const isModified = qtyCurrent !== qtyOriginal
    || corrections.cyan    !== 0
    || corrections.magenta !== 0
    || corrections.yellow  !== 0;

  const canvasW = cardSize - 12;           // 6 px padding each side
  const canvasH = Math.round(canvasW * CANVAS_ASPECT);

  useImageCanvas(canvasRef, imagePath, corrections, reprint, canvasW);

  const className = 'jr-card'
    + (isSelected ? ' is-selected' : '')
    + (reprint    ? ' is-reprint'  : '');

  // The reprint toggle on the card needs to swallow its click so the
  // surrounding "click-card-to-select" handler doesn't also fire — the
  // operator should be able to flag/unflag without the main preview
  // jumping to this image. Keyboard activation does the same.
  function handleToggleReprint(e) {
    e.stopPropagation();
    if (onToggleReprint) onToggleReprint();
  }
  function handleToggleReprintKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.stopPropagation();
    e.preventDefault();
    if (onToggleReprint) onToggleReprint();
  }

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-pressed={isSelected}
      aria-label={`Select ${filename}`}
      className={className}
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        className="jr-card__canvas"
      />

      {/* Top-left badges. The flag toggle is rendered as a button so it's
          tab-reachable and announced by screen readers; it stops propagation
          on click and keydown so toggling the flag does not also change the
          selected image in the main preview. */}
      <div className="jr-badges-tl">
        <button
          type="button"
          onClick={handleToggleReprint}
          onKeyDown={handleToggleReprintKey}
          aria-pressed={reprint}
          aria-label={reprint
            ? `Unflag ${filename} for reprint`
            : `Flag ${filename} for reprint`}
          title={reprint
            ? 'Click to remove reprint flag'
            : 'Click to flag for reprint'}
          className={'jr-card__flag' + (reprint ? ' is-on' : '')}
        >
          {reprint ? 'REPRINT' : 'FLAG'}
        </button>
        {isModified && <span className="jr-badge jr-badge--mod">MOD</span>}
        {enhanced && <span className="jr-badge jr-badge--ai">AI</span>}
      </div>

      {/* Top-right chip overlay (M3 layout fix, 2026-05-24).
          Single positioned region holding up to three optional indicators
          stacked vertically so they never collide with the bottom-right
          AI score or the bottom label strip — the earlier M3 placement
          inside .jr-card__label caused "Not finalised" to truncate to
          "NOT FINA…" when the AI score badge was also present.
          Render order (top → bottom):
            1. Operator-mod ×N (when qtyCurrent !== qtyOriginal — was
               the previous lone occupant of .jr-badge-tr; folded in so
               the corner is a single positioned region).
            2. "Not finalised" warning (productionReady === false).
            3. "×N copies" (copies !== 1).
          pointer-events on the container is set to none in CSS so the
          chips don't intercept card-select clicks; each child re-enables
          its own pointer events for tooltips. */}
      {(qtyCurrent !== qtyOriginal || showNotFinalisedTag || showCopiesTag) && (
        <div className="jr-card__chip-overlay">
          {qtyCurrent !== qtyOriginal && (
            <span className="jr-badge jr-badge--qty">×{qtyCurrent}</span>
          )}
          {showNotFinalisedTag && (
            <span
              className="jr-not-finalised-tag"
              title="This file is flagged production_ready: false by OrderHub — informational only"
            >
              Not finalised
            </span>
          )}
          {showCopiesTag && (
            <span
              className="jr-copies-tag"
              title={`This file is configured for ${copies} copies per print run`}
            >
              ×{copies} copies
            </span>
          )}
        </div>
      )}

      {/* Bottom-right AI Quality score pill */}
      <ScoreBadge aiQuality={aiQuality} threshold={aiQualityThreshold} />

      {/* Customer Originals (Phase 1).
          Rendered only when the manifest gave us a path — pre-feature
          jobs, non-Pixfizz orders, and any image that simply didn't
          ship an original degrade silently to "no thumbnail, no
          icons". The thumbnail uses a plain <img> file:// reference so
          there's no decoding pipeline to maintain; the browser scales
          it into the 32px slot via CSS. */}
      {originalFilename && (
        <div
          className="jr-card__original"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        >
          {originalPath && (
            <img
              className="jr-card__original-thumb"
              src={`file:///${originalPath.replace(/\\/g, '/')}`}
              alt={`Customer upload for ${filename}`}
              title="Open customer original in default viewer"
              draggable={false}
              role="button"
              tabIndex={0}
              onClick={handleOpenOriginal}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleOpenOriginal(e);
                }
              }}
            />
          )}
          <button
            type="button"
            className="jr-card__original-btn"
            onClick={handleRevealOriginal}
            title="Show customer original in folder"
            aria-label={`Show customer original for ${filename} in folder`}
          >
            ⌗
          </button>
        </div>
      )}

      {originalError && (
        <div className="jr-card__original-error" role="alert">
          {originalError}
        </div>
      )}

      {/* Filename strip — bottom-left under the canvas. Holds the
          filename and (when mixed-source) the M2 source tag. The two
          M3 chips ("Not finalised" warning and "×N copies") used to
          live here too but were colliding with the bottom-right AI
          score badge on long filenames (NOT FINA… truncation).
          Layout-fix 2026-05-24 moved them up to the top-right
          .jr-card__chip-overlay block above; this strip is now
          warning-free (the source tag is identification, not
          warning, per the layout-fix brief). */}
      <div className="jr-card__label">
        <span className="jr-card__filename" title={filename}>{filename}</span>
        {showSourceTag && (
          <span
            className={`jr-source-tag jr-source-tag--${artworkSource}`}
            title={`This file's source (${artworkSource}) differs from the job's source (${jobArtworkSource})`}
          >
            {sourceTagLabel}
          </span>
        )}
      </div>

    </div>
  );
}
