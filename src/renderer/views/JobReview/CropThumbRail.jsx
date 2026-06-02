import { useRef, useEffect, useState, useMemo } from 'react';

/**
 * src/renderer/views/JobReview/CropThumbRail.jsx
 *
 * Manual Crop redesign (2026-06-01) — left-column thumbnail rail for
 * ManualCropMode. Mirrors the standard JobReview's .jr-grid-col /
 * ThumbnailGrid layout (~460px wide, 3-column grid of thumb cards
 * inside) so muscle memory transfers between the two modes.
 *
 * Each thumb shows the /working/ image, an absolutely-positioned
 * overlay rendering THAT image's own pendingCropRect (image-space
 * pixels projected to percentages via natural dimensions), and a
 * state badge. Click selects the image into the main CropStage.
 *
 * State semantics (first match wins):
 *   applying  → ⏳ jobCropImage IPC in flight for this image
 *   error     → ⚠ last apply failed; applyError carries the message
 *   modified  → ⚠ approved-on-disk + pending edits since (Send to
 *               Print gates here until re-approved)
 *   approved  → ✓ cropApplied: true, no pending edits
 *   pending   → • never approved (with or without a pending rect)
 *
 * Rect overlay:
 *   Drawn only when pendingCropRect is present. Approved-and-
 *   unmodified images get no overlay because /working/ IS the crop
 *   result — drawing a rectangle over the whole cropped image is
 *   meaningless. For approved-modified images the rect projects
 *   against the already-cropped /working/ file (re-crop semantics).
 *
 * Props:
 *   images           ImageEntry[]   sidecar.images
 *   jobPath          string         absolute job folder
 *   selectedIndex    number|null    currently-edited image index
 *   perImageState    Record<filename, ImageState>  — see ManualCropMode
 *   targetSizeReady  boolean        gates overlay rendering
 *   onSelect         (idx) => void  thumb click + Enter/Space
 */
export function CropThumbRail({
  images,
  jobPath,
  selectedIndex,
  perImageState,
  targetSizeReady,
  onSelect,
}) {
  const scrollRef = useRef(null);

  // Auto-scroll the selected thumb into view whenever selectedIndex
  // changes — mirrors ThumbnailGrid's pattern so [ / ] keyboard nav
  // doesn't strand the operator off-screen.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || selectedIndex == null) return;
    const el = container.querySelector('[aria-pressed="true"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  // Count + bulk-action header omitted by design — the TopBar in
  // ManualCropMode already shows "N / M approved", and there are no
  // rail-level bulk actions. Empty header slot would only add visual
  // noise. CSS in phase 5 paddings the scroll region directly.
  const total = images.length;

  return (
    <div className="jr-crop-rail">
      <div ref={scrollRef} className="jr-crop-rail-scroll">
        {images.map((img, idx) => (
          <CropRailThumb
            key={img.filename}
            image={img}
            jobPath={jobPath}
            state={perImageState[img.filename] || {}}
            targetSizeReady={targetSizeReady}
            isSelected={idx === selectedIndex}
            onClick={() => onSelect(idx)}
          />
        ))}
        {total === 0 && (
          <div className="jr-crop-rail-empty">No images to crop</div>
        )}
      </div>
    </div>
  );
}

function CropRailThumb({ image, jobPath, state, targetSizeReady, isSelected, onClick }) {
  const src = `file:///${jobPath.replace(/\\/g, '/')}/working/${image.filename}`;
  const [naturalDims, setNaturalDims] = useState(null);

  // Project pendingCropRect (image-space pixels) to fractions of the
  // natural dims so the overlay can be CSS-positioned via percentages.
  // No overlay when the rect is absent, the image hasn't loaded yet,
  // OR the image is discarded (drawing a saved rect on a discarded
  // thumb is visual noise — the strikethrough + dimmed thumb is
  // enough of a signal).
  const overlayLayout = useMemo(() => {
    if (!targetSizeReady || !naturalDims) return null;
    if (state.discarded) return null;
    const rect = state.pendingCropRect;
    if (!rect || !rect.w || !rect.h) return null;
    return {
      leftFrac:   rect.x / naturalDims.w,
      topFrac:    rect.y / naturalDims.h,
      widthFrac:  rect.w / naturalDims.w,
      heightFrac: rect.h / naturalDims.h,
    };
  }, [targetSizeReady, naturalDims, state.pendingCropRect, state.discarded]);

  // First-match-wins state classification. Drives both the badge glyph
  // and the modifier class so CSS can colour them per-kind. `discarded`
  // has the highest precedence — it overrides every other state because
  // it's the operator's latest expressed intent (an approved-then-
  // discarded image renders discarded, not approved).
  const stateKind = state.discarded
    ? 'discarded'
    : state.applying
      ? 'applying'
      : state.applyError
        ? 'error'
        : (state.cropAppliedOnDisk && state.modifiedSinceApproval)
          ? 'modified'
          : state.cropAppliedOnDisk
            ? 'approved'
            : 'pending';

  const badgeGlyph =
      stateKind === 'discarded' ? '✕'
    : stateKind === 'applying'  ? '⏳'
    : stateKind === 'error'     ? '⚠'
    : stateKind === 'modified'  ? '⚠'
    : stateKind === 'approved'  ? '✓'
    : '•';

  const stateLabel =
      stateKind === 'discarded' ? 'Discarded — click to restore'
    : stateKind === 'applying'  ? 'Applying crop…'
    : stateKind === 'error'     ? `Apply failed${state.applyError ? `: ${state.applyError}` : ''}`
    : stateKind === 'modified'  ? 'Modified — re-approve'
    : stateKind === 'approved'  ? 'Approved'
    : 'Pending';

  const className = 'jr-crop-rail-thumb'
    + (isSelected ? ' is-selected' : '')
    + ` is-${stateKind}`;

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${image.filename} — ${stateLabel}`}
      title={`${image.filename} — ${stateLabel}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div
        className="jr-crop-rail-thumb__imgbox"
        style={{ aspectRatio: naturalDims ? (naturalDims.w / naturalDims.h) : 1 }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const im = e.currentTarget;
            if (im.naturalWidth > 0 && im.naturalHeight > 0) {
              setNaturalDims({ w: im.naturalWidth, h: im.naturalHeight });
            }
          }}
        />
        {overlayLayout && (
          <div
            className="jr-crop-rail-thumb__overlay"
            style={{
              left:   `${overlayLayout.leftFrac * 100}%`,
              top:    `${overlayLayout.topFrac * 100}%`,
              width:  `${overlayLayout.widthFrac * 100}%`,
              height: `${overlayLayout.heightFrac * 100}%`,
            }}
          />
        )}
      </div>
      <div
        className={`jr-crop-rail-thumb__badge jr-crop-rail-thumb__badge--${stateKind}`}
        aria-hidden="true"
      >
        {badgeGlyph}
      </div>
      <div className="jr-crop-rail-thumb__name" title={image.filename}>
        {image.filename}
      </div>
    </div>
  );
}
