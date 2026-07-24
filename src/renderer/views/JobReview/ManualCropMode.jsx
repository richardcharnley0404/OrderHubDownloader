import { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { CropEditor } from './CropEditor.jsx';
import { CropThumbRail } from './CropThumbRail.jsx';
import { ImageInfoStrip } from './ImageInfoStrip.jsx';
import { bestFitOrientation } from '../../../shared/cropRectMath.js';

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
 * Rect-equality with ±2px tolerance per axis. Used by the reducer to
 * distinguish "CropEditor echoed the seed value via onCropRectChange"
 * from real operator drags. Tolerance is small because CropEditor's
 * drag handler Math.rounds to integers (CropEditor.jsx:360) — pure
 * seed-echo lands at exact equality. The tolerance is purely belt-and-
 * braces against floating-point noise during the round-trip.
 */
function rectsApproxEqual(a, b, tol = 2) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol
      && Math.abs(a.y - b.y) <= tol
      && Math.abs(a.w - b.w) <= tol
      && Math.abs(a.h - b.h) <= tol;
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
      // Manual Crop redesign (2026-06-02). Operator-driven flag persisted
      // to sidecar. Discarded images are excluded from progress counts,
      // Send to Print's gate, and the print pipeline. Strict === true so
      // hydration is robust against legacy sidecars without the field.
      discarded:             img.discarded === true,
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
      const { filename, cropRect, isSeedEcho } = action;
      const curr = state[filename];
      if (!curr) return state;
      // Discarded images short-circuit operator actions — drag has no
      // meaning until the operator restores the image first.
      if (curr.discarded) return state;
      // Suppress the modified-flip ONLY when this dispatch represents
      // CropEditor's seed-echo on first mount for the current image
      // visit AND the echoed rect matches the on-disk applied rect.
      // Operator drags (isSeedEcho=false) always flip modified, even
      // drag-back-to-original — operator action is the trigger, not
      // value equality. The isSeedEcho flag is owned by onCropRectChange
      // below: it's true exactly once per image visit, then false until
      // currentFilename changes again.
      const isSeedMatchingApplied = isSeedEcho
        && curr.cropAppliedOnDisk
        && rectsApproxEqual(cropRect, curr.appliedCropRect);
      return {
        ...state,
        [filename]: {
          ...curr,
          pendingCropRect:       cropRect,
          // Drag on an approved image flips it to modified-needs-re-approve.
          // Drag on a fresh image stays pending (no modified flag).
          // Seed-echo of an approved image's applied rect stays unmodified.
          modifiedSinceApproval: curr.cropAppliedOnDisk && !isSeedMatchingApplied,
          applyError:            null,
        },
      };
    }

    case 'UPDATE_ROTATION': {
      const { filename, rotation } = action;
      const curr = state[filename];
      if (!curr) return state;
      if (curr.discarded) return state;
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
      if (curr.discarded) return state;
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
      if (curr.discarded) return state;
      return {
        ...state,
        [action.filename]: { ...curr, applying: true, applyError: null },
      };
    }

    case 'DISCARD_IMAGE': {
      const curr = state[action.filename];
      if (!curr) return state;
      // Manual Crop redesign (2026-06-02). Mark discarded + clear pending
      // edits (they're meaningless on a discarded image). cropApplied /
      // appliedCropRect are LEFT INTACT so restore brings back the prior
      // approval state exactly.
      return {
        ...state,
        [action.filename]: {
          ...curr,
          discarded:             true,
          pendingCropRect:       null,
          pendingRotation:       0,
          pendingOrientation:    null,
          modifiedSinceApproval: false,
          applyError:            null,
        },
      };
    }

    case 'RESTORE_IMAGE': {
      const curr = state[action.filename];
      if (!curr) return state;
      // Restore is a pure inverse — only the `discarded` flag flips.
      // cropApplied / appliedCropRect / cropAppliedOnDisk are exactly
      // what they were at the moment of discard, so the rail thumb
      // returns to its prior state (approved / pending / etc.).
      return {
        ...state,
        [action.filename]: {
          ...curr,
          discarded: false,
        },
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

/** Find the next image index whose state isn't approved-and-unmodified
 *  AND isn't discarded. `justActedFilename` is excluded because the
 *  dispatch hasn't propagated yet inside an Approve / Discard callback.
 *  Returns -1 when nothing remains. */
function findNextUnapproved(startIdx, images, perImageState, justActedFilename) {
  for (let i = startIdx + 1; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    if (img.filename === justActedFilename) continue;
    const st = perImageState[img.filename] || {};
    if (st.discarded) continue;
    if (!st.cropAppliedOnDisk || st.modifiedSinceApproval) return i;
  }
  return -1;
}

export default function ManualCropMode({
  sidecar,
  images,
  jobPath,
  ohJobId,
  // 2026-07-24 UI-standardisation — passed through to the ImageInfoStrip
  // below the CropStage preview and to CropThumbRail's per-thumb ScoreDot.
  // Threshold is owned by useJobReview in index.jsx; the manual view was
  // already receiving the same images array with per-frame aiQuality
  // blocks, this prop just gives it the operator's current threshold.
  aiQualityThreshold,
  onBatchApplied,
  onExit,
  onSentToPrint,
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

  // 2026-07-23 — Per-image natural-size cache. Populated by CropEditor's
  // onNaturalSize callback for whichever image is on the stage; used by
  // CropStage to seed the toggle's per-image best-fit orientation
  // (auto-orientation feature). Replaces the pre-2026-07-23 sessionOrientation
  // memory: orientation is now purely per-image — a toggle on one image
  // NEVER propagates to others. See docs/manual-crop-best-fit-orientation.md.
  const [naturalByFilename, setNaturalByFilename] = useState({});

  // ── Refs for unmount-time flush ──────────────────────────────────────────
  const perImageStateRef = useRef(perImageState);
  const sidecarRef       = useRef(sidecar);
  const imagesRef        = useRef(images);
  const jobPathRef       = useRef(jobPath);
  // Per-image-visit flag — true until the first onCropRectChange fires
  // for the current image. The first emission after image switch (or
  // initial mount) is CropEditor's seed-echo; subsequent emissions are
  // operator drags. Resets in the currentFilename effect below.
  // Rotation/orientation toggles do NOT reset this — those are operator
  // actions, so any post-toggle re-emit should flip modified normally.
  const seedAbsorbedRef = useRef(false);
  useEffect(() => { perImageStateRef.current = perImageState; }, [perImageState]);
  useEffect(() => { sidecarRef.current       = sidecar;       }, [sidecar]);
  useEffect(() => { imagesRef.current        = images;        }, [images]);
  useEffect(() => { jobPathRef.current       = jobPath;       }, [jobPath]);

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
    // Reset the seed-echo flag so the next onCropRectChange (CropEditor's
    // post-load seed emission for the new image) gets treated as a seed,
    // not an operator drag.
    seedAbsorbedRef.current = false;
  }, [currentFilename]);

  // ── Counts derived from perImageState ────────────────────────────────────
  //
  // Discarded images are excluded from BOTH numerator and denominator —
  // "X / Y approved" reads as "approved out of intent-to-print." A 40-
  // image job with 4 discarded + 36 approved displays "36 / 36 approved"
  // and Send to Print enables (everything the operator wants to print
  // IS printable). nonDiscardedCount > 0 guards the edge case "operator
  // discarded everything" — Send to Print should NOT enable on the
  // vacuously-true "every (zero) image approved."
  const totalCount         = images.length;
  const discardedCount     = images.reduce((n, img) => (
    n + (perImageState[img.filename]?.discarded ? 1 : 0)
  ), 0);
  const nonDiscardedCount  = totalCount - discardedCount;
  const approvedCount      = images.reduce((n, img) => {
    const st = perImageState[img.filename] || {};
    if (st.discarded) return n;
    return n + ((st.cropAppliedOnDisk && !st.modifiedSinceApproval) ? 1 : 0);
  }, 0);
  const allApproved = nonDiscardedCount > 0 && approvedCount === nonDiscardedCount;

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
    // 2026-07-23 — pure per-image dispatch. Deliberately does NOT
    // propagate to session/other images; each image auto-orients from
    // its own aspect via naturalByFilename + bestFitOrientation.
    dispatch({ type: 'UPDATE_ORIENTATION', filename: currentFilename, orientation });
  }, [currentFilename]);

  // Stable per-image onNaturalSize callback fed into CropEditor. Fires
  // once per image visit (and again on rotation flip). Bound to the
  // currently-mounted stage image so we never write a race-condition
  // entry against the wrong filename.
  const onStageNaturalSize = useCallback((w, h) => {
    if (!currentFilename) return;
    setNaturalByFilename((prev) => {
      const existing = prev[currentFilename];
      if (existing && existing.w === w && existing.h === h) return prev;
      return { ...prev, [currentFilename]: { w, h } };
    });
  }, [currentFilename]);

  // ── CropEditor → reducer bridge ──────────────────────────────────────────
  //
  // The first emission per image visit is CropEditor's seed-echo (just
  // after image load and the cropRect-init effect). Flag it so the
  // reducer can suppress the modified-flip when the seed equals the
  // already-applied rect. Subsequent emissions are operator drags and
  // always flip modified — including drag-back-to-original-position.
  const onCropRectChange = useCallback((rect) => {
    if (!currentFilename || !isValidRect(rect)) return;
    const isSeedEcho = !seedAbsorbedRef.current;
    seedAbsorbedRef.current = true;
    dispatch({
      type:       'UPDATE_PENDING_CROP_RECT',
      filename:   currentFilename,
      cropRect:   rect,
      isSeedEcho,
    });
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

    // 2026-07-23 — resolve the per-image orientation that shaped this
    // rect so the sidecar records reality. Priority mirrors approveAll:
    // operator's explicit pendingOrientation → best-fit from the natural
    // size (cached by onStageNaturalSize when the image loaded) → derive
    // from the rect's own w/h. sizeOption may be null pre-resolve; guard
    // for that even though the Approve button is gated on !targetSizeReady.
    const targetOrient = sizeOption && (sizeOption.w / sizeOption.h) >= 1 ? 'landscape' : 'portrait';
    const natural = naturalByFilename[filename] || null;
    const resolvedOrientation = st.pendingOrientation
      ?? (natural
          ? bestFitOrientation(natural.w, natural.h, targetOrient)
          : bestFitOrientation(rect.w, rect.h, targetOrient));

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
        cropOrientation:  resolvedOrientation,
        // Re-cropping an already-approved image must source from the
        // pristine /originals/<filename>, not /working/ which holds
        // the previous crop's output. 'originals' is also safe for
        // first crops because /originals/ and /working/ hold identical
        // bytes at job:load (both seeded by ensureWorkingSetup).
        sourceFrom:       'originals',
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
  }, [currentImage, ohJobId, onBatchApplied, selectedIndex, sizeOption, naturalByFilename]);

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

  // ── Approve All ────────────────────────────────────────────────────────
  //
  // Manual Crop redesign (2026-06-02). Per-image bulk-approve. Iterates
  // every image where !discarded && (!cropAppliedOnDisk || modified) and
  // for each calls jobCropImage with sourceFrom='originals'. Per-image
  // rect resolution: pendingCropRect when set (operator-edited), auto-
  // fit at target aspect otherwise (operator visited but didn't drag,
  // or never visited at all). Sequential to mirror the per-image
  // contract and avoid sharp/libvips concurrency issues.
  //
  // Replaces the M5b "Apply Default to All" which projected the current
  // image's rect via a shared fractional spec across all targets — that
  // model didn't honour per-image pending state and produced
  // identical crops on every image regardless of content.
  const [isApprovingAll,    setIsApprovingAll]    = useState(false);
  const [approveAllErrors,  setApproveAllErrors]  = useState([]); // {filename, error}[]
  const approveAll = useCallback(async () => {
    if (isApprovingAll || currentState.applying || !targetSizeReady) return;

    const candidates = imagesRef.current.filter((img) => {
      const s = perImageStateRef.current[img.filename] || {};
      if (s.discarded) return false;
      return !s.cropAppliedOnDisk || s.modifiedSinceApproval;
    });
    if (candidates.length === 0) return;

    // eslint-disable-next-line no-console
    console.info('[manual-crop] Approve All starting', {
      candidateCount:  candidates.length,
      totalImages:     imagesRef.current.length,
      discardedCount:  imagesRef.current.filter((i) => perImageStateRef.current[i.filename]?.discarded).length,
    });

    setIsApprovingAll(true);
    setApproveAllErrors([]);
    const errors = [];

    const targetAspect      = sizeOption.w / sizeOption.h;
    const targetOrientation = targetAspect >= 1 ? 'landscape' : 'portrait';

    for (const img of candidates) {
      const filename = img.filename;
      const st       = perImageStateRef.current[filename] || {};

      // Belt-and-braces. The candidate filter above already excludes
      // discarded; this re-check catches any state-divergence bug where
      // the snapshot read in the filter pass disagrees with what the
      // ref says right now (rare — would mean the discarded flag was
      // cleared mid-loop, which the reducer doesn't do). Skipping +
      // logging is the safest response — preserves operator intent
      // without crashing.
      if (st.discarded) {
        // eslint-disable-next-line no-console
        console.warn('[manual-crop] Approve All: skipping discarded image that passed the candidate filter', { filename });
        continue;
      }

      let rect                = isValidRect(st.pendingCropRect) ? st.pendingCropRect : null;
      let resolvedOrientation = st.pendingOrientation || null; // fill in below when we have dims

      if (!rect) {
        // Auto-fit at target aspect against the pristine /originals/ source.
        // Off-DOM Image() to read natural dims; same pattern the old
        // applyDefaultToAll used.
        const srcUrl = `file:///${jobPathRef.current.replace(/\\/g, '/')}/originals/${filename}`;
        let dims;
        try {
          dims = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload  = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => reject(new Error('image load failed'));
            im.src = srcUrl;
          });
        } catch (err) {
          errors.push({ filename, error: 'image load failed for auto-fit' });
          continue;
        }
        if (!dims.w || !dims.h) {
          errors.push({ filename, error: 'image has zero dimensions' });
          continue;
        }
        // 2026-07-23 per-image best-fit. Operator's pendingOrientation
        // wins; otherwise auto-pick from THIS image's own aspect, falling
        // back to the target's natural orientation for square sources.
        // No cross-image propagation.
        if (!resolvedOrientation) {
          resolvedOrientation = bestFitOrientation(dims.w, dims.h, targetOrientation);
        }
        // Effective aspect respects the resolved orientation (square
        // sizes fall through to landscape — toggle is suppressed in
        // CropStage for square).
        const effAspect = resolvedOrientation === 'landscape'
          ? Math.max(targetAspect, 1 / targetAspect)
          : Math.min(targetAspect, 1 / targetAspect);
        const { w: iw, h: ih } = dims;
        let cw, ch;
        if (iw / ih > effAspect) {
          ch = ih;
          cw = ch * effAspect;
        } else {
          cw = iw;
          ch = cw / effAspect;
        }
        const cx = (iw - cw) / 2;
        const cy = (ih - ch) / 2;
        rect = {
          x: Math.round(cx), y: Math.round(cy),
          w: Math.round(cw), h: Math.round(ch),
        };
      } else if (!resolvedOrientation) {
        // Operator has a pending rect but never set pendingOrientation
        // explicitly — derive orientation from the rect's own shape so
        // the sidecar records what actually got applied. Square rect
        // falls back to targetOrientation.
        resolvedOrientation = bestFitOrientation(rect.w, rect.h, targetOrientation);
      }

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
          // 2026-07-23 — persist the per-image orientation that actually
          // shaped this crop so the sidecar records reality even for
          // fresh images (no self-heal-from-rect-shape needed later).
          cropOrientation:  resolvedOrientation,
          sourceFrom:       'originals',
        });
        if (result && result.success) {
          const updatedImg = result.sidecar.images.find((i) => i.filename === filename);
          dispatch({
            type:        'APPLY_SUCCESS',
            filename,
            newCropRect: updatedImg ? updatedImg.cropRect : rect,
          });
          if (typeof onBatchApplied === 'function') onBatchApplied(result.sidecar);
        } else {
          const errMsg = (result && result.error) || 'Crop failed';
          dispatch({ type: 'APPLY_ERROR', filename, error: errMsg });
          errors.push({ filename, error: errMsg });
        }
      } catch (err) {
        const errMsg = err && err.message ? err.message : String(err);
        dispatch({ type: 'APPLY_ERROR', filename, error: errMsg });
        errors.push({ filename, error: errMsg });
      }
    }

    setApproveAllErrors(errors);
    setIsApprovingAll(false);
  }, [isApprovingAll, currentState.applying, targetSizeReady, sizeOption, ohJobId, onBatchApplied]);

  // ── Discard / Restore ──────────────────────────────────────────────────
  //
  // Manual Crop redesign (2026-06-02). Toggles the operator's `discarded`
  // flag on the current image and persists to sidecar. Optimistic
  // dispatch first, then IPC; on persist failure, revert via the
  // inverse action so the in-memory state matches what's on disk.
  // Auto-advance on discard (mirrors approveAndAdvance) so the operator's
  // hand stays moving forward.
  const discardCurrent = useCallback(async () => {
    if (!currentImage) return;
    const filename = currentImage.filename;
    const wasIndex = selectedIndex;
    dispatch({ type: 'DISCARD_IMAGE', filename });
    try {
      const result = await window.electronAPI.jobSetImageDiscarded({
        jobPath:   jobPathRef.current,
        sidecar:   sidecarRef.current,
        filename,
        discarded: true,
      });
      if (!result || !result.success) throw new Error((result && result.error) || 'discard persist failed');
      if (typeof onBatchApplied === 'function') onBatchApplied(result.sidecar);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[manual-crop] discard persist failed; reverting', err);
      dispatch({ type: 'RESTORE_IMAGE', filename });
      return;
    }
    const nextIdx = findNextUnapproved(wasIndex, imagesRef.current, perImageStateRef.current, filename);
    if (nextIdx >= 0) setSelectedIndex(nextIdx);
  }, [currentImage, selectedIndex, onBatchApplied]);

  const restoreCurrent = useCallback(async () => {
    if (!currentImage) return;
    const filename = currentImage.filename;
    dispatch({ type: 'RESTORE_IMAGE', filename });
    try {
      const result = await window.electronAPI.jobSetImageDiscarded({
        jobPath:   jobPathRef.current,
        sidecar:   sidecarRef.current,
        filename,
        discarded: false,
      });
      if (!result || !result.success) throw new Error((result && result.error) || 'restore persist failed');
      if (typeof onBatchApplied === 'function') onBatchApplied(result.sidecar);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[manual-crop] restore persist failed; reverting', err);
      dispatch({ type: 'DISCARD_IMAGE', filename });
    }
  }, [currentImage, onBatchApplied]);

  // ── Send to Print ────────────────────────────────────────────────────────
  const [isSendingToPrint, setIsSendingToPrint] = useState(false);
  const [sendToPrintError, setSendToPrintError] = useState(null);
  const canSendToPrint = !isSendingToPrint && !isApprovingAll && allApproved && !!ohJobId;
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
        exitDisabled={isApprovingAll || currentState.applying || isSendingToPrint}
      />

      <div className="jr-crop-approval__body">
        <CropThumbRail
          images={images}
          jobPath={jobPath}
          selectedIndex={selectedIndex}
          perImageState={perImageState}
          targetSizeReady={targetSizeReady}
          aiQualityThreshold={aiQualityThreshold}
          onSelect={setSelectedIndex}
        />

        {currentImage ? (
          <CropStage
            image={stageImage}
            jobPath={jobPath}
            sizeOption={sizeOption}
            targetSizeReady={targetSizeReady}
            state={currentState}
            aiQualityThreshold={aiQualityThreshold}
            naturalSize={currentFilename ? (naturalByFilename[currentFilename] || null) : null}
            selectedIndex={selectedIndex}
            totalCount={totalCount}
            stageImgLoaded={stageImgLoaded}
            onCropRectChange={onCropRectChange}
            onImgLoadedChange={setStageImgLoaded}
            onNaturalSize={onStageNaturalSize}
            onRotate={rotateBy}
            onSetOrientation={setOrientation}
            onApproveAndAdvance={approveAndAdvance}
            onNavigate={navigate}
            onDiscard={discardCurrent}
            onRestore={restoreCurrent}
            onApproveAll={approveAll}
            isApprovingAll={isApprovingAll}
            approveAllEnabled={
              !isApprovingAll
              && !currentState.applying
              && targetSizeReady
              && images.some((img) => {
                const s = perImageState[img.filename] || {};
                if (s.discarded) return false;
                return !s.cropAppliedOnDisk || s.modifiedSinceApproval;
              })
            }
          />
        ) : (
          <div className="jr-crop-stage jr-crop-stage--empty">No images to crop</div>
        )}
      </div>

      <ManualCropBottomBar
        approvedCount={approvedCount}
        nonDiscardedCount={nonDiscardedCount}
        discardedCount={discardedCount}
        approveAllErrors={approveAllErrors}
        sendToPrintEnabled={canSendToPrint}
        sendToPrintLabel={isSendingToPrint ? 'Sending…' : 'Send to Print'}
        sendToPrintError={sendToPrintError}
        onSendToPrint={onSendToPrint}
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
  aiQualityThreshold,
  naturalSize,
  selectedIndex, totalCount, stageImgLoaded,
  onCropRectChange, onImgLoadedChange, onNaturalSize,
  onRotate, onSetOrientation, onApproveAndAdvance, onNavigate,
  onDiscard, onRestore, onApproveAll, isApprovingAll, approveAllEnabled,
}) {
  const baseAspect = sizeOption ? sizeOption.w / sizeOption.h : 1;
  const isSquare   = !sizeOption || Math.abs(baseAspect - 1) < 0.001;
  // 2026-07-23 — per-image best-fit resolution chain (first non-null wins):
  //   pendingOrientation → operator deliberately flipped THIS image
  //   bestFit(naturalSize, targetOrientation) → THIS image's own aspect
  //   targetOrientation → transient fallback before dims are known
  //                       (square targets stay here since the toggle is
  //                        suppressed anyway).
  // No cross-image propagation — sessionOrientation was retired 2026-07-23
  // so a flip on image N never leaks onto N+1.
  const targetOrientation = baseAspect >= 1 ? 'landscape' : 'portrait';
  const orientation = state.pendingOrientation
    ?? (naturalSize
        ? bestFitOrientation(naturalSize.w, naturalSize.h, targetOrientation)
        : targetOrientation);

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
    && !state.applying
    && !state.discarded;
  // Delete / Restore button presentation flips on state.discarded.
  const deleteRestoreLabel    = state.discarded ? 'Restore' : 'Delete';
  const deleteRestoreOnClick  = state.discarded ? onRestore : onDiscard;
  const deleteRestoreDisabled = state.applying || isApprovingAll;
  const deleteRestoreTitle    = state.discarded
    ? 'Restore this image — recovers the prior approval state'
    : 'Discard this image — excluded from print, recoverable until you exit';

  return (
    <div className="jr-crop-stage">
      <header className="jr-crop-stage__topbar">
        <div className="jr-crop-stage__title">
          {/* Filename lives in the ImageInfoStrip below the CropEditor now
              (2026-07-24 UI-standardisation) — same info anchor in both
              review modes. This top-bar keeps just the counter + status
              badges + rotation label, alongside the orientation and
              rotation controls to the right. */}
          <span className="jr-focused-counter">{selectedIndex + 1} / {totalCount}</span>
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
          // Display the pristine /originals/<filename>, not /working/. Aligns
          // with sourceFrom='originals' on approveAndAdvance so the stage
          // shows the same coordinate space the saved cropRect was applied
          // to. First-time approvals also use /originals/ and that's fine —
          // /originals/ == /working/ at job:load via ensureWorkingSetup.
          folderName="originals"
          onCropRectChange={onCropRectChange}
          onImgLoadedChange={onImgLoadedChange}
          onNaturalSize={onNaturalSize}
          onApply={() => {}}
          onCancel={() => {}}
        />
      </div>

      {/* 2026-07-24 UI-standardisation — same info anchor as the
          standard mode carries under its main preview. Sits between
          the CropEditor and the per-image error / footer so filename
          + AI score + state chips are always in the operator's eye
          line while they crop. */}
      <ImageInfoStrip image={image} aiQualityThreshold={aiQualityThreshold} />

      {/* Per-image error strip — only renders when state.applyError is
          set. Footer below stays a clean 5-button row otherwise. */}
      {state.applyError && (
        <div className="jr-crop-stage__error-strip" role="alert">
          <span className="jr-focused-error">Apply failed: {state.applyError}</span>
        </div>
      )}

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

        {/* Manual Crop redesign (2026-06-02): Delete / Restore. Toggle
            label + handler based on state.discarded so a single button
            slot serves both directions. Destructive-action red treatment
            applies ONLY in the Delete direction — Restore is a recovery
            action and stays neutral. */}
        <button
          type="button"
          className={
            'jr-focused-nav-btn'
            + (!state.discarded ? ' jr-focused-nav-btn--destructive' : '')
          }
          onClick={deleteRestoreOnClick}
          disabled={deleteRestoreDisabled}
          title={deleteRestoreTitle}
        >
          {deleteRestoreLabel}
        </button>

        {/* Manual Crop redesign (2026-06-02): Approve All. Per-image
            bulk approve over !discarded && (!approved || modified).
            Replaces M5b's Apply Default to All. */}
        <button
          type="button"
          className="jr-focused-nav-btn"
          onClick={onApproveAll}
          disabled={!approveAllEnabled}
          title="Approve every non-discarded image that isn't already approved (uses each image's pending rect, or auto-fits at the target aspect if untouched)"
        >
          {isApprovingAll ? 'Approving…' : 'Approve All'}
        </button>

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
  approvedCount, nonDiscardedCount, discardedCount,
  approveAllErrors,
  sendToPrintEnabled, sendToPrintLabel, sendToPrintError, onSendToPrint,
}) {
  // Status text precedence:
  //   1. Send to Print failure (most recent IPC error)
  //   2. Approve All roll-up (per-image failures from the most recent run)
  //   3. Job-level progress hint (all-approved / N awaiting / all-discarded)
  let status;
  if (sendToPrintError) {
    status = <div className="jr-crop-approval__error" role="alert">Send to Print failed: {sendToPrintError}</div>;
  } else if (approveAllErrors && approveAllErrors.length > 0) {
    status = (
      <details className="jr-crop-approval__error">
        <summary>{approveAllErrors.length} image{approveAllErrors.length === 1 ? '' : 's'} failed to approve</summary>
        <ul>
          {approveAllErrors.map(({ filename, error }, i) => (
            <li key={`${filename}__${i}`}><code>{filename}</code>: {error}</li>
          ))}
        </ul>
      </details>
    );
  } else if (nonDiscardedCount === 0) {
    status = <div className="jr-crop-approval__hint">All images discarded — nothing to print</div>;
  } else if (approvedCount === nonDiscardedCount) {
    status = (
      <div className="jr-crop-approval__hint">
        All images approved — ready to send to print
        {discardedCount > 0 && ` (${discardedCount} discarded)`}
      </div>
    );
  } else {
    const awaiting = nonDiscardedCount - approvedCount;
    status = (
      <div className="jr-crop-approval__hint">
        {awaiting} image{awaiting === 1 ? '' : 's'} awaiting approval
        {discardedCount > 0 && ` (${discardedCount} discarded)`}
      </div>
    );
  }

  return (
    <div className="jr-crop-approval__bottombar">
      <div className="jr-crop-approval__bottombar-status">{status}</div>

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
