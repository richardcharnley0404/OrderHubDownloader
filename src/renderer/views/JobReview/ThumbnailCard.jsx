import { useRef, useEffect } from 'react';

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
 * Badges:
 *   - REPRINT  (red)   — when reprint: true
 *   - MOD      (green) — when qty or corrections differ from original
 *   - ×{qty}   (grey)  — when qtyCurrent !== qtyOriginal
 *
 * Selection border is drawn by CSS (.jr-card.is-selected) — earlier
 * implementation drew it on the canvas as well, which was redundant.
 *
 * Props:
 *   image                ImageEntry  Full sidecar image entry
 *   imagePath            string      Absolute path to the image file in /working/
 *   isSelected           boolean
 *   onClick              () => void
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

export function ThumbnailCard({ image, imagePath, isSelected, onClick, cardSize = 140, aiQualityThreshold = 50 }) {
  const canvasRef = useRef(null);

  const { corrections, reprint, qtyCurrent, qtyOriginal, filename, enhanced, aiQuality } = image;

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

      {/* Top-left badges */}
      <div className="jr-badges-tl">
        {reprint && <span className="jr-badge jr-badge--reprint">REPRINT</span>}
        {isModified && !reprint && <span className="jr-badge jr-badge--mod">MOD</span>}
        {enhanced && <span className="jr-badge jr-badge--ai">AI</span>}
      </div>

      {/* Top-right QTY badge */}
      {qtyCurrent !== qtyOriginal && (
        <div className="jr-badge-tr">
          <span className="jr-badge jr-badge--qty">×{qtyCurrent}</span>
        </div>
      )}

      {/* Bottom-right AI Quality score pill */}
      <ScoreBadge aiQuality={aiQuality} threshold={aiQualityThreshold} />

    </div>
  );
}
