'use strict';

/**
 * src/shared/cropRectMath.js
 *
 * Pure math for the batch-crop UI's rect manipulation.
 *
 * STORAGE MODEL — `FractionalSpec` (live-test rewrite, 2026-05-25):
 *
 *   { centerX: 0..1, centerY: 0..1, scale: 0..1 }
 *
 * The first M5b cut stored `{ x, y, w, h }` as image-relative
 * fractions and let CSS render `width: w * 100%` + `height: h * 100%`
 * of the imgbox. That always rendered at imgbox-aspect (NOT the
 * target's), so a square (8×8) target on a 4:3 image surfaced as a
 * 4:3 landscape overlay. The new model decouples shape from size:
 *
 *   - `centerX, centerY` — the rect's CENTER (fractions of image).
 *     Drag-to-move adjusts these.
 *   - `scale` — fraction of the LARGEST target-aspect rect that fits
 *     inside the image (the "maxFit" rect). Drag-a-handle adjusts
 *     this. scale = 1 → maxFit. scale = 0.3 → ~9% area.
 *
 * The TARGET ASPECT is supplied separately (`sizeOption` +
 * `orientation`) at every API site rather than embedded in the spec.
 * That keeps the spec orientation-agnostic — flipping orientation
 * just changes which aspect the same `scale` produces at apply time.
 *
 * Helpers exposed:
 *
 *   - effectiveAspect(sizeOption, orientation)
 *       → rectAspect (w/h) for the chosen orientation. Square ⇒ 1.
 *
 *   - maxFitAreaFraction(effAspect, imageAspect)
 *       → fraction of image area that maxFit covers (1.0 when image
 *       and target share aspect; smaller otherwise).
 *
 *   - minScaleForArea(effAspect, imageAspect, minAreaFraction=0.1)
 *       → smallest scale that keeps the cropped output ≥ minAreaFraction
 *       of the SOURCE image's area.
 *
 *   - computeAspectLockedSpec(initialScale=0.95)
 *       → fresh centered spec at the given scale.
 *
 *   - clampSpec(spec, sizeOption, orientation, imageAspect, minAreaFraction)
 *       → spec with centerX/centerY/scale clamped so the rect stays
 *       inside [0,1] and ≥ min area.
 *
 *   - specToOverlayLayout(spec, sizeOption, orientation, imageAspect)
 *       → renderer-side CSS layout for the overlay:
 *           { leftFrac, topFrac, widthFrac, heightFrac, aspectRatio }
 *       Renderer applies `left/top/width = X * 100%`, sets the
 *       overlay's `aspect-ratio: aspectRatio` inline, and lets the
 *       browser derive height from width + aspect. The overlay's
 *       on-screen shape is then the TARGET aspect — square targets
 *       give square overlays regardless of imgbox aspect.
 *
 *   - specToPixelRect(spec, sizeOption, orientation, imageW_px, imageH_px)
 *       → integer pixel rect `{ x, y, w, h }` for sharp.extract.
 *       Per-image at apply time; clamped to image bounds.
 *
 *   - resizeSpecFromHandle({ corner, anchor, targetX, targetY,
 *                            sizeOption, orientation, imageAspect,
 *                            minAreaFraction })
 *       → new spec when the operator drags a corner handle. Anchor
 *       (the OPPOSITE corner) stays fixed; aspect is LOCKED to
 *       `effectiveAspect`; scale clamped to the min-area floor.
 *
 * All inputs/outputs are image-relative fractions [0, 1]; pixel
 * conversion happens at apply time via specToPixelRect.
 */

function effectiveAspect(sizeOption, orientation) {
  if (!sizeOption || !Number.isFinite(sizeOption.w) || !Number.isFinite(sizeOption.h)
      || sizeOption.w <= 0 || sizeOption.h <= 0) {
    return null;
  }
  const base = sizeOption.w / sizeOption.h;
  // Square targets are orientation-invariant — return 1 regardless.
  if (Math.abs(base - 1) < 1e-9) return 1;
  return (orientation === 'landscape')
    ? Math.max(base, 1 / base)
    : Math.min(base, 1 / base);
}

