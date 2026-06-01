import { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { CropEditor } from './CropEditor.jsx';
import { CropThumbRail } from './CropThumbRail.jsx';

/**
 * src/renderer/views/JobReview/ManualCropMode.jsx
 *
 * Manual Crop redesign (2026-06-01) — renamed from BatchCropMode.
 *
 * Per-image-first cropping workflow for manual-source jobs:
 *   - Left rail (CropThumbRail) shows every image with its own state badge
 *   - Centre stage shows the selected image in a per-image CropEditor with
 *     inlined chrome (was FocusedCropFrame as a modal; now always-on)
 *   - Operator drags / rotates / orients / approves each image individually
 *   - "Apply Default to All" stays as a secondary convenience (seeds the
 *     current image's spec across all unapproved-and-unmodified images
 *     and runs jobBatchCropApply on them)
 *   - Send to Print gated on every image being approved-and-unmodified
 *
 * State ownership:
 *   perImageState  Record<filename, ImageState> — reducer-managed.
 *                  Sources of truth:
 *                    pendingCropRect/Rotation/Orientation → sidecar (persistent)
 *                    cropAppliedOnDisk/appliedCropRect    → derived from sidecar
 *                    modifiedSinceApproval/applying/applyError → local only
 *   selectedIndex  number — which image the stage is editing
 *   targetSize     resolved once via ohd:job:resolve-target-size; same as
 *                  pre-redesign BatchCropMode
 *
 * Persistence:
 *   On unmount (drawer close / batch-mode exit), fire-and-forget
 *   jobSavePendingCrops with any non-empty pending state. Approved state
 *   already lives on disk via jobCropImage; only the in-progress drags
 *   need draining.
 *
 * Keyboard (stage-owned, document-level listener):
 *   [ / ]         prev / next image
 *   R / →         rotate +90° CW
 *   L / ←         rotate -90° CCW
 *   Enter / Space approve current image + auto-advance to next unapproved
 *
 * Props:
 *   sidecar             object         Current sidecar
 *   images              ImageEntry[]   sidecar.images
 *   jobPath             string         absolute job folder
 *   ohJobId             string|null    OrderHub numeric job ID
 *   onBatchApplied      (sidecar)      after IPC returns; renderer reloads state
 *   onExit              ()             caller exits batch mode (collapses to standard)
 *   onSentToPrint       ()             optional — fires after Send-to-Print success
 *   onFocusedFrameChange(boolean)      drawer-level arrow-nav suppression flag.
 *                                      ManualCropMode signals `true` on mount,
 *                                      `false` on unmount. Phase 4 of the redesign
 *                                      will replace this with an in-drawer
 *                                      "in batch mode" check and remove the prop.
 */

const KNOWN_ROTATIONS = [0, 90, 180, 270];

function normaliseRotation(value) {
  if (!Number.isFinite(value)) return 0;
  const n = ((value % 360) + 360) % 360;
  return KNOWN_ROTATIONS.includes(n) ? n : 0;
}

function isValidRect(r) {
  return r
    && Number.isFinite(r.x) && Number.isFinite(r.y)
    && Number.isFinite(r.w) && Number.isFinite(r.h)
    && r.w > 0 && r.h > 0;
}

/**
 * Build perImageState from sidecar.images on mount. Handles three cases:
 *
 *   - Fresh entries (no pendingCropRect, !cropApplied): empty pending,
 *     not modified, not approved.
 *   - Legacy approved entries (cropApplied=true, no pending): approved,
 *     not modified. Reconcile D guarantees the pending* keys exist
 *     (as null), so we don't need defensive hasOwnProperty checks.
 *   - Mid-session resume (pendingCropRect set): operator's in-progress
 *     edits are restored. modifiedSinceApproval flips on iff the entry
 *     was already approved when those edits started (re-crop scenario).
 */
function hydrateInitialState(images) {
  const state = {};
  for (const img of images) {
    if (!img || !img.filename) continue;
    const cropAppliedOnDisk = img.cropApplied === true;
    const pendingCropRect   = isValidRect(img.pendingCropRect) ? { ...img.pendingCropRect } : null;
    const pendingOrientation = img.pendingOrientation === 'portrait' || img.pendingOrientation === 'landscape'
      ? img.pendingOrientation
      : null;
    state[img.filename] = {
      pendingCropRect,
      pendingRotation:       normaliseRotation(img.pendingRotation),
      pendingOrientation,
      cropAppliedOnDisk,
      appliedCropRect:       cropAppliedOnDisk && isValidRect(img.cropRect) ? { ...img.cropRect } : null,
      // Approved + has pending edits → modified-needs-re-approve.
      // Fresh entries with pending edits → just pending (not modified).
      modifiedSinceApproval: cropAppliedOnDisk && !!pendingCropRect,
      applying:              false,
      applyError:            null,
    };
  }
  return state;
}

/**
 * Reducer for perImageState. Each action targets a single filename
 * (BATCH_APPLY_SUCCESS being the exception — it mutates many in one shot).
 */
function perImageReducer(state, action) {
  switch (action.type) {
    case 'UPDATE_PENDING_CROP_RECT': {
      const { filename, cropRect } = action;
      const curr = state[filename];
      if (!curr) return state;
      return {
        ...state,
        [filename]: {
          ...curr,
          pendingCropRect:       cropRect,
          // Drag on an approved image flips it to modified-needs-re-approve.
          // Drag on a fresh image stays pending (no modified flag).
          modifiedSinceApproval: curr.cropAppliedOnDisk,
          applyError:            null,
        },
      };
    }

    case 'UPDATE_ROTATION': {
      const { filename, rotation } = action;
      const curr = state[filename];
      if (!curr) return state;
      return {
        ...state,
        [filename]: {
          ...curr,
          pendingRotation:       rotation,
          modifiedSinceApproval: curr.cropAppliedOnDisk,
          applyError:            null,
        },
      };
    }

    case 'UPDATE_ORIENTATION': {
      const { filename, orientation } = action;
      const curr = state[filename];
      if (!curr) return state;
      return {
        ...state,
        [filename]: {
          ...curr,
          pendingOrientation:    orientation,
          modifiedSinceApproval: curr.cropAppliedOnDisk,
          applyError:            null,
        },
      };
    }

    case 'APPLY_START': {
      const curr = state[action.filename];
      if (!curr) return state;
      return {
        ...state,
        [action.filename]: { ...curr, applying: true, applyError: null },
      };
    }

    case 'APPLY_SUCCESS': {
      const { filename, newCropRect } = action;
      const curr = state[filename];
      if (!curr) return state;
      // Pending state cleared because rotation/orientation are now baked
      // into the on-disk file; the canonical cropRect lives in
      // appliedCropRect from here on.
      return {
        ...state,
        [filename]: {
          ...curr,
          pendingCropRect:       null,
          pendingRotation:       0,
          pendingOrientation:    null,
          cropAppliedOnDisk:     true,
          appliedCropRect:       isValidRect(newCropRect) ? { ...newCropRect } : curr.appliedCropRect,
          modifiedSinceApproval: false,
          applying:              false,
          applyError:            null,
        },
      };
    }

    case 'APPLY_ERROR': {
      const curr = state[action.filename];
      if (!curr) return state;
      return {
        ...state,
        [action.filename]: { ...curr, applying: false, applyError: action.error },
      };
    }

    case 'BATCH_APPLY_SUCCESS': {
      // updates is { [filename]: cropRect } from the new sidecar's images
      const { updates } = action;
      const next = { ...state };
      for (const fn of Object.keys(updates)) {
        const curr = state[fn];
        if (!curr) continue;
        const rect = updates[fn];
        next[fn] = {
          ...curr,
          pendingCropRect:       null,
          pendingRotation:       0,
          pendingOrientation:    null,
          cropAppliedOnDisk:     true,
          appliedCropRect:       isValidRect(rect) ? { ...rect } : curr.appliedCropRect,
          modifiedSinceApproval: false,
          applying:              false,
          applyError:            null,
        };
      }
      return next;
    }

    default:
      return state;
  }
}

/** Find the next image index whose state isn't approved-and-unmodified.
 *  `justApprovedFilename` is excluded because dispatch hasn't propagated
 *  yet inside an Approve callback. Returns -1 when nothing remains. */
function findNextUnapproved(startIdx, images, perImageState, justApprovedFilename) {
  for (let i = startIdx + 1; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    if (img.filename === justApprovedFilename) continue;
    const st = perImageState[img.filename] || {};
    if (!st.cropAppliedOnDisk || st.modifiedSinceApproval) return i;
  }
  return -1;
}

export default function ManualCropMode({
  sidecar,
  images,
  jobPath,
  ohJobId,
  onBatchApplied,
  onExit,
  onSentToPrint,
  onFocusedFrameChange,
}) {
  // ── Target size resolution (unchanged from BatchCropMode) ────────────────
  const [targetSize, setTargetSize] = useState(null);
  useEffect(() => {
    if (!ohJobId) {
      setTargetSize({ ok: false, reason: 'no-job-id' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const all  = await window.electronAPI.getJobs();
        const list = all && all.jobs ? all.jobs : [];
        const job  = list.find((j) => String(j.id) === String(ohJobId));
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

  // ── perImageState + selection ────────────────────────────────────────────
  const [perImageState, dispatch] = useReducer(perImageReducer, images, hydrateInitialState);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const firstUnapproved = images.findIndex((i) => i && i.cropApplied !== true);
    return firstUnapproved >= 0 ? firstUnapproved : 0;
  });
  const [stageImgLoaded, setStageImgLoaded] = useState(false);

  // ── Refs for unmount-time flush ──────────────────────────────────────────
  const perImageStateRef = useRef(perImageState);
  const sidecarRef       = useRef(sidecar);
  const imagesRef        = useRef(images);
  const jobPathRef       = useRef(jobPath);
  useEffect(() => { perImageStateRef.current = perImageState; }, [perImageState]);
  useEffect(() => { sidecarRef.current       = sidecar;       }, [sidecar]);
  useEffect(() => { imagesRef.current        = images;        }, [images]);
  useEffect(() => { jobPathRef.current       = jobPath;       }, [jobPath]);

  // ── Drawer-level arrow-nav suppression ───────────────────────────────────
  //
  // The drawer (index.jsx:451) listens for ArrowLeft/ArrowRight to navigate
  // the standard-mode thumbnail grid. Since our stage owns those keys for
  // rotation, signal `true` on mount and `false` on unmount so the drawer's
  // handler early-returns while we're active. Phase 4 of the redesign
  // replaces this prop with an in-drawer "in batch mode" check.
  useEffect(() => {
    if (typeof onFocusedFrameChange !== 'function') return undefined;
    onFocusedFrameChange(true);
    return () => onFocusedFrameChange(false);
  }, [onFocusedFrameChange]);

  // ── Drain pending state on unmount ───────────────────────────────────────
  //
  // Fire-and-forget IPC. We don't await because cleanup runs synchronously
  // during React unmount. Failures are non-fatal (operator's in-progress
  // state lost on next open; approved state is intact on disk regardless).
  useEffect(() => {
    return () => {
      const state    = perImageStateRef.current;
      const imgs     = imagesRef.current;
      const sc       = sidecarRef.current;
      const jp       = jobPathRef.current;
      if (!state || !imgs || !sc || !jp) return;
      const updates = [];
      for (const img of imgs) {
        const st = state[img.filename];
        if (!st) continue;
        const hasPending =
          st.pendingCropRect != null
          || (st.pendingRotation != null && st.pendingRotation !== 0)
          || st.pendingOrientation != null;
        if (!hasPending) continue;
        updates.push({
          filename:           img.filename,
          pendingCropRect:    st.pendingCropRect,
          pendingRotation:    st.pendingRotation,
          pendingOrientation: st.pendingOrientation,
        });
      }
      if (updates.length === 0) return;
      window.electronAPI.jobSavePendingCrops({ jobPath: jp, sidecar: sc, updates })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[manual-crop] savePendingCrops on unmount failed', err);
        });
    };
  }, []);

  // ── Image-switch side effects ────────────────────────────────────────────
  const currentImage = images[selectedIndex] || null;
  const currentFilename = currentImage ? currentImage.filename : null;
  const currentState = currentFilename ? (perImageState[currentFilename] || {}) : {};

  useEffect(() => {
    // Reset the imgLoaded gate on image switch so the Approve button
    // re-disables until the new image's CropEditor reports loaded.
    setStageImgLoaded(false);
  }, [currentFilename]);

  // ── Counts derived from perImageState ────────────────────────────────────
  const totalCount = images.length;
  const approvedCount = images.reduce((n, img) => {
    const st = perImageState[img.filename] || {};
    return n + ((st.cropAppliedOnDisk && !st.modifiedSinceApproval) ? 1 : 0);
  }, 0);
  const allApproved = totalCount > 0 && approvedCount === totalCount;

  // ── Navigation ───────────────────────────────────────────────────────────
  const navigate = useCallback((delta) => {
    setSelectedIndex((curr) => {
      const next = curr + delta;
      if (next < 0 || next >= images.length) return curr;
      return next;
    });
  }, [images.length]);

  // ── Rotation / orientation handlers ──────────────────────────────────────
  const rotateBy = useCallback((delta) => {
    if (!currentFilename) return;
    const currRot = perImageState[currentFilename]?.pendingRotation || 0;
    const next    = normaliseRotation(currRot + delta);
    dispatch({ type: 'UPDATE_ROTATION', filename: currentFilename, rotation: next });
  }, [currentFilename, perImageState]);

  const setOrientation = useCallback((orientation) => {
    if (!currentFilename) return;
    dispatch({ type: 'UPDATE_ORIENTATION', filename: currentFilename, orientation });
  }, [currentFilename]);

  // ── CropEditor → reducer bridge ──────────────────────────────────────────
  const onCropRectChange = useCallback((rect) => {
    if (!currentFilename || !isValidRect(rect)) return;
    dispatch({ type: 'UPDATE_PENDING_CROP_RECT', filename: currentFilename, cropRect: rect });
  }, [currentFilename]);

  // ── Approve + Advance ────────────────────────────────────────────────────
  //
  // Calls jobCropImage for the single current image. Rotation is baked into
  // the production file via sharp.rotate(N).extract(rect). On success, the
  // reducer flips the image to approved and we auto-advance to the next
  // unapproved (or stay if none).
  const approveAndAdvance = useCallback(async () => {
    if (!currentImage) return;
    const filename = currentImage.filename;
    const st = perImageStateRef.current[filename];
    if (!st || st.applying) return;
    const rect = st.pendingCropRect;
    if (!isValidRect(rect)) return;

    dispatch({ type: 'APPLY_START', filename });
    try {
      const result = await window.electronAPI.jobCropImage({
        jobPath:          jobPathRef.current,
        sidecar:          sidecarRef.current,
        filename,
        cropRect:         rect,
        channelMappingId: null,
        darkroomSize:     null,
        ohJobId,
        cropRotation:     st.pendingRotation || 0,
      });
      if (result && result.success) {
        const updatedImg = result.sidecar.images.find((i) => i.filename === filename);
        dispatch({
          type:        'APPLY_SUCCESS',
          filename,
          newCropRect: updatedImg ? updatedImg.cropRect : rect,
        });
        if (typeof onBatchApplied === 'function') onBatchApplied(result.sidecar);
        const nextIdx = findNextUnapproved(selectedIndex, imagesRef.current, perImageStateRef.current, filename);
        if (nextIdx >= 0) setSelectedIndex(nextIdx);
      } else {
        dispatch({ type: 'APPLY_ERROR', filename, error: (result && result.error) || 'Crop failed' });
      }
    } catch (err) {
      dispatch({ type: 'APPLY_ERROR', filename, error: err && err.message ? err.message : String(err) });
    }
  }, [currentImage, ohJobId, onBatchApplied, selectedIndex]);

  // ── Keyboard handlers (document-level) ──────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;

      switch (e.key) {
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
          approveAndAdvance();
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, rotateBy, approveAndAdvance]);

  // ── Apply Default to All ────────────────────────────────────────────────
  //
  // Seeds the current image's rect across every image that isn't already
  // approved-and-unmodified, then runs jobBatchCropApply to bake the crops.
  // Per decisions: skip approved (no overwrite of operator's existing work)
  // AND skip approved-modified (operator's hand-edits are sacred —
  // they decided to re-crop that image specifically).
  //
  // The IPC takes a {centerX, centerY, scale} fractional spec, not a pixel
  // rect — so we project the current image's pendingCropRect to fractional
  // form against its natural dimensions, which the IPC then expands back to
  // pixel rects per target image at apply time.
  const [isApplyingDefault, setIsApplyingDefault] = useState(false);
  const [applyDefaultError,  setApplyDefaultError]  = useState(null);
  const applyDefaultToAll = useCallback(async () => {
    if (isApplyingDefault || !currentImage || !targetSizeReady) return;
    const st = perImageStateRef.current[currentImage.filename];
    // TODO (phase 6 verification): when the current image is approved-
    // and-unmodified, pendingCropRect is null and this early-returns.
    // The button is already disabled in that case via the
    // applyDefaultEnabled prop wiring below, but the protection here is
    // belt-and-braces. Consider falling back to st.appliedCropRect so
    // an operator can apply an already-approved image's rect as the
    // default to all others without first having to drag-then-undo.
    if (!st || !isValidRect(st.pendingCropRect)) return;

    // Skip approved-and-unmodified AND approved-modified — both are
    // operator-curated. Targets are only fresh-pending images.
    const targetFilenames = imagesRef.current
      .filter((img) => {
        const s = perImageStateRef.current[img.filename] || {};
        if (s.cropAppliedOnDisk) return false;
        return true;
      })
      .map((img) => img.filename);
    if (targetFilenames.length === 0) return;

    // Project pixel rect → fractional spec using the SOURCE image's natural
    // dims. The IPC re-projects per target. We measure the natural dims via
    // an off-DOM Image() to avoid touching CropEditor's internals.
    const sourceSrc = `file:///${jobPathRef.current.replace(/\\/g, '/')}/working/${currentImage.filename}`;
    let sourceDims;
    try {
      sourceDims = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload  = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => reject(new Error('source image failed to load for default-rect projection'));
        im.src = sourceSrc;
      });
    } catch (err) {
      setApplyDefaultError(err.message);
      return;
    }
    if (!sourceDims.w || !sourceDims.h) {
      setApplyDefaultError('source image has zero dimensions');
      return;
    }

    const rect = st.pendingCropRect;
    // {centerX, centerY, scale} where:
    //   centerX = (rect.x + rect.w/2) / srcW
    //   centerY = (rect.y + rect.h/2) / srcH
    //   scale   = rect.w / (maxFitW @ targetAspect, srcW × srcH)
    // applyBatchCrop fans this back to per-image pixel rects using each
    // target's own srcW × srcH. The scale is normalised against the
    // CURRENT source's maxFit so it transfers proportionally.
    const targetAspect = sizeOption.w / sizeOption.h;
    const sourceAspect = sourceDims.w / sourceDims.h;
    // maxFitW at the target aspect on the source image
    const maxFitW = sourceAspect > targetAspect ? sourceDims.h * targetAspect : sourceDims.w;
    const scale   = maxFitW > 0 ? rect.w / maxFitW : 0.95;
    const fractionalSpec = {
      centerX: (rect.x + rect.w / 2) / sourceDims.w,
      centerY: (rect.y + rect.h / 2) / sourceDims.h,
      scale,
    };
    const orientation = st.pendingOrientation || (targetAspect >= 1 ? 'landscape' : 'portrait');

    setIsApplyingDefault(true);
    setApplyDefaultError(null);
    try {
      const result = await window.electronAPI.jobBatchCropApply({
        jobPath:          jobPathRef.current,
        sidecar:          sidecarRef.current,
        filenames:        targetFilenames,
        fractionalSpec,
        sizeOption,
        orientation,
        channelMappingId: null,
        darkroomSize:     null,
        ohJobId,
      });
      if (result && result.sidecar) {
        // Build updates {filename: newCropRect} from the returned sidecar.
        const updates = {};
        for (const fn of result.succeeded || []) {
          const u = result.sidecar.images.find((i) => i.filename === fn);
          if (u && isValidRect(u.cropRect)) updates[fn] = u.cropRect;
        }
        dispatch({ type: 'BATCH_APPLY_SUCCESS', updates });
        if (typeof onBatchApplied === 'function') onBatchApplied(result.sidecar);
        if ((result.failed || []).length > 0) {
          setApplyDefaultError(`${result.failed.length} image${result.failed.length === 1 ? '' : 's'} failed`);
        }
      } else {
        setApplyDefaultError((result && result.error) || 'Apply Default failed');
      }
    } catch (err) {
      setApplyDefaultError(err && err.message ? err.message : String(err));
    } finally {
      setIsApplyingDefault(false);
    }
  }, [isApplyingDefault, currentImage, targetSizeReady, sizeOption, ohJobId, onBatchApplied]);

  // ── Send to Print ────────────────────────────────────────────────────────
  const [isSendingToPrint, setIsSendingToPrint] = useState(false);
  const [sendToPrintError, setSendToPrintError] = useState(null);
  const canSendToPrint = !isSendingToPrint && !isApplyingDefault && allApproved && !!ohJobId;
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

  // ── Stage seed: synthesise an image prop so CropEditor seeds from the
  // pending rect (if any) or the applied rect, falling back to auto-fit.
  // CropEditor only re-reads on imgLoaded, so this synthesised prop is
  // safe to recompute on every render.
  const stageSeedRect = currentState.pendingCropRect || currentState.appliedCropRect || null;
  const stageImage = currentImage
    ? { ...currentImage, cropRect: stageSeedRect || undefined }
    : null;

  return (
    <div className="jr-crop-approval">
      <ManualCropTopBar
        targetSize={targetSize}
        approvedCount={approvedCount}
        totalCount={totalCount}
        onExit={onExit}
        exitDisabled={isApplyingDefault || currentState.applying || isSendingToPrint}
      />

      <div className="jr-crop-approval__body">
        <CropThumbRail
          images={images}
          jobPath={jobPath}
          selectedIndex={selectedIndex}
          perImageState={perImageState}
          targetSizeReady={targetSizeReady}
          onSelect={setSelectedIndex}
        />

        {currentImage ? (
          <CropStage
            image={stageImage}
            jobPath={jobPath}
            sizeOption={sizeOption}
            targetSizeReady={targetSizeReady}
            state={currentState}
            selectedIndex={selectedIndex}
            totalCount={totalCount}
            stageImgLoaded={stageImgLoaded}
            onCropRectChange={onCropRectChange}
            onImgLoadedChange={setStageImgLoaded}
            onRotate={rotateBy}
            onSetOrientation={setOrientation}
            onApproveAndAdvance={approveAndAdvance}
            onNavigate={navigate}
          />
        ) : (
          <div className="jr-crop-stage jr-crop-stage--empty">No images to crop</div>
        )}
      </div>

      <ManualCropBottomBar
        applyDefaultEnabled={
          !isApplyingDefault
          && !currentState.applying
          && targetSizeReady
          && !!currentState.pendingCropRect
          && images.some((img) => {
            const s = perImageState[img.filename] || {};
            return !s.cropAppliedOnDisk;
          })
        }
        applyDefaultLabel={
          isApplyingDefault ? 'Applying default…' : 'Apply Default to All'
        }
        onApplyDefaultToAll={applyDefaultToAll}
        applyDefaultError={applyDefaultError}
        sendToPrintEnabled={canSendToPrint}
        sendToPrintLabel={isSendingToPrint ? 'Sending…' : 'Send to Print'}
        sendToPrintError={sendToPrintError}
        onSendToPrint={onSendToPrint}
        approvedCount={approvedCount}
        totalCount={totalCount}
      />
    </div>
  );
}

