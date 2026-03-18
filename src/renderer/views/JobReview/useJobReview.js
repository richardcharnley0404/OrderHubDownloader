import { useState, useCallback, useEffect, useRef } from 'react';

// Inline clamp to avoid cross-boundary Node.js module import in the renderer bundle.
// Source of truth is src/shared/jobSchema.js — keep in sync.
function clampCorrection(value) {
  return Math.max(-20, Math.min(20, Math.round(value)));
}

/**
 * src/renderer/views/JobReview/useJobReview.js
 *
 * All state and logic for the Job Review Panel.
 * Components are display-only — they call actions exposed by this hook.
 *
 * Stores the COMPLETE sidecar object so all fields (createdAt, schemaVersion…)
 * are preserved on every save.  The `images` array is exposed as a derived slice.
 *
 * @param {string} jobId
 * @param {string} jobPath
 */
export function useJobReview(jobId, jobPath) {
  // ── Core state ───────────────────────────────────────────────────────────────

  const [sidecar,       setSidecar]       = useState(null);
  const [filenames,     setFilenames]     = useState([]);
  const [selectedId,    setSelectedId]    = useState(null);
  const [holdCorrection, setHoldCorrection] = useState(false);
  const [isDirty,       setIsDirty]       = useState(false);
  const [isSaving,      setIsSaving]      = useState(false);
  const [isLoading,     setIsLoading]     = useState(true);
  const [loadError,     setLoadError]     = useState(null);
  const [reprintCount,  setReprintCount]  = useState(0);

  // Stable refs so async callbacks always see the latest values.
  const jobIdRef   = useRef(jobId);
  const jobPathRef = useRef(jobPath);
  const sidecarRef = useRef(null);
  jobIdRef.current   = jobId;
  jobPathRef.current = jobPath;
  sidecarRef.current = sidecar;

  // ── Load ──────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!jobId || !jobPath) return;

    setIsLoading(true);
    setLoadError(null);
    setSidecar(null);
    setIsDirty(false);
    setReprintCount(0);
    setHoldCorrection(false);

    window.electronAPI.jobLoad({ jobId, jobPath })
      .then(result => {
        if (!result.success) throw new Error(result.error || 'Failed to load job');
        setSidecar(result.sidecar);
        setFilenames(result.filenames);
        setSelectedId(result.sidecar.images[0]?.filename ?? null);
        setIsLoading(false);
      })
      .catch(err => {
        setLoadError(err.message);
        setIsLoading(false);
      });
  }, [jobId, jobPath]);

  // ── Derived ───────────────────────────────────────────────────────────────────

  const images        = sidecar?.images ?? [];
  const selected      = images.find(img => img.filename === selectedId) ?? null;
  const reprintImages = images.filter(img => img.reprint);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** Update the images array inside the sidecar and mark dirty. */
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

  // ── Actions ───────────────────────────────────────────────────────────────────

  /** Select a different image in the thumbnail grid. */
  const selectImage = useCallback((filename) => {
    setSelectedId(filename);
  }, []);

  /**
   * Update a CMY correction channel for the selected image (or all images if
   * holdCorrection is active).
   *
   * @param {'cyan'|'magenta'|'yellow'} channel
   * @param {number} value  — will be clamped to [-20, +20]
   */
  const updateCorrection = useCallback((channel, value) => {
    const clamped = clampCorrection(value);
    setImages(prev => prev.map(img => {
      if (!holdCorrection && img.filename !== selectedId) return img;
      return { ...img, corrections: { ...img.corrections, [channel]: clamped } };
    }));
  }, [selectedId, holdCorrection]);

  /**
   * Adjust quantity for a specific image by delta (+1 / -1).  Minimum qty 0.
   *
   * @param {string} filename
   * @param {number} delta
   */
  const updateQty = useCallback((filename, delta) => {
    setImages(prev => prev.map(img => {
      if (img.filename !== filename) return img;
      return { ...img, qtyCurrent: Math.max(0, img.qtyCurrent + delta) };
    }));
  }, []);

  /** Toggle the reprint flag for an image. */
  const toggleReprint = useCallback((filename) => {
    setImages(prev => prev.map(img =>
      img.filename !== filename ? img : { ...img, reprint: !img.reprint }
    ));
  }, []);

  /** Toggle "hold correction" — when on, slider changes propagate to all images. */
  const toggleHold = useCallback(() => {
    setHoldCorrection(h => !h);
  }, []);

  /**
   * Reset a single image — restores from /originals/ and resets its sidecar entry.
   *
   * @param {string} filename
   */
  const resetImage = useCallback(async (filename) => {
    const snapshot = sidecarRef.current;

    const result = await window.electronAPI.jobResetImage({
      jobPath: jobPathRef.current,
      sidecar: snapshot,
      filename,
    });
    if (!result.success) throw new Error(result.error);

    setSidecar(result.sidecar);
    setIsDirty(false);
  }, []);

  /** Reset all images — restores all from /originals/ and resets every entry. */
  const resetAll = useCallback(async () => {
    const snapshot = sidecarRef.current;

    const result = await window.electronAPI.jobResetAll({
      jobPath: jobPathRef.current,
      sidecar: snapshot,
    });
    if (!result.success) throw new Error(result.error);

    setSidecar(result.sidecar);
    setIsDirty(false);
  }, []);

  /**
   * Re-load the sidecar from disk without resetting the current selection.
   * Called after an AI enhancement completes so the updated enhancement fields
   * (enhanced, enhancedPath, enhancementModel…) are reflected in the UI.
   */
  const refreshSidecar = useCallback(async () => {
    const result = await window.electronAPI.jobLoad({
      jobId:   jobIdRef.current,
      jobPath: jobPathRef.current,
    });
    if (!result.success) throw new Error(result.error || 'Failed to refresh job');
    // Update sidecar and filenames; selectedId is NOT reset — preserve current selection.
    setSidecar(result.sidecar);
    setFilenames(result.filenames);
  }, []);

  /**
   * Persist the current sidecar to disk.
   * Called automatically on drawer close when isDirty.
   */
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
      setIsDirty(false);
    } catch (err) {
      console.error('[OHD] saveJob failed:', err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, []);

  /**
   * Send all reprint-flagged images as a new reprint job.
   * Clears reprint flags in local state after a successful send.
   *
   * @returns {Promise<{ reprintJobId: string, reprintJobPath: string }>}
   */
  const sendReprints = useCallback(async () => {
    // Ensure the on-disk sidecar has the latest reprint flags before creating.
    await saveJob();

    const result = await window.electronAPI.reprintCreate({
      jobId:   jobIdRef.current,
      jobPath: jobPathRef.current,
    });
    if (!result.success) {
      console.error('[OHD] reprintCreate failed:', result.error);
      throw new Error(result.error);
    }

    // Clear reprint flags in local state (main process already cleared them on disk).
    setSidecar(prev => prev
      ? { ...prev, images: prev.images.map(img => ({ ...img, reprint: false })) }
      : prev
    );
    setReprintCount(c => c + 1);
    setIsDirty(false);

    return { reprintJobId: result.reprintJobId, reprintJobPath: result.reprintJobPath };
  }, [saveJob]);

  // ── Return ────────────────────────────────────────────────────────────────────

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
    isSaving,
    isLoading,
    loadError,
    reprintCount,
    reprintImages,

    // Actions
    selectImage,
    updateCorrection,
    updateQty,
    toggleReprint,
    toggleHold,
    resetImage,
    resetAll,
    saveJob,
    sendReprints,
    refreshSidecar,
  };
}
