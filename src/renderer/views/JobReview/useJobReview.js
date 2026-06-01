import { useState, useCallback, useEffect, useRef } from 'react';

// Inline clamp to avoid cross-boundary Node.js module import in the renderer bundle.
// Source of truth is src/shared/jobSchema.js -- keep in sync.
function clampCorrection(value) {
  return Math.max(-20, Math.min(20, Math.round(value)));
}

/**
 * src/renderer/views/JobReview/useJobReview.js
 *
 * All state and logic for the Job Review Panel.
 *
 * @param {string} jobId   - Sidecar job ID
 * @param {string} jobPath - Absolute path to the job root folder
 * @param {string|null} ohJobId - Numeric OrderHub job ID (string form)
 */
export function useJobReview(jobId, jobPath, ohJobId = null) {
  // -- Core state ---------------------------------------------------------------

  const [sidecar,        setSidecar]        = useState(null);
  const [filenames,      setFilenames]      = useState([]);
  const [selectedId,     setSelectedId]     = useState(null);
  const [holdCorrection, setHoldCorrection] = useState(false);
  const [isDirty,        setIsDirty]        = useState(false);
  const [isSaving,       setIsSaving]       = useState(false);
  const [isLoading,      setIsLoading]      = useState(true);
  const [loadError,      setLoadError]      = useState(null);
  const [reprintCount,   setReprintCount]   = useState(0);
  // True while the reprintCreate IPC is in flight. Lifted from
  // SendReprintAction (2026-05-18) so the drawer can show a full-panel
  // overlay — the button-text-changes-to-SENDING was too subtle and
  // operators were unsure whether their click registered.
  const [isSendingReprint, setIsSendingReprint] = useState(false);
  // Last successful reprint id ("{jobId}-r{N}"), for the confirmation
  // pill in the top bar after dispatch completes.
  const [lastReprintSent,  setLastReprintSent]  = useState(null);
  // Last reprint dispatch error, surfaced as a retry pill in the top bar.
  const [reprintError,     setReprintError]     = useState(null);
  // Image count for the in-flight "Sending reprint…" overlay. The bundle
  // flow sets it to the flagged-image count; the single-image flow sets it
  // to 1. Explicit state (not derived from reprintImages) because the single
  // flow can dispatch an image that isn't in the flagged set.
  const [reprintSendCount, setReprintSendCount] = useState(0);

  // -- Crop-to-size state -------------------------------------------------------

  // allSizeOptions: unified list from DPOF channel mappings + Darkroom sizeTranslations.
  // Each entry: { id, source, w, h, label, channelMappingId?, channelNumber?,
  //               darkroomSize?, darkroomControllerId? }
  const [allSizeOptions, setAllSizeOptions] = useState([]);
  const [cropEditorOpen, setCropEditorOpen] = useState(false);
  const [cropSizeOption, setCropSizeOption] = useState(null);

  // -- AI Quality threshold (read once on mount; falls back to 50) --------------
  // Used by ThumbnailCard to colour the per-image score badge red when the
  // image is sub-threshold. Read at mount because it's a calibration value
  // that rarely changes during a Review session.
  const [aiQualityThreshold, setAiQualityThreshold] = useState(50);

  // Stable refs so async callbacks always see the latest values.
  const jobIdRef   = useRef(jobId);
  const jobPathRef = useRef(jobPath);
  const ohJobIdRef = useRef(ohJobId);
  const sidecarRef = useRef(null);
  // Mirror of the last-persisted sidecar from disk. Used to derive
  // `colorDirty` (see below) — gives a stable baseline so the SAVE
  // button only shows when CMY values diverge from what is on disk.
  const persistedSidecarRef = useRef(null);
  jobIdRef.current   = jobId;
  jobPathRef.current = jobPath;
  ohJobIdRef.current = ohJobId;
  sidecarRef.current = sidecar;

  // -- Load size options once on mount ------------------------------------------

  useEffect(() => {
    window.electronAPI.getAllSizeOptions()
      .then(opts => setAllSizeOptions(opts || []))
      .catch(() => setAllSizeOptions([]));
  }, []);

  // -- Load AI Quality threshold once on mount ----------------------------------

  useEffect(() => {
    window.electronAPI.getConfig()
      .then(cfg => {
        const t = parseInt(cfg && cfg.aiQualityThreshold, 10);
        if (!Number.isNaN(t) && t > 0) setAiQualityThreshold(t);
      })
      .catch(() => { /* default 50 */ });
  }, []);

  // -- Load ---------------------------------------------------------------------

  useEffect(() => {
    if (!jobId || !jobPath) return;

    setIsLoading(true);
    setLoadError(null);
    setSidecar(null);
    setIsDirty(false);
    setReprintCount(0);
    setHoldCorrection(false);
    setCropEditorOpen(false);
    setCropSizeOption(null);
    persistedSidecarRef.current = null;

    window.electronAPI.jobLoad({ jobId, jobPath })
      .then(result => {
        if (!result.success) throw new Error(result.error || 'Failed to load job');

        // Always open the panel with no reprint flags (2026-05-18 UX call).
        // Reprint flags are session-only: if the operator flags 12 photos
        // and then closes the panel without dispatching, those flags do
        // NOT come back next time. Forces a deliberate reflag of the work
        // they actually intend to send. Stale flags on disk get cleaned
        // out below so we don't have to do this strip on every load.
        const hadDiskReprintFlags = result.sidecar.images.some(img => img.reprint);
        const startingSidecar = hadDiskReprintFlags
          ? { ...result.sidecar, images: result.sidecar.images.map(img =>
              img.reprint ? { ...img, reprint: false } : img
            )}
          : result.sidecar;

        setSidecar(startingSidecar);
        persistedSidecarRef.current = startingSidecar;
        setFilenames(result.filenames);
        setSelectedId(startingSidecar.images[0]?.filename ?? null);
        // Seed reprintCount from the main side so the Send-button label
        // and the "{jobId}-r{N} sent ✓" pill reflect the correct next
        // suffix when the panel is reopened after a previous dispatch.
        setReprintCount(typeof result.reprintCount === 'number' ? result.reprintCount : 0);
        setLastReprintSent(null);
        setReprintError(null);
        setIsLoading(false);

        // Persist the cleared sidecar so the disk state matches what we
        // just loaded into memory. Fire-and-forget — if the save fails,
        // the next load will simply do the same strip again. Note: the
        // jobId/jobPath captured here are the load-time values; refs
        // would be wrong because this runs inside the .then().
        if (hadDiskReprintFlags) {
          window.electronAPI.jobSave({ sidecar: startingSidecar, jobPath })
            .catch(err => console.error('[OHD] auto-clear reprint flags on load failed', err));
        }
      })
      .catch(err => {
        setLoadError(err.message);
        setIsLoading(false);
      });
  }, [jobId, jobPath]);

  // -- Derived ------------------------------------------------------------------

  const images        = sidecar?.images ?? [];
  const selected      = images.find(img => img.filename === selectedId) ?? null;
  const reprintImages = images.filter(img => img.reprint);

  // colorDirty: true when any image's in-memory CMY corrections differ from
  // what is currently persisted on disk. Gates the manual SAVE button in
  // the top bar — per UX decision (2026-05-18) the button only appears
  // for colour-correction changes, so the operator isn't prompted to
  // "save" purely operational toggles like reprint flags or qty bumps
  // (those still auto-save on close and on Send-reprints).
  //
  // We compare against `persistedSidecarRef`, which mirrors the last
  // disk state (refreshed on load, save, reset, and refreshSidecar).
  // Plain reference equality with `sidecar` is not enough because
  // setSidecar produces new object identities even for no-op updates.
  const colorDirty = (() => {
    if (!sidecar || !persistedSidecarRef.current) return false;
    const persistedById = new Map(
      persistedSidecarRef.current.images.map(o => [o.filename, o])
    );
    return sidecar.images.some(img => {
      const orig = persistedById.get(img.filename);
      if (!orig) return false;
      const a = img.corrections;
      const b = orig.corrections;
      return a.cyan !== b.cyan || a.magenta !== b.magenta || a.yellow !== b.yellow;
    });
  })();

  // -- Helpers ------------------------------------------------------------------

  function setImages(updater) {
    setSidecar(prev => {
      if (!prev) return prev;
      const nextImages = typeof updater === 'function'
        ? updater(prev.images)
        : updater;
      return { ...prev, images: nextImages };
    });
    setIsDirty(true);
  }

  // -- Actions ------------------------------------------------------------------

  const selectImage = useCallback((filename) => {
    setSelectedId(filename);
  }, []);

  const updateCorrection = useCallback((channel, value) => {
    const clamped = clampCorrection(value);
    setImages(prev => prev.map(img => {
      if (!holdCorrection && img.filename !== selectedId) return img;
      return { ...img, corrections: { ...img.corrections, [channel]: clamped } };
    }));
  }, [selectedId, holdCorrection]);

  const updateQty = useCallback((filename, delta) => {
    setImages(prev => prev.map(img => {
      if (img.filename !== filename) return img;
      return { ...img, qtyCurrent: Math.max(0, img.qtyCurrent + delta) };
    }));
  }, []);

  const toggleReprint = useCallback((filename) => {
    setImages(prev => prev.map(img =>
      img.filename !== filename ? img : { ...img, reprint: !img.reprint }
    ));
  }, []);

  // Bulk reprint actions — Option A from the 2026-05-12 reprint UX work.
  // The per-image toggleReprint stays the primary mechanism; these two are
  // the "set every image at once" affordance exposed via the thumbnail grid
  // header. Idempotent — calling flagAll on a fully-flagged job is a no-op.
  const flagAllReprints = useCallback(() => {
    setImages(prev => prev.map(img =>
      img.reprint ? img : { ...img, reprint: true }
    ));
  }, []);

  const clearAllReprints = useCallback(() => {
    setImages(prev => prev.map(img =>
      img.reprint ? { ...img, reprint: false } : img
    ));
  }, []);

  const toggleHold = useCallback(() => {
    setHoldCorrection(h => !h);
  }, []);

  const resetImage = useCallback(async (filename) => {
    const snapshot = sidecarRef.current;
    const result = await window.electronAPI.jobResetImage({
      jobPath: jobPathRef.current,
      sidecar: snapshot,
      filename,
    });
    if (!result.success) throw new Error(result.error);
    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    setIsDirty(false);
  }, []);

  const resetAll = useCallback(async () => {
    const snapshot = sidecarRef.current;
    const result = await window.electronAPI.jobResetAll({
      jobPath: jobPathRef.current,
      sidecar: snapshot,
    });
    if (!result.success) throw new Error(result.error);
    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    setIsDirty(false);
  }, []);

  // M5b (2026-05-25): drop-in replacement of the in-memory sidecar with a
  // server-returned one. Mirrors resetImage/resetAll's setSidecar +
  // persistedSidecarRef + clear-dirty pattern. Used by BatchCropMode
  // after `jobBatchCropApply` returns to flow the post-save sidecar
  // back into the renderer state without a round-trip through loadSidecar.
  const replaceSidecar = useCallback((next) => {
    if (!next) return;
    setSidecar(next);
    persistedSidecarRef.current = next;
    setIsDirty(false);
  }, []);

  const refreshSidecar = useCallback(async () => {
    const result = await window.electronAPI.jobLoad({
      jobId:   jobIdRef.current,
      jobPath: jobPathRef.current,
    });
    if (!result.success) throw new Error(result.error || 'Failed to refresh job');
    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    setFilenames(result.filenames);
  }, []);

  const saveJob = useCallback(async () => {
    setIsSaving(true);
    try {
      const snapshot = sidecarRef.current;
      const result = await window.electronAPI.jobSave({
        sidecar:  snapshot,
        jobPath:  jobPathRef.current,
      });
      if (!result.success) throw new Error(result.error);
      setSidecar(result.sidecar);
      persistedSidecarRef.current = result.sidecar;
      setIsDirty(false);
    } catch (err) {
      console.error('[OHD] saveJob failed:', err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const sendReprints = useCallback(async () => {
    // Drive the full-panel overlay + reset prior dispatch state. Lifted
    // out of SendReprintAction (2026-05-18) so the spinner can blanket
    // the whole drawer instead of being a button-text change.
    setIsSendingReprint(true);
    setReprintSendCount((sidecarRef.current?.images || []).filter(i => i.reprint).length);
    setReprintError(null);
    try {
      await saveJob();
      const result = await window.electronAPI.reprintCreate({
        jobId:   jobIdRef.current,
        jobPath: jobPathRef.current,
      });
      if (!result.success) {
        console.error('[OHD] reprintCreate failed:', result.error);
        const err = new Error(result.error);
        setReprintError(result.error || 'Unknown error');
        throw err;
      }
      // Local optimistic update mirrors what the main side wrote to disk:
      // every image's reprint flag is cleared. Keep the persisted snapshot
      // in lock-step so colorDirty doesn't false-positive after a send.
      setSidecar(prev => {
        if (!prev) return prev;
        const next = { ...prev, images: prev.images.map(img => ({ ...img, reprint: false })) };
        persistedSidecarRef.current = next;
        return next;
      });
      setReprintCount(c => c + 1);
      setLastReprintSent(result.reprintJobId);
      setIsDirty(false);
      return { reprintJobId: result.reprintJobId, reprintJobPath: result.reprintJobPath };
    } catch (err) {
      // Diagnostic for "operator says nothing happened after Send" — captures
      // that we hit the error path and surfaces what message reaches
      // setReprintError. If you ever see this log without the renderer's
      // error pill appearing in the topbar, the bug is in
      // SendReprintAction's render, not the dispatch chain.
      console.warn('[OHD] sendReprints catch — setting reprintError', {
        message: err && err.message ? err.message : String(err),
        alreadySet: !!reprintError,
      });
      if (!reprintError) {
        setReprintError(err && err.message ? err.message : String(err));
      }
      throw err;
    } finally {
      setIsSendingReprint(false);
    }
  // reprintError intentionally NOT in deps — it would re-create the
  // callback on every error toggle, churning the SendReprintAction
  // event handler reference. We only read it inside the catch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveJob]);

  // Operator-driven dismissals for the persistent reprint dispatch state
  // shown in the top bar. The "sent ✓" pill auto-dismisses on next send
  // start (above), but operators can also dismiss it manually after
  // glancing at the confirmation. Errors similarly clear on retry.
  const dismissReprintToast = useCallback(() => {
    setLastReprintSent(null);
    setReprintError(null);
  }, []);

  // -- Crop-to-size actions -----------------------------------------------------

  const openCropEditor = useCallback((sizeOption) => {
    setCropSizeOption(sizeOption);
    setCropEditorOpen(true);
  }, []);

  const closeCropEditor = useCallback(() => {
    setCropEditorOpen(false);
  }, []);

  // -- Customer Originals (Phase 1) ---------------------------------------------
  //
  // Open / reveal actions are pass-throughs to the main side, which resolves
  // the manifest-relative `originalFilename` to an absolute path and verifies
  // existence before calling shell.openPath / shell.showItemInFolder. Returns
  // { ok:false, error:'not-found' } on a missing file so the card UI can
  // surface a small inline notice.

  const openOriginal = useCallback(async (originalFilename) => {
    if (!originalFilename) return { ok: false, error: 'no-original' };
    return window.electronAPI.originalOpen({
      jobPath: jobPathRef.current,
      originalFilename,
    });
  }, []);

  const revealOriginal = useCallback(async (originalFilename) => {
    if (!originalFilename) return { ok: false, error: 'no-original' };
    return window.electronAPI.originalReveal({
      jobPath: jobPathRef.current,
      originalFilename,
    });
  }, []);

  /**
   * Apply a crop to the selected image.
   * - DPOF:      sizeOption.channelMappingId  => sets _channelMappingOverride
   * - Darkroom:  sizeOption.darkroomSize      => sets _darkroomProSize
   * - Plain:     no override, routing unchanged
   */
  const cropImage = useCallback(async (filename, sizeOption, cropRect) => {
    const snapshot = sidecarRef.current;
    if (!snapshot) throw new Error('No sidecar loaded');

    const result = await window.electronAPI.jobCropImage({
      jobPath:          jobPathRef.current,
      sidecar:          snapshot,
      filename,
      cropRect,
      channelMappingId: sizeOption?.channelMappingId || null,
      darkroomSize:     sizeOption?.darkroomSize     || null,
      ohJobId:          ohJobIdRef.current,
    });

    if (!result.success) throw new Error(result.error || 'Crop failed');

    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    setIsDirty(false);
    setCropEditorOpen(false);
    // In-place crop keeps the entry filename; return it so the single-image
    // reprint flow can dispatch this exact image post-apply.
    return filename;
  }, []);

  // -- Manual Crop redesign (2026-06-01): drain in-progress per-image state ----
  //
  // Persists per-image pendingCropRect / pendingRotation / pendingOrientation
  // to the sidecar without touching /working/. Called by the manual-crop
  // drawer on close so the operator can resume the same in-flight crop
  // session on next open. `updates` is the array form already expected by
  // the IPC — caller owns the diff against perImageState. No-op (returns
  // success without a disk write) when the updates array is empty.
  //
  // Commit 1 stub: declared + exported, not yet called by any UI surface.
  // The manual-crop UI (commit 2) is the only intended caller.
  const savePendingCrops = useCallback(async (updates) => {
    const snapshot = sidecarRef.current;
    if (!snapshot) throw new Error('No sidecar loaded');
    if (!Array.isArray(updates) || updates.length === 0) return snapshot;

    const result = await window.electronAPI.jobSavePendingCrops({
      jobPath: jobPathRef.current,
      sidecar: snapshot,
      updates,
    });
    if (!result || !result.success) {
      throw new Error((result && result.error) || 'Save pending crops failed');
    }
    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    return result.sidecar;
  }, []);

  // -- Customer Originals (Phase 2): re-crop from the customer upload ----------
  //
  // The current row's filename is changed by the main side to the new
  // /working/{newBasename}.jpeg. We re-point the selection so the main
  // preview + thumbnail grid follow the move without an extra click.
  const recropFromOriginal = useCallback(async (filename, cropRect) => {
    const snapshot = sidecarRef.current;
    if (!snapshot) throw new Error('No sidecar loaded');

    const result = await window.electronAPI.jobRecropFromOriginal({
      jobPath:  jobPathRef.current,
      sidecar:  snapshot,
      filename,
      cropRect,
    });

    if (!result.success) throw new Error(result.error || 'Re-crop failed');

    setSidecar(result.sidecar);
    persistedSidecarRef.current = result.sidecar;
    setIsDirty(false);
    setCropEditorOpen(false);
    if (result.newFilename) setSelectedId(result.newFilename);
    // A re-crop re-points the entry filename to the new /working/ basename;
    // return it so the single-image reprint flow dispatches the right file.
    return result.newFilename || filename;
  }, []);

  // -- Single-image reprint -----------------------------------------------------
  //
  // Backs the crop modal's "Apply & Send Reprint" button: apply a crop to the
  // selected image, then dispatch JUST that image — without bundling the
  // other flagged images.
  //   1. Apply via the source-appropriate path. cropImage (in-place customer
  //      crop) and recropFromOriginal (re-crop of the customer upload) both
  //      persist the sidecar, close the crop modal, and return the POST-apply
  //      filename (a re-crop re-points it to a new basename).
  //   2. Dispatch that one image via ohd:reprint:createSingle.
  // Dispatch state reuses the bundle flow's isSendingReprint / lastReprintSent
  // / reprintError channels so the topbar surfaces it identically.
  const applyCropAndSendReprint = useCallback(async (cropRect, source) => {
    const filename = selectedId;
    if (!filename) throw new Error('No image selected');

    // Step 1 — apply the crop. A failure here aborts BEFORE any dispatch;
    // cropImage / recropFromOriginal only close the modal on success, so on
    // failure the cropper stays open for the operator to retry or cancel.
    let postApplyFilename;
    try {
      postApplyFilename = source === 'original'
        ? await recropFromOriginal(filename, cropRect)
        : await cropImage(filename, cropSizeOption, cropRect);
    } catch (err) {
      setReprintError(err && err.message ? err.message : String(err));
      throw err;
    }

    // Step 2 — dispatch the single image. The apply step has already saved
    // the sidecar and closed the crop modal.
    setIsSendingReprint(true);
    setReprintSendCount(1);
    setReprintError(null);
    try {
      const result = await window.electronAPI.reprintCreateSingle({
        jobId:         jobIdRef.current,
        jobPath:       jobPathRef.current,
        imageFilename: postApplyFilename,
      });
      if (!result.success) {
        setReprintError(result.error || 'Unknown error');
        throw new Error(result.error);
      }
      // Optimistic local update — clear the reprint flag for ONLY the
      // dispatched image. Other flagged images stay flagged for the bundle
      // flow. Keep persistedSidecarRef in lock-step so colorDirty is stable.
      setSidecar(prev => {
        if (!prev) return prev;
        const next = {
          ...prev,
          images: prev.images.map(img =>
            img.filename === postApplyFilename
              ? { ...img, reprint: false, reprintJobId: result.reprintJobId }
              : img
          ),
        };
        persistedSidecarRef.current = next;
        return next;
      });
      setReprintCount(c => c + 1);
      setLastReprintSent(result.reprintJobId);
      setIsDirty(false);
    } catch (err) {
      if (!reprintError) {
        setReprintError(err && err.message ? err.message : String(err));
      }
      throw err;
    } finally {
      setIsSendingReprint(false);
    }
  // reprintError intentionally excluded from deps — see sendReprints note.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, cropSizeOption, cropImage, recropFromOriginal]);

  // -- Return -------------------------------------------------------------------

  return {
    // State
    jobId,
    sidecar,
    images,
    filenames,
    selected,
    selectedId,
    holdCorrection,
    isDirty,
    colorDirty,
    isSaving,
    isLoading,
    loadError,
    reprintCount,
    reprintImages,
    isSendingReprint,
    lastReprintSent,
    reprintError,
    reprintSendCount,
    dismissReprintToast,

    // Actions
    selectImage,
    updateCorrection,
    updateQty,
    toggleReprint,
    flagAllReprints,
    clearAllReprints,
    toggleHold,
    resetImage,
    resetAll,
    saveJob,
    sendReprints,
    refreshSidecar,
    replaceSidecar,

    // Crop-to-size
    allSizeOptions,
    cropEditorOpen,
    cropSizeOption,
    openCropEditor,
    closeCropEditor,
    cropImage,
    recropFromOriginal,
    applyCropAndSendReprint,
    savePendingCrops,

    // AI Quality
    aiQualityThreshold,

    // Customer Originals (Phase 1)
    openOriginal,
    revealOriginal,
  };
}