/**
 * Fraction of image area that the maxFit target-aspect rect occupies.
 *
 *   maxFitW/imageW = min(1, effAspect / imageAspect)
 *   maxFitH/imageH = min(1, imageAspect / effAspect)
 *   maxFitArea / imageArea = min(1, effAspect/imageAspect) × min(1, imageAspect/effAspect)
 *                          = min(imageAspect/effAspect, effAspect/imageAspect)
 *
 * Returns 1 when the image's aspect equals the target's aspect; less
 * than 1 otherwise.
 */
function maxFitAreaFraction(effAspect, imageAspect) {
  if (!Number.isFinite(effAspect) || !Number.isFinite(imageAspect)
      || effAspect <= 0 || imageAspect <= 0) return 0;
  return Math.min(imageAspect / effAspect, effAspect / imageAspect);
}

function minScaleForArea(effAspect, imageAspect, minAreaFraction = 0.1) {
  const ratio = maxFitAreaFraction(effAspect, imageAspect);
  if (ratio <= 0) return 0;
  // scale² × maxFitArea/imageArea = minAreaFraction
  //   scale ≥ sqrt(minAreaFraction / ratio)
  const minS = Math.sqrt(minAreaFraction / ratio);
  // Floor at 0 and cap at 1 (if minScale > 1 the constraint can't be
  // satisfied — caller should reject the minAreaFraction).
  return Math.min(1, Math.max(0, minS));
}

function computeAspectLockedSpec(initialScale = 0.95) {
  const s = Math.max(0, Math.min(1, Number.isFinite(initialScale) ? initialScale : 0.95));
  return { centerX: 0.5, centerY: 0.5, scale: s };
}

function clampSpec(spec, sizeOption, orientation, imageAspect, minAreaFraction = 0.1) {
  const effAspect = effectiveAspect(sizeOption, orientation);
  if (!effAspect || !Number.isFinite(imageAspect) || imageAspect <= 0 || !spec) return spec;

  const minS = minScaleForArea(effAspect, imageAspect, minAreaFraction);
  let scale = Math.max(minS, Math.min(1, spec.scale));

  // Rect's fractional w/h in image space.
  const maxFitWFrac = Math.min(1, effAspect / imageAspect);
  const maxFitHFrac = Math.min(1, imageAspect / effAspect);
  const widthFrac  = scale * maxFitWFrac;
  const heightFrac = scale * maxFitHFrac;

  // Centre must keep the rect fully inside [0, 1].
  let centerX = spec.centerX;
  let centerY = spec.centerY;
  centerX = Math.max(widthFrac  / 2, Math.min(1 - widthFrac  / 2, centerX));
  centerY = Math.max(heightFrac / 2, Math.min(1 - heightFrac / 2, centerY));

  return { centerX, centerY, scale };
}

function specToOverlayLayout(spec, sizeOption, orientation, imageAspect) {
  const effAspect = effectiveAspect(sizeOption, orientation);
  if (!effAspect || !Number.isFinite(imageAspect) || imageAspect <= 0 || !spec) return null;

  const maxFitWFrac = Math.min(1, effAspect / imageAspect);
  const maxFitHFrac = Math.min(1, imageAspect / effAspect);
  const widthFrac  = spec.scale * maxFitWFrac;
  const heightFrac = spec.scale * maxFitHFrac;
  const leftFrac = spec.centerX - widthFrac  / 2;
  const topFrac  = spec.centerY - heightFrac / 2;

  return {
    leftFrac, topFrac,
    widthFrac, heightFrac,
    // Renderer sets this as `aspect-ratio` CSS on the overlay element
    // so the on-screen shape matches the target — NOT the imgbox.
    // Square target → 1; portrait → < 1; landscape → > 1.
    aspectRatio: effAspect,
  };
}

