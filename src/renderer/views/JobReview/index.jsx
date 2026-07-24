import { useState, useEffect, useCallback } from 'react';
import { useJobReview } from './useJobReview.js';
import { ThumbnailGrid } from './ThumbnailGrid.jsx';
import { ControlSidebar } from './ControlPanel.jsx';
import { CropEditor } from './CropEditor.jsx';
import ManualCropMode from './ManualCropMode.jsx';
import { ScoreBadge } from './ScoreBadge.jsx';
// M5b (2026-05-25): shared trigger predicate — same module the main side
// uses for defensive logging, so renderer + main agree on which jobs
// enter batch crop mode.
import { shouldEnterBatchCropMode, MODE as BATCH_MODE } from '../../../shared/batchCropTrigger.js';

/**
 * src/renderer/views/JobReview/index.jsx
 *
 * Slide-in drawer that opens over the existing job list.
 *
 * Behaviour (brief §Drawer Behaviour):
 *   - Triggered by setting selectedJobId in shared state / context.
 *   - Slides in from the right via CSS transform (~250 ms).
 *   - Job list stays mounted behind the drawer — no routing change.
 *   - Close button (top-right) and Escape both close.
 *   - On close: if isDirty, auto-saves before calling onClose().
 *   - On open:  calls ohd:job:load IPC to fetch sidecar + image list.
 *
 * Styling: classes are defined in src/renderer/job-review.css; the panel
 * inherits the app-wide --app-* design tokens, so dark/light themes track
 * the body.app-theme-dark switch driven from the app header.
 *
 * Props:
 *   jobId    string          Job identifier, e.g. "JOB-00452"
 *   jobPath  string          Absolute path to the job root folder
 *   onClose  () => void      Called after save (if dirty) is complete
 */