// ─── Inline children ──────────────────────────────────────────────────────────

function ManualCropTopBar({ targetSize, approvedCount, totalCount, onExit, exitDisabled }) {
  return (
    <div className="jr-crop-approval__topbar">
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
      <div className="jr-crop-approval__progress">
        {approvedCount} / {totalCount} approved
      </div>
      <button type="button" className="jr-batch-exit" onClick={onExit} disabled={exitDisabled}>
        Exit Batch
      </button>
    </div>
  );
}

function CropStage({
  image, jobPath, sizeOption, targetSizeReady, state,
  selectedIndex, totalCount, stageImgLoaded,
  onCropRectChange, onImgLoadedChange,
  onRotate, onSetOrientation, onApproveAndAdvance, onNavigate,
}) {
  const baseAspect = sizeOption ? sizeOption.w / sizeOption.h : 1;
  const isSquare   = !sizeOption || Math.abs(baseAspect - 1) < 0.001;
  const orientation = state.pendingOrientation
    ?? (baseAspect >= 1 ? 'landscape' : 'portrait');

  const rotation = state.pendingRotation || 0;
  const rotationLabel = rotation === 0 ? null
    : rotation === 90  ? '90° CW'
    : rotation === 180 ? '180°'
    : rotation === 270 ? '90° CCW'
    : `${rotation}°`;

  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex < totalCount - 1;
  const canApprove = stageImgLoaded
    && !!state.pendingCropRect
    && !state.applying;

  return (
    <div className="jr-crop-stage">
      <header className="jr-crop-stage__topbar">
        <div className="jr-crop-stage__title">
          <span className="jr-focused-counter">{selectedIndex + 1} / {totalCount}</span>
          <span className="jr-focused-filename" title={image.filename}>{image.filename}</span>
          {state.cropAppliedOnDisk && !state.modifiedSinceApproval && (
            <span className="jr-focused-cropped-badge" title="Approved on disk">approved</span>
          )}
          {state.cropAppliedOnDisk && state.modifiedSinceApproval && (
            <span className="jr-focused-cropped-badge jr-focused-cropped-badge--modified" title="Approved on disk but has unapproved edits — re-approve to commit">
              modified
            </span>
          )}
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
              onClick={() => onSetOrientation('portrait')}
              disabled={state.applying}
            >
              Portrait
            </button>
            <button
              type="button"
              className={'jr-orient-btn' + (orientation === 'landscape' ? ' is-active' : '')}
              onClick={() => onSetOrientation('landscape')}
              disabled={state.applying}
            >
              Landscape
            </button>
          </div>
        )}

        <div className="jr-focused-rotate-controls">
          <button
            type="button"
            className="jr-focused-rotate-btn"
            onClick={() => onRotate(-90)}
            disabled={state.applying}
            title="Rotate 90° CCW (L or ←)"
          >↺ L</button>
          <button
            type="button"
            className="jr-focused-rotate-btn"
            onClick={() => onRotate(90)}
            disabled={state.applying}
            title="Rotate 90° CW (R or →)"
          >↻ R</button>
        </div>
      </header>

      <div className="jr-crop-stage__body">
        <CropEditor
          // Force remount on image / rotation change so CropEditor's
          // internal cropRect + naturalSize re-seed from scratch.
          key={`${image.filename}__${rotation}`}
          image={image}
          jobPath={jobPath}
          sizeOption={sizeOption}
          imageRotation={rotation}
          hideOwnChrome
          controlledOrientation={orientation}
          onCropRectChange={onCropRectChange}
          onImgLoadedChange={onImgLoadedChange}
          onApply={() => {}}
          onCancel={() => {}}
        />
      </div>

      <footer className="jr-crop-stage__bottombar">
        <button
          type="button"
          className="jr-focused-nav-btn"
          onClick={() => onNavigate(-1)}
          disabled={!hasPrev || state.applying}
          title="Previous image ([)"
        >
          ← Prev
        </button>

        <div className="jr-crop-stage__status">
          {state.applying ? 'Applying crop…'
            : state.applyError ? <span className="jr-focused-error">Apply failed: {state.applyError}</span>
            : !targetSizeReady ? 'Resolving target size…'
            : !canApprove ? 'Drag rectangle to position • drag corners to resize'
            : 'Enter to approve + advance'}
        </div>

        <button
          type="button"
          className="jr-focused-apply"
          onClick={onApproveAndAdvance}
          disabled={!canApprove}
          title="Approve crop (Enter / Space)"
        >
          {state.applying ? 'Applying…' : (hasNext ? 'Approve + Next →' : 'Approve')}
        </button>

        <button
          type="button"
          className="jr-focused-nav-btn"
          onClick={() => onNavigate(+1)}
          disabled={!hasNext || state.applying}
          title="Next image (])"
        >
          Next →
        </button>
      </footer>
    </div>
  );
}

