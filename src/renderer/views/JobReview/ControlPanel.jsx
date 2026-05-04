import { useState, useEffect, useRef } from 'react';
import { CMYSliders } from './CMYSliders.jsx';

/**
 * src/renderer/views/JobReview/ControlPanel.jsx
 *
 * Right-hand panel.  Hosts:
 *   - Large preview canvas area (handled by ThumbnailCard at large size)
 *   - Prev / Next navigation buttons
 *   - QTY control
 *   - CMY colour correction sliders
 *   - Hold Correction toggle
 *   - Reprint flag toggle
 *   - Reset image button
 *
 * Styling: classes defined in src/renderer/job-review.css. Theming follows
 * the app-wide --app-* tokens (see styles.css).
 *
 * Props (all from useJobReview):
 *   images           ImageEntry[]
 *   selected         ImageEntry | null
 *   selectedId       string
 *   jobPath          string
 *   holdCorrection   boolean
 *   reprintCount     number
 *   jobId            string
 *   onSelectImage    (filename) => void
 *   onUpdateCorrection (channel, value) => void
 *   onUpdateQty      (filename, delta) => void
 *   onToggleReprint  (filename) => void
 *   onToggleHold     () => void
 *   onResetImage     (filename) => Promise<void>
 */

// ── Enhancement models ────────────────────────────────────────────────────────
const MODELS = [
  { value: 'Standard V2',      label: 'Standard V2' },
  { value: 'High Fidelity V2', label: 'High Fidelity V2' },
  { value: 'Low Resolution V2', label: 'Low Resolution V2' },
  { value: 'Recovery V2',      label: 'Recovery V2' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return <div className="jr-section-label">{children}</div>;
}

function Divider() {
  return <div className="jr-divider" />;
}

// ── QTY control ───────────────────────────────────────────────────────────────

function QtyControl({ image, onUpdateQty }) {
  const { filename, qtyCurrent, qtyOriginal } = image;
  const isModified = qtyCurrent !== qtyOriginal;

  return (
    <div>
      <SectionLabel>Quantity</SectionLabel>
      <div className="jr-qty">
        <button
          onClick={() => onUpdateQty(filename, -1)}
          aria-label="Decrease quantity"
          className="jr-qty__btn"
        >−</button>

        <div className="jr-qty__readout">
          <div className={'jr-qty__value' + (isModified ? ' is-modified' : '')}>
            {qtyCurrent}
          </div>
          {isModified && (
            <div className="jr-qty__orig">orig: {qtyOriginal}</div>
          )}
        </div>

        <button
          onClick={() => onUpdateQty(filename, +1)}
          aria-label="Increase quantity"
          className="jr-qty__btn"
        >+</button>
      </div>
    </div>
  );
}

// ── Hold Correction toggle ─────────────────────────────────────────────────────

function HoldToggle({ holdCorrection, onToggleHold }) {
  return (
    <div
      onClick={onToggleHold}
      role="checkbox"
      aria-checked={holdCorrection}
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onToggleHold()}
      className={'jr-toggle' + (holdCorrection ? ' is-on' : '')}
    >
      <div className="jr-toggle__check">
        {holdCorrection && <span className="jr-toggle__check-mark">✓</span>}
      </div>
      <div>
        <div className="jr-toggle__label">Hold Correction</div>
        <div className="jr-toggle__hint">Apply to all images</div>
      </div>
    </div>
  );
}

// ── Reprint toggle ─────────────────────────────────────────────────────────────

