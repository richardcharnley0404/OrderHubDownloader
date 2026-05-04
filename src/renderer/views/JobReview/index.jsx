import { useState, useEffect, useCallback } from 'react';
import { useJobReview } from './useJobReview.js';
import { ThumbnailGrid } from './ThumbnailGrid.jsx';
import { ControlSidebar } from './ControlPanel.jsx';
import { CropEditor } from './CropEditor.jsx';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Truncate a filename to `max` characters using a middle ellipsis so both
 * the start and the file extension remain visible.
 * e.g. "PXDEMO-DR2-some-very-long-name-pages12.jpeg" → "PXDEMO-DR2-some-very…pages12.jpeg"
 */
function midEllipsis(str, max = 40) {
  if (!str || str.length <= max) return str;
  const keep  = max - 1;           // 1 char for the ellipsis
  const front = Math.ceil(keep / 2);
  const back  = keep - front;
  return str.slice(0, front) + '…' + str.slice(str.length - back);
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function DrawerTopBar({
  jobId,
  selectedFilename,
  images,
  reprintImages,
  reprintCount,
  isSaving,
  isDirty,
  onSave,
  onClose,
}) {
  const totalPrints   = images.reduce((s, i) => s + i.qtyCurrent, 0);
  const modifiedCount = images.filter(img =>
    img.qtyCurrent !== img.qtyOriginal
    || img.corrections.cyan    !== 0
    || img.corrections.magenta !== 0
    || img.corrections.yellow  !== 0
  ).length;

  const reprintJobId = reprintCount > 0 ? `${jobId}-r${reprintCount}` : null;

  return (
    <div className="jr-topbar">
      {/* Breadcrumb */}
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

      <div className="jr-topbar__spacer" />

      {/* Job meta */}
      <div className="jr-topbar__meta">
        <div className="jr-topbar__meta-jobid">{jobId}</div>
        <div className="jr-topbar__meta-count">
          {images.length} IMAGE{images.length !== 1 ? 'S' : ''}
        </div>
      </div>

      {/* Last reprint badge */}
      {reprintJobId && (
        <div className="jr-reprint-pill">
          <span className="jr-reprint-pill__text">{reprintJobId} sent ✓</span>
        </div>
      )}

      {/* Stats */}
      <div className="jr-stats">
        <StatBox label="TOTAL PRINTS" value={totalPrints} />
        <StatBox
          label="MODIFIED"
          value={modifiedCount}
          highlight={modifiedCount > 0}
        />
        <StatBox
          label="REPRINTS"
          value={reprintImages.length}
          danger={reprintImages.length > 0}
        />
      </div>

      {/* Save */}
      {isDirty && (
        <button
          onClick={onSave}
          disabled={isSaving}
          className="jr-btn-save"
        >
          {isSaving ? 'SAVING…' : 'SAVE'}
        </button>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        aria-label="Close Job Review"
        className="jr-btn-close"
      >✕</button>
    </div>
  );
}

function StatBox({ label, value, highlight = false, danger = false }) {
  const cls = 'jr-stat'
    + (highlight ? ' jr-stat--highlight' : '')
    + (danger    ? ' jr-stat--danger'    : '');
  return (
    <div className={cls}>
      <div className="jr-stat__value">{value}</div>
      <div className="jr-stat__label">{label}</div>
    </div>
  );
}

// ── Action bar ────────────────────────────────────────────────────────────────

function ActionBar({ reprintImages, reprintCount, jobId, isSaving, onSendReprints }) {
  const [sending, setSending] = useState(false);
  const [lastSent, setLastSent] = useState(null);

  if (reprintImages.length === 0 && !lastSent) return null;

  async function handleSend() {
    setSending(true);
    try {
      const result = await onSendReprints();
      setLastSent(result.reprintJobId);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="jr-actionbar">
      {lastSent ? (
        <span className="jr-actionbar__sent">{lastSent} sent ✓</span>
      ) : (
        <>
          <span className="jr-actionbar__count">
            ↺ {reprintImages.length} image{reprintImages.length !== 1 ? 's' : ''} flagged
          </span>
          <div className="jr-actionbar__spacer" />
          <button
            onClick={handleSend}
            disabled={sending || isSaving}
            className="jr-btn-send"
          >
            {sending ? 'SENDING…' : `Send ${reprintImages.length} Reprints → ${jobId}-r${reprintCount + 1}`}
          </button>
        </>
      )}
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

  // CMY overlay colour — same channel-mixing algorithm as ThumbnailCard canvas.
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
        <img
          src={imagePath}
          alt={selected.filename}
          className="jr-preview__img"
        />
      ) : (
        <div className="jr-preview__empty">No image</div>
      )}

      {/* CMY colour-correction tint overlay */}
      {overlayColor && (
        <div className="jr-preview__overlay" style={{ background: overlayColor }} />
      )}

      {/* Reprint tint overlay */}
      {reprint && (
        <div className="jr-preview__overlay jr-preview__overlay--reprint" />
      )}

      {/* Status badges — bottom corners */}
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
  // Slide-in from the right: start off-screen, animate to position after mount.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const {
    images, filenames, selected, selectedId,
    holdCorrection, isDirty, isSaving, isLoading, loadError,
    reprintCount, reprintImages,
    selectImage, updateCorrection, updateQty,
    toggleReprint, toggleHold, resetImage, resetAll,
    saveJob, sendReprints, refreshSidecar,
    // Crop-to-size
    allSizeOptions, cropEditorOpen, cropSizeOption,
    openCropEditor, closeCropEditor, cropImage,
    // AI Quality
    aiQualityThreshold,
  } = useJobReview(jobId, jobPath, ohJobId);

  // Keyboard: Escape closes, arrow keys navigate.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') handleClose();
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
  }, [images, selectedId]);

  // Close: auto-save if dirty, then call onClose.
  const handleClose = useCallback(async () => {
    if (isDirty) {
      try { await saveJob(); } catch { /* best effort */ }
    }
    onClose();
  }, [isDirty, saveJob, onClose]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={'jr-root' + (visible ? ' is-visible' : '')}>
      {/* Top bar */}
      <DrawerTopBar
        jobId={jobId}
        selectedFilename={selected?.filename ?? null}
        images={images}
        reprintImages={reprintImages}
        reprintCount={reprintCount}
        isSaving={isSaving}
        isDirty={isDirty}
        onSave={saveJob}
        onClose={handleClose}
      />

      {/* Body */}
      {isLoading ? (
        <div className="jr-state">Loading {jobId}…</div>
      ) : loadError ? (
        <div className="jr-state jr-state--error">Error: {loadError}</div>
      ) : (
        <div className="jr-body">

          {/* Left: thumbnail grid */}
          <ThumbnailGrid
            images={images}
            selectedId={selectedId}
            jobPath={jobPath}
            onSelect={selectImage}
            aiQualityThreshold={aiQualityThreshold}
          />

          {/* Centre: large preview */}
          <PreviewArea
            selected={selected}
            jobPath={jobPath}
          />

          {/* Right: controls */}
          <ControlSidebar
            selected={selected}
            images={images}
            selectedId={selectedId}
            jobPath={jobPath}
            holdCorrection={holdCorrection}
            reprintCount={reprintCount}
            jobId={jobId}
            onSelectImage={selectImage}
            onUpdateCorrection={updateCorrection}
            onUpdateQty={updateQty}
            onToggleReprint={toggleReprint}
            onToggleHold={toggleHold}
            onResetImage={resetImage}
            onRefreshSidecar={refreshSidecar}
            allSizeOptions={allSizeOptions}
            cropSizeOption={cropSizeOption}
            onOpenCropEditor={openCropEditor}
          />
        </div>
      )}

      {/* Crop editor overlay — full-screen portal over drawer content */}
      {cropEditorOpen && selected && (
        <CropEditor
          image={selected}
          jobPath={jobPath}
          sizeOption={cropSizeOption}
          onApply={async (rect) => await cropImage(selected.filename, cropSizeOption, rect)}
          onCancel={closeCropEditor}
        />
      )}

      {/* Bottom: reprint action bar */}
      {!isLoading && !loadError && (
        <ActionBar
          reprintImages={reprintImages}
          reprintCount={reprintCount}
          jobId={jobId}
          isSaving={isSaving}
          onSendReprints={sendReprints}
        />
      )}
    </div>
  );
}