function ManualCropBottomBar({
  applyDefaultEnabled, applyDefaultLabel, onApplyDefaultToAll, applyDefaultError,
  sendToPrintEnabled, sendToPrintLabel, sendToPrintError, onSendToPrint,
  approvedCount, totalCount,
}) {
  return (
    <div className="jr-crop-approval__bottombar">
      <button
        type="button"
        className="jr-crop-approval__apply-default"
        onClick={onApplyDefaultToAll}
        disabled={!applyDefaultEnabled}
        title="Seed every unapproved image with the current crop and approve them all"
      >
        {applyDefaultLabel}
      </button>

      <div className="jr-crop-approval__bottombar-status">
        {applyDefaultError && (
          <div className="jr-crop-approval__error" role="alert">{applyDefaultError}</div>
        )}
        {sendToPrintError && (
          <div className="jr-crop-approval__error" role="alert">Send to Print failed: {sendToPrintError}</div>
        )}
        {!applyDefaultError && !sendToPrintError && (
          <div className="jr-crop-approval__hint">
            {approvedCount === totalCount
              ? 'All images approved — ready to send to print'
              : `${totalCount - approvedCount} image${totalCount - approvedCount === 1 ? '' : 's'} awaiting approval`}
          </div>
        )}
      </div>

      <button
        type="button"
        className="jr-crop-approval__send-to-print"
        disabled={!sendToPrintEnabled}
        onClick={onSendToPrint}
      >
        {sendToPrintLabel}
      </button>
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
