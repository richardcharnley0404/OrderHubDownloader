import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
// 2026-05-25 spec rewrite: storage model is {centerX, centerY, scale} and
// the TARGET aspect is supplied separately. The overlay renders with
// CSS aspect-ratio = effectiveAspect(sizeOption, orientation), so the
// on-screen overlay matches the TARGET aspect regardless of source
// image aspect. Locks the live-test bug: 8×8 target → square overlay
// on a 4:3 source image (was rendering as 4:3 landscape).
import {
  effectiveAspect,
  computeAspectLockedSpec,
  clampSpec,
  specToOverlayLayout,
  resizeSpecFromHandle,
} from '../../../shared/cropRectMath.js';
// M5c (2026-05-26): focused per-image override mode. Thumb click
// opens FocusedCropFrame for that image index; operator can drag
// rect, rotate, and apply with auto-advance.
import FocusedCropFrame from './FocusedCropFrame.jsx';

/**
 * src/renderer/views/JobReview/BatchCropMode.jsx
 *
 * M5b — Batch crop mode for manual-source jobs.
 *
 * Storage model: FractionalSpec = { centerX, centerY, scale }.
 * Target aspect is computed from sizeOption + orientation. The
 * overlay's CSS `aspect-ratio` is set to the effective target aspect
 * so it renders at the TARGET aspect regardless of source-image or
 * editor-frame shape.
 *
 * Interaction:
 *   - drag-to-move (rect body) → adjusts spec.centerX / centerY
 *   - drag-a-handle (4 corners) → adjusts spec.scale (aspect locked)
 *   - orientation toggle → swaps aspect; spec.centerX/Y/scale preserved
 *
 * Props:
 *   sidecar           object        Loaded sidecar
 *   images            ImageEntry[]  sidecar.images
 *   jobPath           string        Absolute job folder
 *   ohJobId           string|null   OrderHub numeric job ID
 *   onBatchApplied    (sidecar)     Callback after IPC returns; renderer reloads state
 *   onExit            ()            Caller exits batch mode (collapses to standard)
 *   onSentToPrint     ()            Optional — fires after Send-to-Print success
 */
