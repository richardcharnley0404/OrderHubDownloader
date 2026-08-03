import { useState, useEffect, useRef } from 'react';
import { CMYSliders } from './CMYSliders.jsx';
import { buildSizeOptions } from '../../../shared/cropSizeDropdown.js';

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
 *   jobId            string         (used by AI Enhancement panel)
 *   onSelectImage    (filename) => void
 *   onUpdateCorrection (channel, value) => void
 *   onUpdateQty      (filename, delta) => void
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

// ── Reprint toggle (removed 2026-05-18) ────────────────────────────────────────
//
// The side-panel "Flag for Reprint" was a duplicate of the per-thumbnail
// flag — both called the same `onToggleReprint(filename)` handler. Removed
// after Job Review UX simplification; the thumbnail flag is now the single
// affordance. The bulk Flag-all/Clear-all controls in the thumbnail grid
// header cover the "set every image at once" case.

// ── AI Enhancement panel — router ─────────────────────────────────────────────
//
// Perfectly Clear (M3, 2026-07-03) overrides the legacy provider surface
// whenever Jobs scope is enabled + has ≥1 config — matches the main-side
// `getProvider()` precedence in enhancementManager.js. Disabling PC in
// Settings makes the legacy Topaz / Pixfizz-AI panel visible again as a
// fallback, per the M3 decision to keep old providers dormant-but-reachable.
//
// The route is decided from `perfectlyClear.jobs.enabled + configs.length`.
// Config is loaded once on mount; toggling the setting requires a Job Review
// reopen (mirrors how the legacy panel loads `enhancementProvider` once).

function EnhancementPanel(props) {
  const [route, setRoute] = useState(null); // 'perfectly-clear' | 'legacy'
  const [pcJobs, setPcJobs] = useState(null); // { enabled, autoApplyConfigId, configs: [...] } | null

  useEffect(() => {
    window.electronAPI.getConfig()
      .then((cfg) => {
        const pc = cfg && cfg.perfectlyClear && cfg.perfectlyClear.jobs;
        setPcJobs(pc || { enabled: false, autoApplyConfigId: null, configs: [] });
        if (pc && pc.enabled && Array.isArray(pc.configs) && pc.configs.length > 0) {
          setRoute('perfectly-clear');
        } else if (pc && pc.enabled) {
          // Enabled but not configured — surface the not-ready CTA rather
          // than fall back to the legacy Topaz/Pixfizz-AI UI (operator
          // clearly wants PC; showing Topaz would be confusing).
          setRoute('pc-not-configured');
        } else {
          setRoute('legacy');
        }
      })
      .catch(() => setRoute('legacy'));
  }, []);

  if (route === null) return null; // brief boot-time gap; avoids flicker
  if (route === 'perfectly-clear') {
    return <PerfectlyClearPanel {...props} pcJobs={pcJobs} />;
  }
  if (route === 'pc-not-configured') {
    return <PerfectlyClearNotConfigured />;
  }
  return <LegacyEnhancementPanel {...props} />;
}

