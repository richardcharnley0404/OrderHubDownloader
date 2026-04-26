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

  // -- Crop-to-size state -------------------------------------------------------

  // allSizeOptions: unified list from DPOF channel mappings + Darkroom sizeTranslations.
  // Each entry: { id, source, w, h, label, channelMappingId?, channelNumber?,
  //               darkroomSize?, darkroomControllerId? }
  const [allSizeOptions, setAllSizeOptions] = useState([]);
  const [cropEditorOpen, setCropEditorOpen] = useState(false);
  const [cropSizeOption, setCropSizeOption] = useState(null);

  // Stable refs so async callbacks always see the latest values.
  const jobIdRef   = useRef(jobId);
  const jobPathRef = useRef(jobPath);
  const ohJobIdRef = useRef(ohJobId);
  const sidecarRef = useRef(null);
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

  // -- Derived ------------------------------------------------------------------

  const images        = sidecar?.images ?? [];
  const selected      = images.find(img => img.filename === selectedId) ?? null;
  const reprintImages = images.filter(img => img.reprint);

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
    setIsDirty(false);
  }, []);

  const refreshSidecar = useCallback(async () => {
    const result = await window.electronAPI.jobLoad({
      jobId:   jobIdRef.current,
      jobPath: jobPathRef.current,
    });
    if (!result.success) throw new Error(result.error || 'Failed to refresh job');
    setSidecar(result.sidecar);
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
      setIsDirty(false);
    } catch (err) {
      console.error('[OHD] saveJob failed:', err);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const sendReprints = useCallback(async () => {
    await saveJob();
    const result = await window.electronAPI.reprintCreate({
      jobId:   jobIdRef.current,
      jobPath: jobPathRef.current,
    });
    if (!result.success) {
      console.error('[OHD] reprintCreate failed:', result.error);
      throw new Error(result.error);
    }
    setSidecar(prev => prev
      ? { ...prev, images: prev.images.map(img => ({ ...img, reprint: false })) }
      : prev
    );
    setReprintCount(c => c + 1);
    setIsDirty(false);
    return { reprintJobId: result.reprintJobId, reprintJobPath: result.reprintJobPath };
  }, [saveJob]);

  // -- Crop-to-size actions -----------------------------------------------------

  const openCropEditor = useCallback((sizeOption) => {
    setCropSizeOption(sizeOption);
    setCropEditorOpen(true);
  }, []);

  const closeCropEditor = useCallback(() => {
    setCropEditorOpen(false);
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
    setIsDirty(false);
    setCropEditorOpen(false);
  }, []);

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

    // Crop-to-size
    allSizeOptions,
    cropEditorOpen,
    cropSizeOption,
    openCropEditor,
    closeCropEditor,
    cropImage,
  };
}