function midEllipsis(str, max = 40) {
  if (!str || str.length <= max) return str;
  const keep  = max - 1;
  const front = Math.ceil(keep / 2);
  const back  = keep - front;
  return str.slice(0, front) + '…' + str.slice(str.length - back);
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function DrawerTopBar({
  jobId,
  jobQuantity,
  selectedFilename,
  images,
  reprintImages,
  reprintCount,
  isSaving,
  colorDirty,
  isSendingReprint,
  lastReprintSent,
  reprintError,
  onSave,
  onSendReprints,
  onDismissReprintToast,
  onClose,
}) {
  const totalPrints   = images.reduce((s, i) => s + i.qtyCurrent, 0);
  const modifiedCount = images.filter(img =>
    img.qtyCurrent !== img.qtyOriginal
    || img.corrections.cyan    !== 0
    || img.corrections.magenta !== 0
    || img.corrections.yellow  !== 0
  ).length;

  const reprintPrintTotal = reprintImages.reduce((s, i) => s + i.qtyCurrent, 0);
  const showReprintSubline =
    reprintImages.length > 0 && reprintPrintTotal !== reprintImages.length;

  const reprintJobId = reprintCount > 0 ? `${jobId}-r${reprintCount}` : null;

  return (
    <div className="jr-topbar">
      {/* Left: breadcrumb */}
      <div className="jr-topbar__left">
        <div className="jr-crumb">
          <div className="jr-crumb__dot" />
          <span className="jr-crumb__app">OHD</span>
          <span className="jr-crumb__sep">›</span>
          <span className="jr-crumb__panel">Job Review</span>
          {selectedFilename && (
            <>
              <span className="jr-crumb__sep">›</span>
              <span className="jr-crumb__file">{midEllipsis(selectedFilename)}</span>
            </>
          )}
        </div>
      </div>

      {/* Centre: reprint dispatch action / status */}
      <div className="jr-topbar__center">
        <SendReprintAction
          reprintImages={reprintImages}
          isSaving={isSaving}
          isSendingReprint={isSendingReprint}
          lastReprintSent={lastReprintSent}
          reprintError={reprintError}
          onSendReprints={onSendReprints}
          onDismissToast={onDismissReprintToast}
        />
      </div>

      {/* Right: meta + stats + save + close */}
      <div className="jr-topbar__right">
        <div className="jr-topbar__meta">
          <div className="jr-topbar__meta-jobid">{jobId}</div>
          <div className="jr-topbar__meta-count">
            {images.length} IMAGE{images.length !== 1 ? 'S' : ''}
          </div>
          {/* M3 (2026-05-24): job-level quantity chip. Distinct from the
              per-card top-right ×qty operator-mod indicator — this is the
              fan-out multiplier ("print this job N times"), per-card is
              "operator bumped THIS image's count from original". */}
          {Number.isFinite(jobQuantity) && jobQuantity > 0 && (
            <div className="jr-job-qty-chip" title="Job-level quantity multiplier — applied to every image">
              Qty: {jobQuantity}
            </div>
          )}
        </div>

        {reprintJobId && (
          <div className="jr-reprint-pill">
            <span className="jr-reprint-pill__text">{reprintJobId} sent ✓</span>
          </div>
        )}

        <div className="jr-stats">
          <StatBox label="TOTAL PRINTS" value={totalPrints} />
          <StatBox label="MODIFIED" value={modifiedCount} highlight={modifiedCount > 0} />
          <StatBox
            label="REPRINTS"
            value={reprintImages.length}
            danger={reprintImages.length > 0}
            subline={
              showReprintSubline
                ? `${reprintPrintTotal} print${reprintPrintTotal !== 1 ? 's' : ''}`
                : null
            }
          />
        </div>

        {/* Save — gated on colour-correction dirty only (2026-05-18). */}
        {colorDirty && (
          <button onClick={onSave} disabled={isSaving} className="jr-btn-save">
            {isSaving ? 'SAVING…' : 'SAVE'}
          </button>
        )}

        <button onClick={onClose} aria-label="Close Job Review" className="jr-btn-close">✕</button>
      </div>
    </div>
  );
}

function StatBox({ label, value, highlight = false, danger = false, subline = null }) {
  const cls = 'jr-stat'
    + (highlight ? ' jr-stat--highlight' : '')
    + (danger    ? ' jr-stat--danger'    : '');
  return (
    <div className={cls}>
      <div className="jr-stat__value">{value}</div>
      <div className="jr-stat__label">{label}</div>
      {subline && <div className="jr-stat__subline">{subline}</div>}
    </div>
  );
}

// ── Send-reprint action (top-bar pill) ───────────────────────────────────────
//
// Lives in the top-bar centre. All dispatch state (sending / sent / error)
// is now lifted to useJobReview so the drawer can render a full-panel
// overlay during the in-flight reprintCreate IPC — the button-text change
// to "SENDING…" was too subtle and operators were unsure whether their
// click registered.
//
// Label wording: "Send {N} Image(s) for Reprint" — plain English, no
// arrow, no version. The version is implicit (next available -rN slot
// on disk) and is surfaced AFTER dispatch via the lastReprintSent pill.

function SendReprintAction({
  reprintImages,
  isSaving,
  isSendingReprint,
  lastReprintSent,
  reprintError,
  onSendReprints,
  onDismissToast,
}) {
  // Nothing flagged AND no recent dispatch state to show → render nothing.
  if (
    reprintImages.length === 0 &&
    !isSendingReprint &&
    !lastReprintSent &&
    !reprintError
  ) {
    return null;
  }

  async function handleSend() {
    try { await onSendReprints(); } catch { /* state already set by hook */ }
  }

  if (isSendingReprint) {
    // The full-panel overlay (rendered by JobReviewDrawer) carries the
    // user-facing spinner; the top-bar slot just shows a minimal label
    // so the centre column doesn't shift when state transitions.
    return (
      <span className="jr-send-pill jr-send-pill--sending">SENDING REPRINT…</span>
    );
  }

  if (lastReprintSent) {
    return (
      <span
        className="jr-send-pill jr-send-pill--sent"
        onClick={onDismissToast}
        role="button"
        tabIndex={0}
        title="Click to dismiss"
      >
        ✓ {lastReprintSent} sent
      </span>
    );
  }

  if (reprintError) {
    return (
      <span className="jr-send-pill jr-send-pill--error" title={reprintError}>
        <span className="jr-send-pill__error-text">⚠ {reprintError}</span>
        <button
          onClick={handleSend}
          disabled={isSaving}
          className="jr-btn-send jr-btn-send--inline"
        >
          Retry Send
        </button>
      </span>
    );
  }

  const imageCount  = reprintImages.length;
  const printTotal  = reprintImages.reduce((s, i) => s + i.qtyCurrent, 0);
  const printsDifferFromImages = printTotal !== imageCount;
  const baseLabel = printsDifferFromImages
    ? `Send ${imageCount} Image${imageCount !== 1 ? 's' : ''} (${printTotal} prints) for Reprint`
    : `Send ${imageCount} Image${imageCount !== 1 ? 's' : ''} for Reprint`;

  return (
    <button onClick={handleSend} disabled={isSaving} className="jr-btn-send">
      {baseLabel}
    </button>
  );
}

// ── Sending overlay ──────────────────────────────────────────────────────────
//
// Full-drawer modal shown while the reprintCreate IPC is in flight.
// Blocks interaction so the operator can't double-click the Send button
// and so they get a clear "yes, the click registered" signal. The
// underlying dispatch can take seconds (Darkroom Pro write + folder
// build), and without this overlay the only feedback was the button
// text changing to SENDING… which was easy to miss.

function SendingReprintOverlay({ imageCount }) {
  return (
    <div className="jr-sending-overlay" role="status" aria-live="polite">
      <div className="jr-sending-overlay__card">
        <div className="jr-sending-overlay__spinner" aria-hidden="true" />
        <div className="jr-sending-overlay__title">Sending reprint…</div>
        <div className="jr-sending-overlay__sub">
          Dispatching {imageCount} image{imageCount !== 1 ? 's' : ''} to the controller.
        </div>
      </div>
    </div>
  );
}

// ── Preview area ──────────────────────────────────────────────────────────────

function PreviewArea({ selected, jobPath }) {
  if (!selected) return null;

  const imagePath = jobPath
    ? `file://${jobPath.replace(/\\/g, '/')}/working/${selected.filename}`
    : null;

  const { corrections, reprint } = selected;
  const hasCorrections =
    corrections.cyan !== 0 || corrections.magenta !== 0 || corrections.yellow !== 0;

  let overlayColor = null;
  if (hasCorrections) {
    const { cyan, magenta, yellow } = corrections;
    const totalMag = Math.abs(cyan) + Math.abs(magenta) + Math.abs(yellow);
    const alpha    = Math.min(0.35, totalMag / 60);
    if (alpha > 0) {
      const r = Math.round(
        (Math.max(0, -cyan) * 255 + Math.max(0, magenta) * 255 + Math.max(0, yellow) * 255)
        / (totalMag || 1),
      );
      const g = Math.round(
        (Math.max(0, cyan) * 255 + Math.max(0, -magenta) * 255 + Math.max(0, yellow) * 255)
        / (totalMag || 1),
      );
      const b = Math.round(
        (Math.max(0, cyan) * 255 + Math.max(0, magenta) * 255 + Math.max(0, -yellow) * 255)
        / (totalMag || 1),
      );
      overlayColor = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    }
  }

  return (
    <div className="jr-preview">
      {imagePath ? (
        <img src={imagePath} alt={selected.filename} className="jr-preview__img" />
      ) : (
        <div className="jr-preview__empty">No image</div>
      )}

      {overlayColor && (
        <div className="jr-preview__overlay" style={{ background: overlayColor }} />
      )}

      {reprint && (
        <div className="jr-preview__overlay jr-preview__overlay--reprint" />
      )}

      {hasCorrections && (
        <div className="jr-preview__chip jr-preview__chip--corrected">CORRECTED</div>
      )}
      {reprint && (
        <div className="jr-preview__chip jr-preview__chip--reprint">FLAGGED FOR REPRINT</div>
      )}
    </div>
  );
}

// ── JobReviewDrawer ───────────────────────────────────────────────────────────

export function JobReviewDrawer({ jobId, jobPath, ohJobId, onClose }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Job-level artwork_source for the per-file "Manual" / "Pixfizz" tag in
  // the thumbnail grid (S3 Artwork Channel M2, 2026-05-24). Looked up via
  // electronAPI.getJobs() — the in-memory jobs cache already has the field
  // (job-service._mapApiJob). Falls back to null if the lookup fails or
  // the job isn't in cache; per-file tag then suppresses itself (no useful
  // comparison without a job-level baseline). Acceptable degradation.
  const [jobArtworkSource, setJobArtworkSource] = useState(null);
  // Job-level quantity for the M3 "Qty: N" header chip. Same lookup as
  // artwork_source — single getJobs() call, both fields read together. null
  // falls back to "no chip" (quantity unknown / cache miss / pre-M3 job).
  const [jobQuantity, setJobQuantity] = useState(null);
  useEffect(() => {
    if (!ohJobId) return;
    window.electronAPI.getJobs()
      .then((jobs) => {
        const apiJob = (jobs || []).find((j) => String(j.id) === String(ohJobId));
        if (apiJob) {
          setJobArtworkSource(apiJob.artwork_source || null);
          if (Number.isFinite(apiJob.quantity) && apiJob.quantity > 0) {
            setJobQuantity(apiJob.quantity);
          }
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [ohJobId]);

  const {
    sidecar,
    images, filenames, selected, selectedId,
    holdCorrection, isDirty, colorDirty, isSaving, isLoading, loadError,
    reprintCount, reprintImages,
    isSendingReprint, lastReprintSent, reprintError, reprintSendCount, dismissReprintToast,
    selectImage, updateCorrection, updateQty,
    toggleReprint, flagAllReprints, clearAllReprints,
    toggleHold, resetImage, resetAll,
    saveJob, sendReprints, refreshSidecar, replaceSidecar,
    allSizeOptions, cropEditorOpen, cropSizeOption,
    openCropEditor, closeCropEditor, cropImage,
    aiQualityThreshold,
    openOriginal, revealOriginal,
    recropFromOriginal,
    applyCropAndSendReprint,
    // Perfectly Clear (M3, 2026-07-03)
    enhanceMultiSelectMode, enhanceSelected,
    enterEnhanceMultiSelect, exitEnhanceMultiSelect,
    toggleEnhanceSelected, selectAllForEnhance, clearEnhanceSelected,
    enhanceBatchId, enhanceBatchStatusByFilename,
    enhanceBatchCounts, enhanceBatchFinished, enhanceBatchError,
    startEnhanceBatch, cancelEnhanceBatch, dismissEnhanceBatch,
    revertEnhancement,
  } = useJobReview(jobId, jobPath, ohJobId);

  // ── M5b (2026-05-25): batch crop mode routing ─────────────────────────────
  //
  // Build the minimal job shape the shared trigger predicate needs (it
  // reads only artwork_source; the per-image artworkSource lives on
  // sidecar.images[i]). Mirrors the synthesis on the main side.
  //
  // userOverride lets the operator explicitly enter or exit batch mode:
  //   'batch'    → forced into BatchCropMode regardless of trigger.mode
  //                  (clicking the "Batch Crop Remaining" CTA in standard)
  //   'standard' → forced out of BatchCropMode (clicking "Exit Batch")
  //   null       → defer to the trigger's natural mode (AUTO → batch,
  //                  BUTTON → standard with CTA, STANDARD → standard)
  // Reset to null whenever a new job loads so the next job starts fresh.
  const [userOverride, setUserOverride] = useState(null);
  useEffect(() => { setUserOverride(null); }, [jobId, jobPath]);

  const batchTrigger = shouldEnterBatchCropMode(
    { artwork_source: jobArtworkSource },
    sidecar,
  );

  // Manual Crop redesign (2026-06-01): sticky-once-entered. The trigger
  // recomputes on every render and transitions AUTO → BUTTON → STANDARD
  // as images get approved. Without stickiness, the first Approve+Next
  // would flip trigger.mode to BUTTON and kick the drawer back to
  // standard mode (the M5b BatchCropMode behaviour, where partial state
  // was a natural review checkpoint). Under the new per-image flow that
  // bounce is harmful — operator should stay in ManualCropMode until
  // they explicitly Exit Batch or hit Send to Print.
  //
  // Solution: on first detection of needing batch mode, lift userOverride
  // to 'batch'. From that point, trigger.mode doesn't drive routing —
  // only operator action does. The trigger still classifies AUTO / BUTTON
  // / STANDARD honestly (it's a pure predicate); the drawer just stops
  // caring about the AUTO/BUTTON distinction.
  useEffect(() => {
    if (userOverride === null
        && !isLoading
        && !loadError
        && batchTrigger.enter) {
      setUserOverride('batch');
    }
  }, [userOverride, isLoading, loadError, batchTrigger.enter]);

  const inBatchMode = !isLoading && !loadError
                    && (userOverride === 'batch'
                        || (userOverride === null && batchTrigger.enter));
  // CTA shows iff operator explicitly Exit-Batched AND uncropped manual
  // work remains — gives them a one-click way back in. Partial state no
  // longer falls back to standard mode (see sticky-lift above), so the
  // "BUTTON natural mode" CTA case from M5b no longer fires here.
  const showBatchRemainingCTA = !isLoading && !loadError
                              && batchTrigger.enter
                              && userOverride === 'standard';

  // ── Drawer-level keyboard handler ────────────────────────────────────────
  //
  // Manual Crop redesign (2026-06-01): the M5c focusedFrameOpenRef
  // suppression flag was deleted along with FocusedCropFrame. In batch
  // mode, ManualCropMode owns [ / ] (prev/next), R / L (rotation),
  // ArrowLeft / ArrowRight (rotation aliases), and Enter (approve +
  // advance) via its own document-level listener. We defer to it by
  // early-returning when inBatchMode is true. Escape stays drawer-owned
  // in both modes (closes the drawer; ManualCropMode doesn't bind Esc).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (inBatchMode) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        const idx = images.findIndex(i => i.filename === selectedId);
        if (idx < images.length - 1) selectImage(images[idx + 1].filename);
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        const idx = images.findIndex(i => i.filename === selectedId);
        if (idx > 0) selectImage(images[idx - 1].filename);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, selectedId, inBatchMode]);

  const handleClose = useCallback(async () => {
    if (isDirty) {
      try { await saveJob(); } catch { /* best effort */ }
    }
    onClose();
  }, [isDirty, saveJob, onClose]);

  return (
    <div className={'jr-root' + (visible ? ' is-visible' : '')}>
      <DrawerTopBar
        jobId={jobId}
        jobQuantity={jobQuantity}
        selectedFilename={selected?.filename ?? null}
        images={images}
        reprintImages={reprintImages}
        reprintCount={reprintCount}
        isSaving={isSaving}
        colorDirty={colorDirty}
        isSendingReprint={isSendingReprint}
        lastReprintSent={lastReprintSent}
        reprintError={reprintError}
        onSave={saveJob}
        onSendReprints={sendReprints}
        onDismissReprintToast={dismissReprintToast}
        onClose={handleClose}
      />

      {isLoading ? (
        <div className="jr-state">Loading {jobId}…</div>
      ) : loadError ? (
        <div className="jr-state jr-state--error">Error: {loadError}</div>
      ) : inBatchMode ? (
        <ManualCropMode
          sidecar={sidecar}
          images={images}
          jobPath={jobPath}
          ohJobId={ohJobId}
          aiQualityThreshold={aiQualityThreshold}
          onBatchApplied={replaceSidecar}
          onExit={() => setUserOverride('standard')}
          onSentToPrint={onClose}
        />
      ) : (
        <div className="jr-body">
          {showBatchRemainingCTA && (
            <div className="jr-batch-remaining-bar">
              <button
                type="button"
                className="jr-batch-remaining-cta"
                onClick={() => setUserOverride('batch')}
                title="Continue cropping the remaining manual images in batch mode"
              >
                Batch Crop Remaining ({batchTrigger.uncroppedCount} of {batchTrigger.totalCount})
              </button>
            </div>
          )}

          <ThumbnailGrid
            images={images}
            selectedId={selectedId}
            jobPath={jobPath}
            jobArtworkSource={jobArtworkSource}
            onSelect={selectImage}
            onToggleReprint={toggleReprint}
            onFlagAllReprints={flagAllReprints}
            onClearAllReprints={clearAllReprints}
            aiQualityThreshold={aiQualityThreshold}
            onOpenOriginal={openOriginal}
            onRevealOriginal={revealOriginal}
            enhanceMultiSelectMode={enhanceMultiSelectMode}
            enhanceSelected={enhanceSelected}
            onToggleEnhanceSelected={toggleEnhanceSelected}
            enhanceStatusByFilename={enhanceBatchStatusByFilename}
          />

          {/* 2026-07-24 refinement — wrap PreviewArea in a flex-column
              so a thin top bar with filename + AI score sits directly
              ABOVE the main preview image (was rendering as a strip
              beside it because .jr-body is a flex row). Matches the
              placement of the manual mode's CropStage topbar so the
              two modes now show the same info in the same eye line. */}
          <div className="jr-preview-col">
            {selected && (
              <div className="jr-preview-topbar">
                <span className="jr-focused-filename" title={selected.filename}>
                  {selected.filename}
                </span>
                <ScoreBadge aiQuality={selected.aiQuality} threshold={aiQualityThreshold} />
              </div>
            )}
            <PreviewArea selected={selected} jobPath={jobPath} />
          </div>

          {/* Reprint section was removed from the sidebar on 2026-05-18,
              so reprintCount / onToggleReprint are no longer passed in. */}
          <ControlSidebar
            selected={selected}
            images={images}
            selectedId={selectedId}
            jobPath={jobPath}
            holdCorrection={holdCorrection}
            jobId={jobId}
            onSelectImage={selectImage}
            onUpdateCorrection={updateCorrection}
            onUpdateQty={updateQty}
            onToggleHold={toggleHold}
            onResetImage={resetImage}
            onRefreshSidecar={refreshSidecar}
            allSizeOptions={allSizeOptions}
            cropSizeOption={cropSizeOption}
            onOpenCropEditor={openCropEditor}
            enhanceMultiSelectMode={enhanceMultiSelectMode}
            enhanceSelected={enhanceSelected}
            enterEnhanceMultiSelect={enterEnhanceMultiSelect}
            exitEnhanceMultiSelect={exitEnhanceMultiSelect}
            toggleEnhanceSelected={toggleEnhanceSelected}
            selectAllForEnhance={selectAllForEnhance}
            clearEnhanceSelected={clearEnhanceSelected}
            enhanceBatchId={enhanceBatchId}
            enhanceBatchCounts={enhanceBatchCounts}
            enhanceBatchFinished={enhanceBatchFinished}
            enhanceBatchError={enhanceBatchError}
            startEnhanceBatch={startEnhanceBatch}
            cancelEnhanceBatch={cancelEnhanceBatch}
            dismissEnhanceBatch={dismissEnhanceBatch}
            onRevertEnhancement={revertEnhancement}
          />
        </div>
      )}

      {cropEditorOpen && selected && (() => {
        const orderRoot = jobPath ? jobPath.replace(/[\\/][^\\/]+[\\/]?$/, '') : null;
        const originalPath = (orderRoot && selected.originalFilename)
          ? `${orderRoot}\\${selected.originalFilename.replace(/\//g, '\\')}`
          : null;
        return (
          <CropEditor
            image={selected}
            jobPath={jobPath}
            sizeOption={cropSizeOption}
            originalPath={originalPath}
            onApply={async (rect) => await cropImage(selected.filename, cropSizeOption, rect)}
            onApplyOriginal={async (rect) => await recropFromOriginal(selected.filename, rect)}
            onApplyAndSendReprint={applyCropAndSendReprint}
            onCancel={closeCropEditor}
          />
        );
      })()}

      {/* Full-drawer overlay during the reprintCreate IPC. Rendered last
          so it stacks above the body, sidebar, and crop editor. */}
      {isSendingReprint && (
        <SendingReprintOverlay imageCount={reprintSendCount} />
      )}
    </div>
  );
}
