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
 * Props:
 *   jobId    string          Job identifier, e.g. "JOB-00452"
 *   jobPath  string          Absolute path to the job root folder
 *   onClose  () => void      Called after save (if dirty) is complete
 */

// ── Palette ───────────────────────────────────────────────────────────────────
const BRAND_GREEN = '#72B622';
const BG_DEEP     = '#2a3a45';
const BG_BASE     = '#324452';
const BG_PANEL    = '#2e3e4c';
const BG_INPUT    = '#2a3a45';
const BG_CARD     = '#374d5c';
const BORDER_DIM  = '#3a4e5e';
const TEXT_DIM    = '#8aa8be';
const TEXT_MUTED  = '#5d7a8a';

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
    <div style={{
      background: BG_DEEP,
      borderBottom: '1px solid #1e2c35',
      padding: '10px 16px',
      display: 'flex', alignItems: 'center', gap: 12,
      flexShrink: 0,
    }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: BRAND_GREEN, boxShadow: `0 0 8px ${BRAND_GREEN}`,
        }} />
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: BRAND_GREEN, letterSpacing: '0.05em' }}>
          OHD
        </span>
        <span style={{ color: '#4a6070', fontSize: 13 }}>›</span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: TEXT_DIM }}>
          Job Review
        </span>
        {selectedFilename && (
          <>
            <span style={{ color: '#4a6070', fontSize: 13 }}>›</span>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: 11,
              color: TEXT_MUTED, letterSpacing: '0.03em',
            }}>
              {midEllipsis(selectedFilename)}
            </span>
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Job meta */}
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: '#c8d8e0', fontWeight: 500 }}>
          {jobId}
        </div>
        <div style={{ fontSize: 10, color: TEXT_MUTED, letterSpacing: '0.06em' }}>
          {images.length} IMAGE{images.length !== 1 ? 'S' : ''}
        </div>
      </div>

      {/* Last reprint badge */}
      {reprintJobId && (
        <div style={{
          background: '#1e0a0a', border: '1px solid #cc3333',
          borderRadius: 4, padding: '4px 10px',
        }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#ff6666' }}>
            {reprintJobId} sent ✓
          </span>
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8 }}>
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
          style={{
            background: BRAND_GREEN, border: 'none', borderRadius: 4,
            color: '#fff', fontSize: 11, fontFamily: "'DM Mono', monospace",
            padding: '5px 14px', cursor: isSaving ? 'wait' : 'pointer',
            opacity: isSaving ? 0.6 : 1, letterSpacing: '0.05em',
          }}
        >
          {isSaving ? 'SAVING…' : 'SAVE'}
        </button>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        aria-label="Close Job Review"
        style={{
          background: 'none', border: '1px solid #3a4e5e',
          borderRadius: 4, color: TEXT_DIM,
          padding: '5px 10px', cursor: 'pointer', fontSize: 14,
          lineHeight: 1,
        }}
      >✕</button>
    </div>
  );
}

function StatBox({ label, value, highlight = false, danger = false }) {
  return (
    <div style={{
      background: danger ? '#1e0a0a' : BG_INPUT,
      border: `1px solid ${danger ? '#cc3333' : '#2a3a45'}`,
      borderRadius: 4, padding: '4px 12px', textAlign: 'center',
    }}>
      <div style={{
        fontSize: 16, fontWeight: 600,
        color: danger ? '#ff6666' : highlight ? BRAND_GREEN : TEXT_MUTED,
        fontFamily: "'DM Mono', monospace",
      }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: TEXT_MUTED, letterSpacing: '0.08em' }}>
        {label}
      </div>
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
    <div style={{
      background: '#1a0808', borderTop: '1px solid #cc333344',
      padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
      flexShrink: 0,
    }}>
      {lastSent ? (
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#ff6666' }}>
          {lastSent} sent ✓
        </span>
      ) : (
        <>
          <span style={{ fontSize: 12, color: '#ff8888' }}>
            ↺ {reprintImages.length} image{reprintImages.length !== 1 ? 's' : ''} flagged
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleSend}
            disabled={sending || isSaving}
            style={{
              background: '#cc3333', border: 'none', borderRadius: 4,
              color: '#fff', fontSize: 12, fontFamily: "'DM Mono', monospace",
              padding: '7px 20px', cursor: 'pointer',
              opacity: (sending || isSaving) ? 0.6 : 1,
              letterSpacing: '0.04em',
            }}
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
    <div style={{
      flex: 1, position: 'relative',
      background: BG_PANEL, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {imagePath ? (
        <img
          src={imagePath}
          alt={selected.filename}
          style={{
            width: '100%', height: '100%',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      ) : (
        <div style={{ color: TEXT_MUTED, fontSize: 13, fontFamily: "'DM Mono', monospace" }}>
          No image
        </div>
      )}

      {/* CMY colour-correction tint overlay */}
      {overlayColor && (
        <div style={{
          position: 'absolute', inset: 0,
          background: overlayColor,
          pointerEvents: 'none',
        }} />
      )}

      {/* Reprint tint overlay */}
      {reprint && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(220,50,50,0.18)',
          pointerEvents: 'none',
        }} />
      )}

      {/* Status badges — bottom corners */}
      {hasCorrections && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(114,182,34,0.9)', borderRadius: 3,
          padding: '2px 8px', fontSize: 10,
          fontFamily: "'DM Mono', monospace", color: '#fff',
          pointerEvents: 'none',
        }}>CORRECTED</div>
      )}
      {reprint && (
        <div style={{
          position: 'absolute', bottom: 12, right: 12,
          background: 'rgba(204,51,51,0.9)', borderRadius: 3,
          padding: '2px 8px', fontSize: 10,
          fontFamily: "'DM Mono', monospace", color: '#fff',
          pointerEvents: 'none',
        }}>FLAGGED FOR REPRINT</div>
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
    <>
      {/* Scoped slider thumb CSS */}
      <style>{`
        .ohd-job-review input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px;
          border-radius: 50%;
          background: #c8d8e0;
          border: 2px solid #415564;
          cursor: pointer;
          box-shadow: 0 0 0 3px rgba(114,182,34,0.15);
        }
        .ohd-job-review input[type=range]::-webkit-slider-thumb:hover {
          background: #72B622;
          border-color: #72B622;
        }
        .ohd-job-review ::-webkit-scrollbar { width: 6px; height: 6px; }
        .ohd-job-review ::-webkit-scrollbar-track { background: #1e2c35; }
        .ohd-job-review ::-webkit-scrollbar-thumb { background: #4a6070; border-radius: 3px; }
        .ohd-job-review ::-webkit-scrollbar-thumb:hover { background: #5d7a8a; }
      `}</style>

      <div
        className="ohd-job-review"
        style={{
          position:   'fixed',
          inset:      0,
          zIndex:     100,
          display:    'flex',
          flexDirection: 'column',
          background: BG_BASE,
          fontFamily: "'DM Sans', system-ui, sans-serif",
          color:      '#c8d8e0',
          transform:  visible ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s ease',
        }}
      >
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
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'DM Mono', monospace", fontSize: 13, color: TEXT_MUTED,
          }}>
            Loading {jobId}…
          </div>
        ) : loadError ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'DM Mono', monospace", fontSize: 13, color: '#cc4444',
          }}>
            Error: {loadError}
          </div>
        ) : (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

            {/* Left: thumbnail grid */}
            <ThumbnailGrid
              images={images}
              selectedId={selectedId}
              jobPath={jobPath}
              onSelect={selectImage}
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
    </>
  );
}
