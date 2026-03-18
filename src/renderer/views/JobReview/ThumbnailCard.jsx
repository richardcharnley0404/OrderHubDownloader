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
 * Props:
 *   image       ImageEntry  Full sidecar image entry
 *   imagePath   string      Absolute path to the image file in /working/
 *   isSelected  boolean
 *   onClick     () => void
 *   cardSize    number      Width of the card in px (default 140)
 */

const BRAND_GREEN = '#72B622';
const PURPLE_AI   = '#9b59b6';

const BG_CARD    = '#374d5c';
const BG_HOVER   = '#3d5464';
const BORDER_DIM = '#3a4e5e';
const TEXT_MUTED = '#5d7a8a';

const CANVAS_ASPECT = 0.75;   // height = width × 0.75

// ── Canvas rendering ──────────────────────────────────────────────────────────

function useImageCanvas(canvasRef, imagePath, corrections, reprint, isSelected, size) {
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

      // Selected border.
      if (isSelected) {
        ctx.strokeStyle = BRAND_GREEN;
        ctx.lineWidth = 3;
        ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
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
  }, [imagePath, corrections.cyan, corrections.magenta, corrections.yellow, reprint, isSelected, size]);
}

function drawPlaceholder(ctx, w, h) {
  // Grey gradient placeholder when image path is unknown.
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

// ── Badge components ──────────────────────────────────────────────────────────

function Badge({ text, bg, textColor = '#fff' }) {
  return (
    <div style={{
      background: bg,
      borderRadius: 2,
      padding: '1px 5px',
      fontSize: 9,
      fontFamily: "'DM Mono', monospace",
      color: textColor,
      letterSpacing: '0.05em',
      lineHeight: 1.6,
    }}>
      {text}
    </div>
  );
}

// ── ThumbnailCard ─────────────────────────────────────────────────────────────

export function ThumbnailCard({ image, imagePath, isSelected, onClick, cardSize = 140 }) {
  const canvasRef = useRef(null);

  const { corrections, reprint, qtyCurrent, qtyOriginal, filename, enhanced } = image;

  const isModified = qtyCurrent !== qtyOriginal
    || corrections.cyan    !== 0
    || corrections.magenta !== 0
    || corrections.yellow  !== 0;

  const canvasW = cardSize - 12;           // 6 px padding each side
  const canvasH = Math.round(canvasW * CANVAS_ASPECT);

  useImageCanvas(canvasRef, imagePath, corrections, reprint, isSelected, canvasW);

  const borderColor = isSelected
    ? BRAND_GREEN
    : reprint
      ? '#cc3333'
      : BORDER_DIM;

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-pressed={isSelected}
      aria-label={`Select ${filename}`}
      style={{
        background:    isSelected ? BG_HOVER : BG_CARD,
        border:        `1px solid ${borderColor}`,
        borderRadius:  5,
        padding:       6,
        cursor:        'pointer',
        position:      'relative',
        transition:    'background 0.15s, border-color 0.15s',
        boxShadow:     isSelected ? `0 0 0 1px ${BRAND_GREEN}22` : 'none',
        userSelect:    'none',
      }}
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        style={{ display: 'block', borderRadius: 3 }}
      />

      {/* Top-left badges */}
      <div style={{
        position: 'absolute', top: 8, left: 8,
        display: 'flex', gap: 3,
      }}>
        {reprint && <Badge text="REPRINT" bg="#cc3333" />}
        {isModified && !reprint && <Badge text="MOD" bg={BRAND_GREEN} />}
        {enhanced && <Badge text="AI" bg={PURPLE_AI} />}
      </div>

      {/* Top-right QTY badge */}
      {qtyCurrent !== qtyOriginal && (
        <div style={{ position: 'absolute', top: 8, right: 8 }}>
          <Badge text={`×${qtyCurrent}`} bg="#415564" />
        </div>
      )}

    </div>
  );
}
