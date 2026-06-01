import { useState, useEffect, useCallback, useRef } from 'react';
import { CropEditor } from './CropEditor.jsx';

/**
 * src/renderer/views/JobReview/FocusedCropFrame.jsx
 *
 * M5c — Focused per-image override mode (2026-05-26).
 *
 * Opens when the operator clicks a thumbnail in BatchCropMode. Wraps
 * CropEditor in film-review-style chrome: counter + filename + rotation
 * badge + Portrait/Landscape per-image toggle + close in the top bar;
 * prev/next + apply in the bottom bar. The body is CropEditor with
 * `hideOwnChrome` so its internal toggles/buttons are suppressed and
 * this component owns them.
 *
 * Keyboard parity with FilmReview's FocusedFrame:
 *   [ / ]      previous / next image (ALL images, cropped or not)
 *   R / →      rotate +90° CW
 *   L / ←      rotate +90° CCW (mod 360 = 270)
 *   Enter/Space apply crop, auto-advance to next image
 *   Esc        exit back to batch grid
 *
 * Per-image rotation is BAKED into the production file via
 * sharp.rotate() before extract — implemented in
 * batchCropActions._applyCropToSingleImage's cropRotation branch.
 * The rect's coordinates are interpreted in POST-rotation image
 * space; CropEditor's `imageRotation` prop drives the canvas
 * presentation so the operator drags the rect on what they'll get.
 *
 * Props:
 *   images          ImageEntry[]   sidecar.images (all of them)
 *   initialIndex    number         which image to focus initially
 *   jobPath         string         absolute job folder
 *   ohJobId         string|null    OrderHub job id (for routing override stamp)
 *   sizeOption      object|null    target size (M5b resolveTargetSize result)
 *   onExit          () => void     close + return to batch grid (Esc / × button)
 *   onApplied       (sidecar)      after a successful per-image apply; sidecar replaced
 */