function ReprintToggle({ image, reprintCount, jobId, onToggleReprint }) {
  const { filename, reprint } = image;
  const nextN = reprintCount + 1;

  return (
    <div>
      <SectionLabel>Reprint</SectionLabel>
      <div
        onClick={() => onToggleReprint(filename)}
        role="checkbox"
        aria-checked={reprint}
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && onToggleReprint(filename)}
        className={'jr-reprint' + (reprint ? ' is-on' : '')}
      >
        <div className="jr-reprint__dot">
          {reprint && <span className="jr-reprint__dot-mark">✕</span>}
        </div>
        <div>
          <div className="jr-reprint__label">
            {reprint ? 'Flagged for Reprint' : 'Flag for Reprint'}
          </div>
          <div className="jr-reprint__hint">
            {reprintCount > 0
              ? `next: ${jobId}-r${nextN}`
              : `creates ${jobId}-r1`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── AI Enhancement panel ──────────────────────────────────────────────────────

function EnhancementPanel({ selected, jobId, jobPath, onRefreshSidecar }) {
  const [hasKey,          setHasKey]          = useState(false);
  const [provider,        setProvider]        = useState('local');
  const [autoEnhance,     setAutoEnhance]     = useState(false);
  const [model,           setModel]           = useState('Standard V2');
  const [faceEnhancement, setFaceEnhancement] = useState(false);
  const [phase,           setPhase]           = useState('idle'); // 'idle' | 'processing' | 'error'
  const [predictionId,    setPredictionId]    = useState(null);
  const [error,           setError]           = useState(null);
  const pollRef = useRef(null);

  // Load config defaults on mount.
  // hasKey semantics:
  //   - 'local' (Pixfizz AI): no key needed — always ready (true).
  //   - 'topaz': true iff topazApiKey is configured.
  useEffect(() => {
    window.electronAPI.getConfig()
      .then(cfg => {
        // Defensive remap of legacy stored 'replicate' value.
        let p = cfg.enhancementProvider || 'local';
        if (p === 'replicate') p = 'local';
        setProvider(p);
        setHasKey(p === 'local' ? true : Boolean(cfg.topazApiKey));
        setAutoEnhance(Boolean(cfg.autoEnhance));
        const defaultModel = p === 'topaz'
          ? (cfg.topazDefaultModel || 'Standard V2')
          : 'realesr-general-x4v3';
        setModel(defaultModel);
        setFaceEnhancement(Boolean(cfg.enhancementFaceEnhancement));
      })
      .catch(() => {});
  }, []);

  // Clear processing state when the selected image changes
  const filename = selected?.filename;
  useEffect(() => {
    stopPolling();
    setPhase('idle');
    setPredictionId(null);
    setError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  // Auto-enhance: trigger when image changes if enabled and not already enhanced
  useEffect(() => {
    if (autoEnhance && hasKey && filename && !selected?.enhanced && phase === 'idle') {
      handleRun();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  // Cleanup interval on unmount
  useEffect(() => () => stopPolling(), []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(id) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const result = await window.electronAPI.enhancementStatus({ predictionId: id });
        if (result.status === 'succeeded') {
          stopPolling();
          setPredictionId(null);
          setPhase('idle');
          await onRefreshSidecar(); // Reload sidecar to pick up enhanced:true
        } else if (result.status === 'failed' || result.status === 'canceled') {
          stopPolling();
          setPredictionId(null);
          setPhase('error');
          setError(result.error || 'Enhancement failed');
        }
        // 'starting' | 'processing' — keep polling
      } catch (err) {
        stopPolling();
        setPredictionId(null);
        setPhase('error');
        setError(err.message);
      }
    }, 3000);
  }

  async function handleRun() {
    setPhase('processing');
    setError(null);
    try {
      const result = await window.electronAPI.enhancementRun({
        jobId,
        jobPath,
        filename: selected.filename,
        model,
        options: { faceEnhancement },
      });
      if (!result.predictionId) throw new Error(result.error || 'Failed to start enhancement');
      setPredictionId(result.predictionId);
      startPolling(result.predictionId);
    } catch (err) {
      setPhase('error');
      setError(err.message);
    }
  }

  async function handleCancel() {
    const id = predictionId;
    stopPolling();
    setPredictionId(null);
    setPhase('idle');
    setError(null);
    if (id) {
      try {
        await window.electronAPI.enhancementCancel({ predictionId: id });
      } catch (_) { /* ignore — may have already finished */ }
    }
  }

  // ── State: provider not ready ──────────────────────────────────────────────
  // For Topaz this means the API key isn't set. The 'local' branch
  // can't reach this state because hasKey is hard-coded true above
  // — Pixfizz AI Enhancement requires no configuration.
  if (!hasKey) {
    return (
      <div>
        <SectionLabel>AI Enhancement</SectionLabel>
        <div className="jr-enh-card">
          <div className="jr-enh-message">
            Configure a Topaz API key in Settings to enable AI enhancement.
          </div>
          <button
            onClick={() => {
              // Close drawer and switch to AI Enhancement settings
              window.dispatchEvent(new CustomEvent('ohd:close-job-review'));
              setTimeout(() => {
                const settingsTab = document.querySelector('.tab-bar .tab[data-tab="settings"]');
                if (settingsTab) settingsTab.click();
                setTimeout(() => {
                  const aiTab = document.querySelector('.settings-subtab[data-subtab="aienhancement"]');
                  if (aiTab) aiTab.click();
                }, 80);
              }, 300);
            }}
            className="jr-enh-btn jr-enh-btn--secondary"
          >
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  // ── State: processing ───────────────────────────────────────────────────────
  if (phase === 'processing') {
    return (
      <div>
        <SectionLabel>AI Enhancement</SectionLabel>
        <div className="jr-enh-card jr-enh-card--processing">
          <div className="jr-enh-status jr-enh-status--processing">
            ⟳ Enhancing via {provider === 'topaz' ? 'Topaz' : 'Pixfizz AI'}…
          </div>
          <div className="jr-enh-status-hint">
            {provider === 'topaz'
              ? 'This may take 30–60 seconds (cloud)'
              : 'Running locally — typical 6 MP photo takes ~50 seconds'}
          </div>
          <button onClick={handleCancel} className="jr-enh-btn jr-enh-btn--cancel">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── State: already enhanced ─────────────────────────────────────────────────
  if (selected?.enhanced) {
    return (
      <div>
        <SectionLabel>AI Enhancement</SectionLabel>
        <div className="jr-enh-card jr-enh-card--enhanced">
          <div className="jr-enh-status">
            ✓ Enhanced via {
              selected.enhancementSource === 'topaz-direct' ? 'Topaz' :
              selected.enhancementSource === 'local' ? 'Pixfizz AI' :
              'AI Enhancement'
            }
          </div>
          <div className="jr-enh-status-hint">
            Model: {selected.enhancementModel || '—'}
          </div>
          <button onClick={handleRun} className="jr-enh-btn jr-enh-btn--primary">
            Re-enhance
          </button>
        </div>
      </div>
    );
  }

  // ── State: ready / error ────────────────────────────────────────────────────
  return (
    <div>
      <SectionLabel>AI Enhancement</SectionLabel>
      <div className="jr-enh-card">
        {/* Model selector */}
        <div className="jr-enh-field">
          <div className="jr-crop-label">MODEL</div>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            className="jr-select"
          >
            {MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>

        {/* Face enhancement checkbox */}
        <div
          onClick={() => setFaceEnhancement(f => !f)}
          role="checkbox"
          aria-checked={faceEnhancement}
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && setFaceEnhancement(f => !f)}
          className={'jr-enh-checkbox' + (faceEnhancement ? ' is-on' : '')}
        >
          <div className="jr-enh-checkbox__box">
            {faceEnhancement && <span className="jr-enh-checkbox__mark">✓</span>}
          </div>
          <span className="jr-enh-checkbox__label">Face enhancement</span>
        </div>

        {/* Error message */}
        {error && <div className="jr-enh-error">{error}</div>}

        {/* Run button */}
        <button onClick={handleRun} className="jr-enh-btn jr-enh-btn--primary">
          ✨ Upscale This Image
        </button>
      </div>
    </div>
  );
}


// ── Crop-to-size section ──────────────────────────────────────────────────────────────────

// Built-in common print sizes always available in the dropdown.
// If a channel mapping exists with the same dimensions it replaces the entry
// so that the routing override is also applied after cropping.
const COMMON_PRINT_SIZES = [
  { id: '__3x3',   w: 3,    h: 3,    label: '3×3"'   },
  { id: '__4x4',   w: 4,    h: 4,    label: '4×4"'   },
  { id: '__4x6',   w: 4,    h: 6,    label: '4×6"'   },
  { id: '__5x5',   w: 5,    h: 5,    label: '5×5"'   },
  { id: '__5x7',   w: 5,    h: 7,    label: '5×7"'   },
  { id: '__6x6',   w: 6,    h: 6,    label: '6×6"'   },
  { id: '__6x8',   w: 6,    h: 8,    label: '6×8"'   },
  { id: '__8x8',   w: 8,    h: 8,    label: '8×8"'   },
  { id: '__8x10',  w: 8,    h: 10,   label: '8×10"'  },
  { id: '__10x10', w: 10,   h: 10,   label: '10×10"' },
  { id: '__10x13', w: 10,   h: 13,   label: '10×13"' },
  { id: '__12x12', w: 12,   h: 12,   label: '12×12"' },
];

function buildSizeOptions(allSizeOptions) {
  const options = COMMON_PRINT_SIZES.map(s => ({ ...s }));
  for (const opt of allSizeOptions) {
    const idx = options.findIndex(s => s.w === opt.w && s.h === opt.h);
    if (idx >= 0) options[idx] = { ...options[idx], ...opt };
    else options.push({ ...opt });
  }
  return options;
}

function CropSection({ selected, allSizeOptions, cropSizeOption, onOpenCropEditor }) {
  const sizeOptions = buildSizeOptions(allSizeOptions);

  const [selectedId, setSelectedId] = useState(cropSizeOption?.id || '');

  useEffect(() => {
    setSelectedId(cropSizeOption?.id || '');
  }, [cropSizeOption?.id]);

  const selectedOption = sizeOptions.find(s => s.id === selectedId) || null;
  const cropApplied    = selected?.cropApplied && selected?.cropRect;

  return (
    <div>
      <SectionLabel>Crop to Size</SectionLabel>
      <div className="jr-crop-card">
        {/* Size dropdown */}
        <div className="jr-crop-field">
          <div className="jr-crop-label">TARGET SIZE</div>
          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            className="jr-select"
          >
            <option value="">— select size —</option>
            {sizeOptions.map(opt => (
              <option key={opt.id} value={opt.id}>
                {opt.label}{opt.channelNumber != null ? ` — ch.${opt.channelNumber} ✓` : ''}
              </option>
            ))}
          </select>
          {selectedOption?.channelMappingId && (
            <div className="jr-crop-routing">
              Channel {selectedOption.channelNumber} — routing will be overridden
            </div>
          )}
        </div>

        {/* Crop applied badge */}
        {cropApplied && (
          <div className="jr-crop-applied">✂ CROPPED</div>
        )}

        {/* Crop / re-crop button */}
        <button
          disabled={!selectedOption}
          onClick={() => onOpenCropEditor(selectedOption)}
          className="jr-btn-crop"
        >
          {cropApplied ? '✂ Re-Crop' : '✂ Crop Image'}
        </button>
      </div>
    </div>
  );
}

// ── Sidebar (exported separately so index.jsx composes it) ────────────────────

export function ControlSidebar({
  selected,
  images,
  selectedId,
  jobPath,
  holdCorrection,
  reprintCount,
  jobId,
  onSelectImage,
  onUpdateCorrection,
  onUpdateQty,
  onToggleReprint,
  onToggleHold,
  onResetImage,
  onRefreshSidecar,
  allSizeOptions,
  cropSizeOption,
  onOpenCropEditor,
}) {
  const [resetting, setResetting] = useState(false);

  if (!selected) return null;

  const hasCorrections = selected.corrections.cyan    !== 0
                      || selected.corrections.magenta !== 0
                      || selected.corrections.yellow  !== 0;

  async function handleReset() {
    setResetting(true);
    try { await onResetImage(selected.filename); }
    finally { setResetting(false); }
  }

  return (
    <div className="jr-sidebar">
      {/* QTY */}
      <QtyControl image={selected} onUpdateQty={onUpdateQty} />

      <Divider />

      {/* CMY */}
      <div>
        <div className="jr-cmy-header">
          <SectionLabel>Colour Correction</SectionLabel>
          {hasCorrections && (
            <button
              onClick={handleReset}
              disabled={resetting}
              className="jr-btn-reset"
            >
              {resetting ? '…' : 'RESET'}
            </button>
          )}
        </div>

        <CMYSliders
          corrections={selected.corrections}
          onChange={onUpdateCorrection}
        />

        <HoldToggle holdCorrection={holdCorrection} onToggleHold={onToggleHold} />
      </div>

      <Divider />

      {/* Reprint */}
      <ReprintToggle
        image={selected}
        reprintCount={reprintCount}
        jobId={jobId}
        onToggleReprint={onToggleReprint}
      />

      <Divider />

      {/* Crop to size */}
      <CropSection
        selected={selected}
        allSizeOptions={allSizeOptions}
        cropSizeOption={cropSizeOption}
        onOpenCropEditor={onOpenCropEditor}
      />

      <Divider />

      {/* AI Enhancement */}
      <EnhancementPanel
        selected={selected}
        jobId={jobId}
        jobPath={jobPath}
        onRefreshSidecar={onRefreshSidecar}
      />
    </div>
  );
}