function specToPixelRect(spec, sizeOption, orientation, imageW, imageH) {
  const effAspect = effectiveAspect(sizeOption, orientation);
  if (!effAspect || !Number.isFinite(imageW) || !Number.isFinite(imageH)
      || imageW <= 0 || imageH <= 0 || !spec) return null;

  // The maxFit rect in source pixels has target aspect and fits within
  // the image's bounds.
  const maxFitW_px = Math.min(imageW, imageH * effAspect);
  const maxFitH_px = Math.min(imageH, imageW / effAspect);
  const w_px = spec.scale * maxFitW_px;
  const h_px = spec.scale * maxFitH_px;
  const centerX_px = spec.centerX * imageW;
  const centerY_px = spec.centerY * imageH;
  let x = centerX_px - w_px / 2;
  let y = centerY_px - h_px / 2;
  // Slide inside image bounds (preserve w/h; assume spec was clamped).
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w_px > imageW) x = imageW - w_px;
  if (y + h_px > imageH) y = imageH - h_px;

  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    w: Math.max(1, Math.round(w_px)),
    h: Math.max(1, Math.round(h_px)),
  };
}

function resizeSpecFromHandle({
  corner, anchor, targetX, targetY,
  sizeOption, orientation, imageAspect,
  minAreaFraction = 0.1,
}) {
  const effAspect = effectiveAspect(sizeOption, orientation);
  if (!effAspect || !Number.isFinite(imageAspect) || imageAspect <= 0) return null;

  const maxFitWFrac = Math.min(1, effAspect / imageAspect);
  const maxFitHFrac = Math.min(1, imageAspect / effAspect);

  // Clamp the operator's target to [0, 1].
  const tx = Math.max(0, Math.min(1, targetX));
  const ty = Math.max(0, Math.min(1, targetY));

  // Proposed dimensions from anchor → target.
  const proposedW = Math.abs(tx - anchor.x);
  const proposedH = Math.abs(ty - anchor.y);

  // Resolve scale that fits the drag while preserving aspect.
  // Each axis gives a candidate scale; pick the SMALLER so neither
  // axis exceeds the drag.
  let scale;
  if (proposedW === 0 && proposedH === 0) {
    scale = 0; // lifted by min-floor below
  } else if (proposedW === 0) {
    scale = proposedH / maxFitHFrac;
  } else if (proposedH === 0) {
    scale = proposedW / maxFitWFrac;
  } else {
    const sw = proposedW / maxFitWFrac;
    const sh = proposedH / maxFitHFrac;
    scale = Math.min(sw, sh);
  }
  // Cap at 1.0 (the maxFit).
  scale = Math.min(1, scale);
  // Floor at min-area.
  const minS = minScaleForArea(effAspect, imageAspect, minAreaFraction);
  scale = Math.max(minS, scale);

  // Place the rect so the anchor (opposite corner) stays where it is.
  const widthFrac  = scale * maxFitWFrac;
  const heightFrac = scale * maxFitHFrac;
  let centerX, centerY;
  switch (corner) {
    case 'br': centerX = anchor.x + widthFrac / 2;  centerY = anchor.y + heightFrac / 2; break;
    case 'bl': centerX = anchor.x - widthFrac / 2;  centerY = anchor.y + heightFrac / 2; break;
    case 'tr': centerX = anchor.x + widthFrac / 2;  centerY = anchor.y - heightFrac / 2; break;
    case 'tl': centerX = anchor.x - widthFrac / 2;  centerY = anchor.y - heightFrac / 2; break;
    default:   centerX = anchor.x;                  centerY = anchor.y;                  break;
  }

  return clampSpec({ centerX, centerY, scale }, sizeOption, orientation, imageAspect, minAreaFraction);
}

module.exports = {
  effectiveAspect,
  maxFitAreaFraction,
  minScaleForArea,
  computeAspectLockedSpec,
  clampSpec,
  specToOverlayLayout,
  specToPixelRect,
  resizeSpecFromHandle,
};