export default function FocusedCropFrame({
  images,
  initialIndex,
  jobPath,
  ohJobId,
  sizeOption,
  sidecar,
  onExit,
  onApplied,
}) {
  // Index across ALL images — operator can re-crop already-cropped ones.
  const [index, setIndex] = useState(() => {
    const i = Number(initialIndex);
    if (!Number.isFinite(i) || i < 0 || i >= images.length) return 0;
    return i;
  });
  const image = images[index] || null;

  // Per-image rotation state. Resets to 0 on every nav — operator
  // sets rotation per image they're editing. Stored as 0/90/180/270.
  const [rotation, setRotation] = useState(0);

  // Per-image orientation toggle. Mirrors BatchCropMode's logic:
  // suppressed when target is square.
  const baseAspect = sizeOption ? sizeOption.w / sizeOption.h : 1;
  const isSquare   = !sizeOption || Math.abs(baseAspect - 1) < 0.001;
  const [orientation, setOrientation] = useState(
    () => baseAspect >= 1 ? 'landscape' : 'portrait'
  );

  // CropEditor pushes its current rect + loaded state into our refs
  // via callbacks. On Enter / Space we read the rect from the ref and
  // call electronAPI.jobCropImage directly.
  const cropRectRef = useRef(null);
  const imgLoadedRef = useRef(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  // Reset rotation + clear stale rect when navigating to a different
  // image. CropEditor remounts on index change (via key prop) which
  // also resets its internal cropRect + imgLoaded state.
  useEffect(() => {
    setRotation(0);
    setApplyError(null);
    cropRectRef.current  = null;
    imgLoadedRef.current = false;
  }, [index]);

  const navigate = useCallback((delta) => {
    if (applying) return;
    setIndex((curr) => {
      const next = curr + delta;
      if (next < 0 || next >= images.length) return curr;
      return next;
    });
  }, [applying, images.length]);

  const rotateBy = useCallback((delta) => {
    if (applying) return;
    setRotation((curr) => ((curr + delta) % 360 + 360) % 360);
  }, [applying]);

  // Apply the current crop. Calls electronAPI.jobCropImage directly
  // since CropEditor's hideOwnChrome means its internal Apply is
  // suppressed. On success, advances to the next image (or exits
  // if this was the last one).
  const applyAndAdvance = useCallback(async () => {
    if (applying) return;
    const cropRect = cropRectRef.current;
    if (!cropRect || !imgLoadedRef.current || !image) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await window.electronAPI.jobCropImage({
        jobPath,
        sidecar,
        filename:        image.filename,
        cropRect,
        channelMappingId: null,
        darkroomSize:     null,
        ohJobId,
        cropRotation:    rotation,
      });
      if (result && result.success) {
        if (typeof onApplied === 'function') onApplied(result.sidecar);
        // Auto-advance to next image if any remain; otherwise exit.
        if (index < images.length - 1) {
          setIndex(index + 1);
        } else {
          onExit?.();
        }
      } else {
        setApplyError(result?.error || 'Crop failed');
      }
    } catch (err) {
      setApplyError(err && err.message ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [applying, image, jobPath, sidecar, ohJobId, rotation, index, images.length, onApplied, onExit]);

  // Keyboard handlers — bound to document so they fire regardless
  // of focus inside the overlay. Yield to typing in inputs / textareas
  // (none in current overlay but defensive).
  useEffect(() => {
    const onKey = (e) => {
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onExit?.();
          break;
        case '[':
          e.preventDefault();
          navigate(-1);
          break;
        case ']':
          e.preventDefault();
          navigate(+1);
          break;
        case 'r':
        case 'R':
        case 'ArrowRight':
          e.preventDefault();
          rotateBy(90);
          break;
        case 'l':
        case 'L':
        case 'ArrowLeft':
          e.preventDefault();
          rotateBy(-90);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          applyAndAdvance();
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onExit, navigate, rotateBy, applyAndAdvance]);

  if (!image) return null;

  const total      = images.length;
  const hasPrev    = index > 0;
  const hasNext    = index < total - 1;
  const isCropped  = image.cropApplied === true;
  const rotationLabel = rotation === 0 ? null
    : rotation === 90  ? '90° CW'
    : rotation === 180 ? '180°'
    : rotation === 270 ? '90° CCW'
    : `${rotation}°`;

  // Build a setOrientationOverride-compatible bridge: CropEditor
  // accepts `controlledOrientation` to render the right aspect when
  // we drive the toggle from outside.
  return (
    <div className="jr-focused-crop" role="dialog" aria-modal="true" aria-label={`Crop ${image.filename}`}>
      <div className="jr-focused-backdrop" onClick={onExit} />

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header className="jr-focused-topbar">
        <button
          type="button"
          className="jr-focused-close"
          onClick={onExit}
          title="Close (Esc)"
        >
          ← Back to grid
        </button>

        <div className="jr-focused-title">
          <span className="jr-focused-counter">{index + 1} / {total}</span>
          <span className="jr-focused-filename" title={image.filename}>{image.filename}</span>
          {isCropped && <span className="jr-focused-cropped-badge" title="Already cropped — re-cropping will overwrite">cropped</span>}
          {rotationLabel && (
            <span className="jr-focused-rotation-badge" title="Rotation will be baked into the production file">
              ↻ {rotationLabel}
            </span>
          )}
        </div>

        {!isSquare && (
          <div className="jr-orientation-toggle" role="group" aria-label="Crop orientation">
            <button
              type="button"
              className={'jr-orient-btn' + (orientation === 'portrait' ? ' is-active' : '')}
              onClick={() => setOrientation('portrait')}
              disabled={applying}
            >
              Portrait
            </button>
            <button
              type="button"
              className={'jr-orient-btn' + (orientation === 'landscape' ? ' is-active' : '')}
              onClick={() => setOrientation('landscape')}
              disabled={applying}
            >
              Landscape
            </button>
          </div>
        )}

        <div className="jr-focused-rotate-controls">
          <button
            type="button"
            className="jr-focused-rotate-btn"
            onClick={() => rotateBy(-90)}
            disabled={applying}
            title="Rotate 90° CCW (L or ←)"
          >↺ L</button>
          <button
            type="button"
            className="jr-focused-rotate-btn"
            onClick={() => rotateBy(90)}
            disabled={applying}
            title="Rotate 90° CW (R or →)"
          >↻ R</button>
        </div>
      </header>

      {/* ── Body: CropEditor (chrome hidden) ──────────────────────────────── */}
      <div className="jr-focused-body">
        <CropEditor
          // Force remount on every image / rotation change so internal
          // cropRect + naturalSize state re-seed from scratch.
          key={`${image.filename}__${rotation}`}
          image={image}
          jobPath={jobPath}
          sizeOption={sizeOption}
          imageRotation={rotation}
          hideOwnChrome
          controlledOrientation={orientation}
          onCropRectChange={(r) => { cropRectRef.current = r; }}
          onImgLoadedChange={(ok) => { imgLoadedRef.current = ok; }}
          // The internal onApply/onCancel won't fire (chrome hidden),
          // but pass no-ops so destructuring inside CropEditor still
          // resolves cleanly.
          onApply={() => {}}
          onCancel={onExit}
        />
      </div>

      {/* ── Bottom bar ────────────────────────────────────────────────────── */}
      <footer className="jr-focused-bottombar">
        <button
          type="button"
          className="jr-focused-nav-btn"
          onClick={() => navigate(-1)}
          disabled={!hasPrev || applying}
          title="Previous image ([)"
        >
          ← Prev
        </button>

        <div className="jr-focused-status">
          {applying ? 'Applying crop…'
            : applyError ? <span className="jr-focused-error">Apply failed: {applyError}</span>
            : 'Drag rectangle to position • drag corners to resize • Enter to apply + advance'}
        </div>

        <button
          type="button"
          className="jr-focused-apply"
          onClick={applyAndAdvance}
          disabled={applying}
          title="Apply crop (Enter / Space)"
        >
          {applying ? 'Applying…' : (hasNext ? 'Apply + Next →' : 'Apply + Finish')}
        </button>

        <button
          type="button"
          className="jr-focused-nav-btn"
          onClick={() => navigate(+1)}
          disabled={!hasNext || applying}
          title="Next image (])"
        >
          Next →
        </button>
      </footer>
    </div>
  );
}