export default function BatchCropMode({
  sidecar,
  images,
  jobPath,
  ohJobId,
  onBatchApplied,
  onExit,
  onSentToPrint,
  // M5c: parent drawer is told whether focused mode is open so its
  // arrow-nav keydown handler can early-return (the drawer would
  // otherwise still cycle the selected image while FocusedCropFrame
  // captured arrow keys for rotation). Same precedent FilmReview
  // uses via `menuOpen` on FocusedFrame.
  onFocusedFrameChange,
}) {
  // ── Target size resolution (from routing) ─────────────────────────────────
  const [targetSize, setTargetSize] = useState(null);

  useEffect(() => {
    if (!ohJobId) {
      setTargetSize({ ok: false, reason: 'no-job-id' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const all = await window.electronAPI.getJobs();
        const list = all && all.jobs ? all.jobs : [];
        const job = list.find((j) => String(j.id) === String(ohJobId));
        if (!job) {
          if (!cancelled) setTargetSize({ ok: false, reason: 'job-not-cached' });
          return;
        }
        const res = await window.electronAPI.resolveTargetSize({ job });
        if (!cancelled) setTargetSize(res);
      } catch (err) {
        if (!cancelled) setTargetSize({ ok: false, reason: 'error', error: String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [ohJobId]);

  const targetSizeReady = !!(targetSize && targetSize.ok);
  const sizeOption      = targetSizeReady ? targetSize.sizeOption : null;
  const baseAspect      = sizeOption ? sizeOption.w / sizeOption.h : null;

  // ── Orientation state ─────────────────────────────────────────────────────
  // Seed from persisted sidecar default; fall back to brief's tie-rule.
  const initialOrientation = sidecar?.batchCropDefaultOrientation || 'landscape';
  const [orientation, setOrientation] = useState(initialOrientation);

  // Effective target aspect — feeds the overlay's CSS aspect-ratio.
  const effAspect = useMemo(() => {
    if (!sizeOption) return null;
    return effectiveAspect(sizeOption, orientation);
  }, [sizeOption, orientation]);

  // Suppress orientation toggle when target is square (toggle is a no-op).
  const showOrientationToggle = targetSizeReady && baseAspect !== 1;

  // ── Spec state ────────────────────────────────────────────────────────────
  //
  // Stored as {centerX, centerY, scale}. Sidecar defaults win over the
  // auto-computed seed so a restart restores workflow state. We
  // accept only the new shape; if a sidecar carries the old
  // {x,y,w,h} legacy shape (M5b first cuts), fall back to default.
  const persistedDefault = sidecar?.batchCropDefaultRect;
  const isLegacyShape = persistedDefault
    && Object.prototype.hasOwnProperty.call(persistedDefault, 'x');
  const initialSpec = (persistedDefault && !isLegacyShape
    && Number.isFinite(persistedDefault.centerX)
    && Number.isFinite(persistedDefault.centerY)
    && Number.isFinite(persistedDefault.scale))
    ? persistedDefault
    : computeAspectLockedSpec(0.95);
  const [spec, setSpec] = useState(initialSpec);

  // ── Image partitioning ────────────────────────────────────────────────────
  const uncroppedImages = useMemo(
    () => images.filter((i) => i && i.cropApplied !== true),
    [images]
  );
  const croppedCount = images.length - uncroppedImages.length;
  const totalCount   = images.length;
  const allCropped   = uncroppedImages.length === 0;

  // ── Progress + error state from a running batch ───────────────────────────
  const [isApplying, setIsApplying] = useState(false);
  const [progress, setProgress]     = useState(null);
  const [errors, setErrors]         = useState([]);
  const [batchSummary, setBatchSummary] = useState(null);

  useEffect(() => {
    if (!window.electronAPI || !window.electronAPI.onBatchCropProgress) return;
    const unsubscribe = window.electronAPI.onBatchCropProgress((data) => {
      setProgress({
        completed: data.completed,
        total:     data.total,
        current:   data.filename,
        ok:        data.ok,
      });
    });
    return unsubscribe;
  }, []);

  // ── Editor refs + interaction state ───────────────────────────────────────
  const editorRef = useRef(null);
  const imgboxRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { startX, startY, startSpec, frameW, frameH }
  const [resizing, setResizing] = useState(null); // { corner, anchor }
  const [imageAspect, setImageAspect] = useState(1);  // editor preview image's natural aspect

  // ── M5c focused-mode state ────────────────────────────────────────────────
  //
  // null = batch grid is showing; a number = FocusedCropFrame is open
  // for that image index. Click a thumbnail → set the index. The
  // overlay renders on top of the batch body and steals all keyboard
  // input via document.addEventListener while mounted. The drawer-
  // level arrow-nav (jr-root keydown handler in index.jsx) must
  // defer to FocusedCropFrame while it's mounted — see the
  // `focusedFrameOpen` callback below.
  const [focusedIndex, setFocusedIndex] = useState(null);
  useEffect(() => {
    if (typeof onFocusedFrameChange === 'function') {
      onFocusedFrameChange(focusedIndex !== null);
    }
  }, [focusedIndex, onFocusedFrameChange]);

  // ── Clamp/reseed effect — runs when sizeOption, orientation, or image aspect changes ──
  //
  // Each transition can put the current spec out of bounds (e.g.
  // toggling to portrait when scale was at maxFit landscape would
  // make the rect overflow on the now-shorter axis). Re-pass through
  // clampSpec so centerX/centerY/scale stay valid.
  useEffect(() => {
    if (!targetSizeReady) return;
    setSpec((curr) => clampSpec(curr, sizeOption, orientation, imageAspect, 0.1));
  }, [targetSizeReady, sizeOption, orientation, imageAspect]);

  // ── Drag-to-move handler ──────────────────────────────────────────────────
  //
  // Dragging the overlay body adjusts spec.centerX/centerY — never
  // touches scale (size is fixed once set). Measure against the
  // imgbox so coordinates are image-relative.
  const onMouseDown = useCallback((e) => {
    if (isApplying || !targetSizeReady) return;
    // Resize handles stop-propagate; this fires only on rect body / imgbox.
    const box = imgboxRef.current
      ? imgboxRef.current.getBoundingClientRect()
      : editorRef.current.getBoundingClientRect();
    setDragging({
      startX: e.clientX,
      startY: e.clientY,
      startSpec: spec,
      frameW: box.width,
      frameH: box.height,
    });
    e.preventDefault();
  }, [spec, isApplying, targetSizeReady]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const dxFrac = (e.clientX - dragging.startX) / dragging.frameW;
      const dyFrac = (e.clientY - dragging.startY) / dragging.frameH;
      const next = {
        centerX: dragging.startSpec.centerX + dxFrac,
        centerY: dragging.startSpec.centerY + dyFrac,
        scale:   dragging.startSpec.scale,
      };
      // clampSpec keeps centerX/centerY within image bounds.
      setSpec(clampSpec(next, sizeOption, orientation, imageAspect, 0.1));
    };
    const onUp = () => setDragging(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [dragging, sizeOption, orientation, imageAspect]);

  // ── Resize-handle handlers ────────────────────────────────────────────────
  //
  // Four corner handles. Drag a corner → opposite corner (anchor)
  // stays fixed; aspect LOCKED via resizeSpecFromHandle. Bubble-
  // stopping the handle's mousedown prevents the drag-to-move
  // handler from also firing on the same gesture.
  const onResizeHandleMouseDown = useCallback((e, corner) => {
    e.preventDefault();
    e.stopPropagation();
    if (isApplying || !targetSizeReady) return;
    // The anchor is the OPPOSITE corner. Compute it from the current
    // overlay layout (post-clamp), so the handle math operates on
    // image-relative fractions even though `spec` doesn't directly
    // encode corners.
    const layout = specToOverlayLayout(spec, sizeOption, orientation, imageAspect);
    if (!layout) return;
    let anchor;
    switch (corner) {
      case 'br': anchor = { x: layout.leftFrac,                    y: layout.topFrac                     }; break;
      case 'bl': anchor = { x: layout.leftFrac + layout.widthFrac, y: layout.topFrac                     }; break;
      case 'tr': anchor = { x: layout.leftFrac,                    y: layout.topFrac + layout.heightFrac }; break;
      case 'tl': anchor = { x: layout.leftFrac + layout.widthFrac, y: layout.topFrac + layout.heightFrac }; break;
      default:   anchor = { x: layout.leftFrac,                    y: layout.topFrac                     }; break;
    }
    setResizing({ corner, anchor });
  }, [spec, sizeOption, orientation, imageAspect, isApplying, targetSizeReady]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e) => {
      const box = imgboxRef.current && imgboxRef.current.getBoundingClientRect();
      if (!box) return;
      const targetX = (e.clientX - box.left) / box.width;
      const targetY = (e.clientY - box.top)  / box.height;
      const next = resizeSpecFromHandle({
        corner:          resizing.corner,
        anchor:          resizing.anchor,
        targetX,
        targetY,
        sizeOption,
        orientation,
        imageAspect,
        minAreaFraction: 0.1,
      });
      if (next) setSpec(next);
    };
    const onUp = () => setResizing(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [resizing, sizeOption, orientation, imageAspect]);

  // ── Orientation toggle ────────────────────────────────────────────────────
  //
  // Spec is orientation-agnostic — flipping orientation simply changes
  // which aspect the same spec produces at apply time. Run the spec
  // back through clampSpec so it stays valid under the new aspect.
  const flipOrientation = useCallback((newOrient) => {
    if (newOrient === orientation) return;
    setOrientation(newOrient);
  }, [orientation]);

  // ── Send to Print ─────────────────────────────────────────────────────────
  const [isSendingToPrint, setIsSendingToPrint] = useState(false);
  const [sendToPrintError, setSendToPrintError] = useState(null);
  const canSendToPrint = !isApplying && !isSendingToPrint
                       && allCropped && !!ohJobId;
  const onSendToPrint = useCallback(async () => {
    if (!canSendToPrint) return;
    setIsSendingToPrint(true);
    setSendToPrintError(null);
    try {
      const result = await window.electronAPI.sendToPrint(ohJobId);
      if (result && result.success) {
        if (typeof onSentToPrint === 'function') onSentToPrint();
      } else {
        setSendToPrintError(result?.error || 'Send to Print failed');
      }
    } catch (err) {
      setSendToPrintError(err && err.message ? err.message : String(err));
    } finally {
      setIsSendingToPrint(false);
    }
  }, [canSendToPrint, ohJobId, onSentToPrint]);

  // ── Apply Default to All ──────────────────────────────────────────────────
  const onApplyAll = useCallback(async () => {
    if (isApplying || uncroppedImages.length === 0 || !targetSizeReady) return;
    setIsApplying(true);
    setProgress({ completed: 0, total: uncroppedImages.length, current: null, ok: true });
    setErrors([]);
    setBatchSummary(null);
    try {
      const result = await window.electronAPI.jobBatchCropApply({
        jobPath,
        sidecar,
        filenames:      uncroppedImages.map((i) => i.filename),
        fractionalSpec: spec,
        sizeOption,
        orientation,
        channelMappingId: null,
        darkroomSize:     null,
        ohJobId,
      });
      setBatchSummary({
        succeeded: result.succeeded?.length || 0,
        failed:    result.failed?.length    || 0,
        skipped:   result.skipped?.length   || 0,
        aborted:   result.aborted || null,
      });
      setErrors(result.failed || []);
      if (result.sidecar && typeof onBatchApplied === 'function') {
        onBatchApplied(result.sidecar);
      }
    } catch (err) {
      setBatchSummary({ succeeded: 0, failed: uncroppedImages.length, skipped: 0, error: String(err) });
    } finally {
      setIsApplying(false);
    }
  }, [
    isApplying, uncroppedImages, targetSizeReady,
    jobPath, sidecar, spec, sizeOption, orientation, ohJobId, onBatchApplied,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────
  const previewImage = images[0] || null;
  const previewSrc = previewImage
    ? `file:///${jobPath.replace(/\\/g, '/')}/working/${previewImage.filename}`
    : null;

  const canApply = targetSizeReady && !isApplying && uncroppedImages.length > 0;

  // Layout for the editor overlay — null until target size resolves.
  const editorOverlayLayout = (targetSizeReady && imageAspect)
    ? specToOverlayLayout(spec, sizeOption, orientation, imageAspect)
    : null;

  return (
    <div className="jr-batch-mode">
      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <div className="jr-batch-topbar">
        <div className="jr-batch-target">
          <span className="jr-batch-target-label">Target:</span>
          {targetSize === null ? (
            <span className="jr-batch-target-pill jr-batch-target-pill--loading">…</span>
          ) : targetSize.ok ? (
            <span className="jr-batch-target-pill" title={`${targetSize.sizeOption.w}×${targetSize.sizeOption.h}`}>
              {targetSize.sizeOption.label || `${targetSize.sizeOption.w}×${targetSize.sizeOption.h}`}
            </span>
          ) : (
            <span className="jr-batch-target-pill jr-batch-target-pill--error" title={targetSizeReasonText(targetSize.reason)}>
              ⚠ {targetSizeReasonText(targetSize.reason)}
            </span>
          )}
        </div>

        {showOrientationToggle && (
          <div className="jr-orientation-toggle" role="group" aria-label="Crop orientation">
            <button
              type="button"
              className={'jr-orient-btn' + (orientation === 'portrait' ? ' is-active' : '')}
              onClick={() => flipOrientation('portrait')}
              disabled={isApplying || !targetSizeReady}
              title="Portrait orientation"
            >
              Portrait
            </button>
            <button
              type="button"
              className={'jr-orient-btn' + (orientation === 'landscape' ? ' is-active' : '')}
              onClick={() => flipOrientation('landscape')}
              disabled={isApplying || !targetSizeReady}
              title="Landscape orientation"
            >
              Landscape
            </button>
          </div>
        )}

        <button
          type="button"
          className="jr-batch-apply-cta"
          disabled={!canApply}
          onClick={onApplyAll}
          title={
            !targetSizeReady ? 'Assign a route with a size translation before cropping'
            : uncroppedImages.length === 0 ? 'All images already cropped'
            : isApplying ? 'Batch in progress…'
            : `Apply default crop to ${uncroppedImages.length} image${uncroppedImages.length === 1 ? '' : 's'}`
          }
        >
          {isApplying ? `Cropping… ${progress?.completed || 0} / ${progress?.total || uncroppedImages.length}`
                      : `Apply Default to All (${uncroppedImages.length})`}
        </button>

        <div className="jr-batch-progress-text">
          {croppedCount} / {totalCount} cropped
        </div>

        <button type="button" className="jr-batch-exit" onClick={onExit} disabled={isApplying}>
          Exit Batch
        </button>
      </div>

      {/* ── Body: default editor + grid ───────────────────────────────────── */}
      <div className="jr-batch-body">
        <div
          className={'jr-batch-editor' + (!targetSizeReady ? ' is-disabled' : '')}
          ref={editorRef}
          aria-disabled={!targetSizeReady}
        >
          <div
            ref={imgboxRef}
            className={'jr-batch-editor-imgbox' + (targetSizeReady ? '' : ' is-inert')}
            style={{ aspectRatio: imageAspect || 1 }}
            onMouseDown={onMouseDown}
          >
            {previewSrc && (
              <img
                src={previewSrc}
                alt=""
                className="jr-batch-editor-img"
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setImageAspect(img.naturalWidth / img.naturalHeight);
                  }
                }}
              />
            )}
            {/* Overlay — CSS aspect-ratio set inline to the EFFECTIVE
                target aspect so the on-screen shape matches the
                target (square targets give square overlays
                regardless of imgbox aspect). The widthFrac/heightFrac
                are derived from scale × maxFitFrac at the target
                aspect; the browser uses aspectRatio to enforce the
                final on-screen aspect. */}
            {editorOverlayLayout && (
              <div
                className="jr-batch-overlay"
                style={{
                  left:        `${editorOverlayLayout.leftFrac * 100}%`,
                  top:         `${editorOverlayLayout.topFrac  * 100}%`,
                  width:       `${editorOverlayLayout.widthFrac * 100}%`,
                  height:      `${editorOverlayLayout.heightFrac * 100}%`,
                  aspectRatio: editorOverlayLayout.aspectRatio,
                }}
              >
                {['tl', 'tr', 'bl', 'br'].map((corner) => (
                  <div
                    key={corner}
                    className={`jr-batch-handle jr-batch-handle--${corner}`}
                    onMouseDown={(e) => onResizeHandleMouseDown(e, corner)}
                    role="button"
                    aria-label={`Resize from ${corner.toUpperCase()} corner`}
                    title="Drag to resize (aspect locked)"
                  />
                ))}
              </div>
            )}
          </div>
          <div className="jr-batch-editor-hint">
            {!targetSizeReady ? 'Cropping disabled — target size could not be resolved'
              : isApplying ? 'Cropping in progress…'
              : 'Drag the rectangle to move it • drag a corner handle to resize (aspect locked)'}
          </div>
        </div>

        <div className="jr-batch-grid">
          {images.map((img, idx) => (
            <BatchThumbItem
              key={img.filename}
              image={img}
              jobPath={jobPath}
              spec={spec}
              sizeOption={sizeOption}
              orientation={orientation}
              targetSizeReady={targetSizeReady}
              isCurrentInProgress={isApplying && progress?.current === img.filename}
              onOpenFocused={() => {
                if (isApplying) return;
                setFocusedIndex(idx);
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Bottom bar: status / errors + Send to Print ───────────────────── */}
      <div className="jr-batch-bottombar">
        <div className="jr-batch-bottombar-status">
          {batchSummary ? (
            <div className={'jr-batch-summary' + (batchSummary.failed > 0 ? ' has-errors' : '')}>
              <span>{batchSummary.succeeded} cropped</span>
              {batchSummary.failed > 0 && <span>, {batchSummary.failed} failed</span>}
              {batchSummary.skipped > 0 && <span>, {batchSummary.skipped} skipped</span>}
              {batchSummary.aborted && (
                <span title={`Aborted after ${batchSummary.aborted.count} consecutive ${batchSummary.aborted.errorCode}`}>
                  {' '}— aborted ({batchSummary.aborted.reason})
                </span>
              )}
              {errors.length > 0 && (
                <details className="jr-batch-error-details">
                  <summary>{errors.length} failure{errors.length === 1 ? '' : 's'} — show details</summary>
                  <ul>
                    {errors.map((e, i) => (
                      <li key={i}><code>{e.filename}</code>: {e.error}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : (
            <div className="jr-batch-status">
              {allCropped ? 'All images cropped — ready to send to print'
                          : isApplying ? `Cropping ${progress?.current || ''}…`
                                       : `${uncroppedImages.length} image${uncroppedImages.length === 1 ? '' : 's'} awaiting crop`}
            </div>
          )}
          {sendToPrintError && (
            <div className="jr-batch-send-error" role="alert">Send to Print failed: {sendToPrintError}</div>
          )}
        </div>

        <button
          type="button"
          className="jr-batch-send-to-print"
          disabled={!canSendToPrint}
          onClick={onSendToPrint}
          title={
            isSendingToPrint           ? 'Sending…'
            : uncroppedImages.length > 0 ? `Crop all images before sending (${uncroppedImages.length} remaining)`
            : !ohJobId                   ? 'Job ID not available'
            : 'Dispatch this job to the print controller'
          }
        >
          {isSendingToPrint ? 'Sending…' : 'Send to Print'}
        </button>
      </div>

      {/* M5c (2026-05-26): focused per-image override overlay.
          Mounted on top of the batch body when focusedIndex is set
          (thumbnail click). Steals keyboard input; the drawer's
          arrow-nav suppression is wired via onFocusedFrameChange
          below — parent (JobReviewDrawer) reads the prop to drive
          its focusedFrameOpen ref so the drawer-level handler
          early-returns while this is mounted. */}
      {focusedIndex !== null && (
        <FocusedCropFrame
          images={images}
          sidecar={sidecar}
          initialIndex={focusedIndex}
          jobPath={jobPath}
          ohJobId={ohJobId}
          sizeOption={targetSize?.ok ? targetSize.sizeOption : null}
          onExit={() => setFocusedIndex(null)}
          onApplied={(updated) => {
            if (typeof onBatchApplied === 'function') onBatchApplied(updated);
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-image thumbnail with a read-only overlay rect rendered at the
 * TARGET aspect — NOT the source thumbnail's aspect. Each thumb
 * measures its own image's natural aspect and computes its own
 * overlay layout via specToOverlayLayout, so the overlay shape
 * matches the target (square for 8×8, landscape for 4×6 landscape,
 * etc.) regardless of the source's aspect.
 */
function BatchThumbItem({
  image, jobPath, spec, sizeOption, orientation,
  targetSizeReady, isCurrentInProgress,
  // M5c (2026-05-26): click handler opens focused mode for this thumb.
  // When undefined, the thumb stays click-inert (degrade gracefully).
  onOpenFocused,
}) {
  const src = `file:///${jobPath.replace(/\\/g, '/')}/working/${image.filename}`;
  const isCropped = image.cropApplied === true;
  const [thumbAspect, setThumbAspect] = useState(1);
  const overlayLayout = (targetSizeReady && !isCropped && sizeOption)
    ? specToOverlayLayout(spec, sizeOption, orientation, thumbAspect)
    : null;
  return (
    <div
      className={
        'jr-batch-thumb'
        + (isCropped ? ' is-cropped' : '')
        + (isCurrentInProgress ? ' is-current' : '')
        + (onOpenFocused ? ' is-clickable' : '')
      }
      title={onOpenFocused ? `${image.filename} (click to focus + re-crop)` : image.filename}
      onClick={onOpenFocused}
      role={onOpenFocused ? 'button' : undefined}
      tabIndex={onOpenFocused ? 0 : undefined}
      onKeyDown={onOpenFocused ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenFocused(); }
      } : undefined}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setThumbAspect(img.naturalWidth / img.naturalHeight);
          }
        }}
      />
      {overlayLayout && (
        <div
          className="jr-batch-thumb-overlay"
          style={{
            left:        `${overlayLayout.leftFrac * 100}%`,
            top:         `${overlayLayout.topFrac  * 100}%`,
            width:       `${overlayLayout.widthFrac * 100}%`,
            height:      `${overlayLayout.heightFrac * 100}%`,
            aspectRatio: overlayLayout.aspectRatio,
          }}
        />
      )}
      {isCropped && <div className="jr-batch-thumb-check" aria-label="Cropped">✓</div>}
      <div className="jr-batch-thumb-name">{image.filename}</div>
    </div>
  );
}

function targetSizeReasonText(reason) {
  switch (reason) {
    case 'unrouted':            return 'Assign a route first';
    case 'no-size-translation': return 'No size translation';
    case 'no-channel':          return 'No channel mapping';
    case 'pdf-or-folder-copy':  return 'Route has no print size';
    case 'job-not-cached':      return 'Job not in cache — refresh';
    case 'no-job-id':           return 'Missing job id';
    case 'error':               return "Couldn't resolve target size — check route assignment";
    case 'no-job':              return 'Job not provided';
    default:                    return 'Unknown';
  }
}