// Mirrors the LegacyEnhancementPanel `not-ready` phase pattern — offers a
// one-click jump into the AI Enhancement settings subtab where the
// operator can add a Perfectly Clear config.
function PerfectlyClearNotConfigured() {
  return (
    <div>
      <SectionLabel>AI Enhancement</SectionLabel>
      <div className="jr-enh-card">
        <div className="jr-enh-message">
          Perfectly Clear is enabled but no channels are configured yet.
          Add one in Settings → AI Enhancement.
        </div>
        <button
          onClick={() => {
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

// ── AI Enhancement panel — Perfectly Clear (M3) ───────────────────────────────
//
// Replaces the legacy single-image Topaz / Pixfizz-AI panel with a
// multi-select + Select All flow. One / many / all images can be enhanced
// via a single QuickServer batch; per-file progress is badged directly on
// the thumbnail cards (via useJobReview batch state). Revert appears when
// the selected image is currently PC-enhanced; it restores the pre-PC
// snapshot without touching crop fields.
//
// Not-ready state: PC.jobs disabled or has no configs. Mirrors the
// Legacy panel's `not-ready` phase — Open Settings button jumps into the
// AI Enhancement subtab.

function PerfectlyClearPanel({
  selected,
  pcJobs,
  enhanceMultiSelectMode,
  enhanceSelected,
  enterEnhanceMultiSelect,
  exitEnhanceMultiSelect,
  toggleEnhanceSelected,
  selectAllForEnhance,
  clearEnhanceSelected,
  enhanceBatchId,
  enhanceBatchCounts,
  enhanceBatchFinished,
  enhanceBatchError,
  startEnhanceBatch,
  cancelEnhanceBatch,
  dismissEnhanceBatch,
  onRevertEnhancement,
}) {
  const configs = (pcJobs && pcJobs.configs) || [];

  // Persist last-used config in localStorage so the dropdown defaults to
  // the operator's most-recent pick instead of always first. Falls back
  // to the auto-apply hint (which Jobs doesn't currently surface, but
  // honouring the shape means an operator who set it via /raw config
  // still gets their intended default), then the first config.
  const LS_KEY = 'ohd.jobReview.pc.lastConfigId';
  const initialConfigId = (() => {
    try {
      const stored = window.localStorage.getItem(LS_KEY);
      if (stored && configs.some(c => c.id === stored)) return stored;
    } catch (_) { /* ignore */ }
    if (pcJobs && pcJobs.autoApplyConfigId && configs.some(c => c.id === pcJobs.autoApplyConfigId)) {
      return pcJobs.autoApplyConfigId;
    }
    return configs[0] ? configs[0].id : null;
  })();
  const [selectedConfigId, setSelectedConfigId] = useState(initialConfigId);

  function onConfigChange(e) {
    const id = e.target.value;
    setSelectedConfigId(id);
    try { window.localStorage.setItem(LS_KEY, id); } catch (_) { /* ignore */ }
  }

  const batchInFlight = Boolean(enhanceBatchId) && !enhanceBatchFinished;
  const showBatchSummary = Boolean(enhanceBatchId) && enhanceBatchFinished;
  const singleFilename = selected?.filename || null;

  async function handleEnhanceThis() {
    if (!singleFilename) return;
    try {
      await startEnhanceBatch({ filenames: [singleFilename], configId: selectedConfigId });
    } catch (_) { /* error state carried in enhanceBatchError */ }
  }

  async function handleEnhanceSelected() {
    const filenames = Array.from(enhanceSelected || []);
    if (filenames.length === 0) return;
    try {
      await startEnhanceBatch({ filenames, configId: selectedConfigId });
      // Leave multi-select mode active so the operator sees the batch
      // progress on the cards they picked; they can Exit Multi-Select
      // manually or dismiss the batch card when done.
    } catch (_) { /* error state carried in enhanceBatchError */ }
  }

  async function handleRevert() {
    if (!singleFilename) return;
    try { await onRevertEnhancement(singleFilename); } catch (_) { /* silent — surfaced by refresh */ }
  }

  // Batch-in-flight card. Wins over any other state so the operator
  // can't accidentally kick a second batch on top.
  if (batchInFlight) {
    const counts = enhanceBatchCounts || { queued: 0, enhanced: 0, rejected: 0, timeout: 0, cancelled: 0, error: 0 };
    const done = counts.enhanced + counts.rejected + counts.timeout + counts.cancelled + counts.error;
    const total = done + (counts.queued || 0);
    return (
      <div>
        <SectionLabel>AI Enhancement</SectionLabel>
        <div className="jr-enh-card jr-enh-card--processing">
          <div className="jr-enh-status jr-enh-status--processing">
            ⟳ Enhancing via Perfectly Clear…
          </div>
          <div className="jr-enh-status-hint">
            {done} / {total} complete
            {counts.rejected + counts.timeout + counts.error > 0
              ? ` — ${counts.rejected + counts.timeout + counts.error} not enhanced`
              : ''}
          </div>
          <button onClick={cancelEnhanceBatch} className="jr-enh-btn jr-enh-btn--cancel">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel>AI Enhancement</SectionLabel>
      <div className="jr-enh-card">
        {/* Config selector — hidden when only one config exists (single-
            channel operators shouldn't see a redundant one-option select).
            Persisted last-choice + fallback logic lives in initialConfigId
            above. */}
        {configs.length > 1 && (
          <div className="jr-enh-field">
            <div className="jr-crop-label">CHANNEL</div>
            <select
              value={selectedConfigId || ''}
              onChange={onConfigChange}
              className="jr-select"
            >
              {configs.map(cfg => (
                <option key={cfg.id} value={cfg.id}>
                  {cfg.friendlyName || '(unnamed)'}
                </option>
              ))}
            </select>
          </div>
        )}

        {enhanceBatchError && <div className="jr-enh-error">{enhanceBatchError}</div>}

        {/* Batch-just-finished summary. Sits above the per-image actions
            so the operator sees "26 done, 2 rejected" before deciding
            what to do next. Dismiss clears the map + per-card badges. */}
        {showBatchSummary && enhanceBatchCounts && (
          <div className="jr-enh-batch-summary">
            <div className="jr-enh-batch-summary__line">
              <strong>{enhanceBatchCounts.enhanced}</strong> enhanced
              {enhanceBatchCounts.rejected > 0 && <> · <strong>{enhanceBatchCounts.rejected}</strong> rejected</>}
              {enhanceBatchCounts.timeout  > 0 && <> · <strong>{enhanceBatchCounts.timeout}</strong> timed out</>}
              {enhanceBatchCounts.cancelled > 0 && <> · <strong>{enhanceBatchCounts.cancelled}</strong> cancelled</>}
              {enhanceBatchCounts.error   > 0 && <> · <strong>{enhanceBatchCounts.error}</strong> errored</>}
            </div>
            <button onClick={dismissEnhanceBatch} className="jr-enh-btn jr-enh-btn--secondary">
              Dismiss
            </button>
          </div>
        )}

        {/* Single-image state: Revert / Re-enhance for PC-enhanced;
            Enhance for un-enhanced. Multi-select is orthogonal — its
            controls sit below and stay visible in either state. */}
        {selected && selected.enhanced && selected.enhancementSource === 'perfectly-clear' ? (
          <div className="jr-enh-single">
            <div className="jr-enh-status">
              ✓ Enhanced via Perfectly Clear
            </div>
            <div className="jr-enh-status-hint">
              Channel: {selected.enhancementModel || '—'}
            </div>
            <button onClick={handleEnhanceThis} className="jr-enh-btn jr-enh-btn--primary">
              Re-Enhance This Image
            </button>
            <button onClick={handleRevert} className="jr-enh-btn jr-enh-btn--secondary">
              Revert to Original
            </button>
          </div>
        ) : (
          <button
            onClick={handleEnhanceThis}
            disabled={!singleFilename}
            className="jr-enh-btn jr-enh-btn--primary"
          >
            ✨ Enhance This Image
          </button>
        )}

        {/* Multi-select controls. Enter multi-select toggles the checkbox
            overlay on every card (ThumbnailCard reads enhanceMultiSelectMode);
            Select All / Clear operate on the enhanceSelected set;
            "Enhance Selected (n)" fires a batch. Exit clears the set. */}
        {!enhanceMultiSelectMode ? (
          <button
            onClick={enterEnhanceMultiSelect}
            className="jr-enh-btn jr-enh-btn--secondary"
          >
            Select Multiple Images…
          </button>
        ) : (
          <div className="jr-enh-multi">
            <div className="jr-enh-multi__hint">
              {enhanceSelected && enhanceSelected.size > 0
                ? `${enhanceSelected.size} selected`
                : 'Tick the box on each image to select'}
            </div>
            <div className="jr-enh-multi__row">
              <button
                onClick={selectAllForEnhance}
                className="jr-enh-btn jr-enh-btn--secondary"
              >
                Select All
              </button>
              <button
                onClick={clearEnhanceSelected}
                disabled={!enhanceSelected || enhanceSelected.size === 0}
                className="jr-enh-btn jr-enh-btn--secondary"
              >
                Clear
              </button>
            </div>
            <button
              onClick={handleEnhanceSelected}
              disabled={!enhanceSelected || enhanceSelected.size === 0}
              className="jr-enh-btn jr-enh-btn--primary"
            >
              Enhance Selected ({enhanceSelected ? enhanceSelected.size : 0})
            </button>
            <button
              onClick={exitEnhanceMultiSelect}
              className="jr-enh-btn jr-enh-btn--secondary"
            >
              Exit Multi-Select
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI Enhancement panel — legacy (Topaz / Pixfizz-AI) ────────────────────────
//
// Preserved as a fallback for operators who disable Perfectly Clear in
// settings. The M3 decision was to hide-not-delete the old providers so
// operators can still fall back if the QuickServer round-trip proves too
// slow. Behaviour is unchanged from before M3.

function LegacyEnhancementPanel({ selected, jobId, jobPath, onRefreshSidecar }) {
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

// `buildSizeOptions` + `COMMON_PRINT_SIZES` now live in
// `src/shared/cropSizeDropdown.js` — extracted so the merge rules
// (which have real reroute consequences — see the Fuji PIC Pro
// review-fixes doc, unverified section) are unit-testable from
// `node --test`. Imported at the top of this file.

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
  jobId,
  onSelectImage,
  onUpdateCorrection,
  onUpdateQty,
  onToggleHold,
  onResetImage,
  onRefreshSidecar,
  allSizeOptions,
  cropSizeOption,
  onOpenCropEditor,
  // Perfectly Clear (M3, 2026-07-03)
  enhanceMultiSelectMode,
  enhanceSelected,
  enterEnhanceMultiSelect,
  exitEnhanceMultiSelect,
  toggleEnhanceSelected,
  selectAllForEnhance,
  clearEnhanceSelected,
  enhanceBatchId,
  enhanceBatchCounts,
  enhanceBatchFinished,
  enhanceBatchError,
  startEnhanceBatch,
  cancelEnhanceBatch,
  dismissEnhanceBatch,
  onRevertEnhancement,
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
        onRevertEnhancement={onRevertEnhancement}
      />
    </div>
  );
}
