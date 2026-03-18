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

// ── Palette ───────────────────────────────────────────────────────────────────
const BRAND_GREEN = '#72B622';
const BG_DEEP     = '#2a3a45';
const BG_BASE     = '#324452';
const BORDER_DIM  = '#3a4e5e';
const TEXT_DIM    = '#8aa8be';
const TEXT_MUTED  = '#5d7a8a';
const PURPLE_AI   = '#9b59b6';

// ── Enhancement models ────────────────────────────────────────────────────────
const MODELS = [
  { value: 'Standard V2',      label: 'Standard V2' },
  { value: 'High Fidelity V2', label: 'High Fidelity V2' },
  { value: 'Low Resolution V2', label: 'Low Resolution V2' },
  { value: 'Recovery V2',      label: 'Recovery V2' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontFamily: "'DM Mono', monospace",
      color: TEXT_MUTED, letterSpacing: '0.1em',
      textTransform: 'uppercase', marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid #1e2c35', margin: '4px 0' }} />;
}

// ── QTY control ───────────────────────────────────────────────────────────────

function QtyControl({ image, onUpdateQty }) {
  const { filename, qtyCurrent, qtyOriginal } = image;
  const isModified = qtyCurrent !== qtyOriginal;

  return (
    <div>
      <SectionLabel>Quantity</SectionLabel>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: BG_BASE, border: '1px solid #1e2c35',
        borderRadius: 5, padding: '10px 14px',
      }}>
        <button
          onClick={() => onUpdateQty(filename, -1)}
          aria-label="Decrease quantity"
          style={qtyBtnStyle}
        >−</button>

        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: "'DM Mono', monospace", fontSize: 24, fontWeight: 600,
            color: isModified ? BRAND_GREEN : '#c8d8e0',
          }}>
            {qtyCurrent}
          </div>
          {isModified && (
            <div style={{ fontSize: 10, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
              orig: {qtyOriginal}
            </div>
          )}
        </div>

        <button
          onClick={() => onUpdateQty(filename, +1)}
          aria-label="Increase quantity"
          style={qtyBtnStyle}
        >+</button>
      </div>
    </div>
  );
}

const qtyBtnStyle = {
  width: 28, height: 28,
  background: BORDER_DIM, border: 'none', borderRadius: 4,
  color: '#c8d8e0', fontSize: 18,
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0,
};

// ── Hold Correction toggle ─────────────────────────────────────────────────────

function HoldToggle({ holdCorrection, onToggleHold }) {
  return (
    <div
      onClick={onToggleHold}
      role="checkbox"
      aria-checked={holdCorrection}
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onToggleHold()}
      style={{
        marginTop: 12,
        display: 'flex', alignItems: 'center', gap: 8,
        background: holdCorrection ? '#1a2d1a' : BG_BASE,
        border: `1px solid ${holdCorrection ? BRAND_GREEN + '88' : BORDER_DIM}`,
        borderRadius: 4, padding: '7px 10px', cursor: 'pointer',
      }}
    >
      <div style={{
        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
        background: holdCorrection ? BRAND_GREEN : BORDER_DIM,
        border: `2px solid ${holdCorrection ? BRAND_GREEN : '#4a6070'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.15s',
      }}>
        {holdCorrection && (
          <span style={{ color: '#fff', fontSize: 9, fontWeight: 700, lineHeight: 1 }}>✓</span>
        )}
      </div>
      <div>
        <div style={{ fontSize: 11, color: holdCorrection ? BRAND_GREEN : TEXT_DIM, fontWeight: 500 }}>
          Hold Correction
        </div>
        <div style={{ fontSize: 9, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
          Apply to all images
        </div>
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
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: reprint ? '#1e0a0a' : BG_BASE,
          border: `1px solid ${reprint ? '#cc3333' : BORDER_DIM}`,
          borderRadius: 5, padding: '10px 12px', cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        <div style={{
          width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
          background: reprint ? '#cc3333' : BORDER_DIM,
          border: `2px solid ${reprint ? '#cc3333' : '#4a6070'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}>
          {reprint && (
            <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✕</span>
          )}
        </div>
        <div>
          <div style={{ fontSize: 11, color: reprint ? '#ff6666' : TEXT_DIM, fontWeight: 500 }}>
            {reprint ? 'Flagged for Reprint' : 'Flag for Reprint'}
          </div>
          <div style={{ fontSize: 9, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
            {reprintCount > 0
              ? `next: ${jobId}-r${nextN}`
              : `creates ${jobId}-r1`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Enhancement panel button style helper ─────────────────────────────────────

function enhBtnStyle(variant) {
  const base = {
    fontSize: 11, fontFamily: "'DM Mono', monospace",
    padding: '7px 12px', borderRadius: 4, cursor: 'pointer',
    fontWeight: 600, letterSpacing: '0.03em',
    display: 'block', border: 'none', width: '100%',
  };
  if (variant === 'primary')  return { ...base, background: PURPLE_AI, color: '#fff' };
  if (variant === 'cancel')   return { ...base, background: '#3a2020', border: '1px solid #cc3333', color: '#ff8888' };
  /* secondary */              return { ...base, background: 'none', border: `1px solid ${BORDER_DIM}`, color: TEXT_DIM };
}

// ── AI Enhancement panel ──────────────────────────────────────────────────────

function EnhancementPanel({ selected, jobId, jobPath, onRefreshSidecar }) {
  const [hasKey,          setHasKey]          = useState(false);
  const [model,           setModel]           = useState('Standard V2');
  const [faceEnhancement, setFaceEnhancement] = useState(false);
  const [phase,           setPhase]           = useState('idle'); // 'idle' | 'processing' | 'error'
  const [predictionId,    setPredictionId]    = useState(null);
  const [error,           setError]           = useState(null);
  const pollRef = useRef(null);

  // Load config defaults on mount
  useEffect(() => {
    window.electronAPI.getConfig()
      .then(cfg => {
        setHasKey(Boolean(cfg.replicateApiKey));
        setModel(cfg.enhancementDefaultModel || 'Standard V2');
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

  // ── State: no API key ───────────────────────────────────────────────────────
  if (!hasKey) {
    return (
      <div>
        <SectionLabel>AI Enhancement</SectionLabel>
        <div style={{
          background: BG_BASE, border: '1px solid #1e2c35',
          borderRadius: 5, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 10, lineHeight: 1.5 }}>
            Configure a Replicate API key in Settings to enable AI upscaling.
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
            style={enhBtnStyle('secondary')}
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
        <div style={{
          background: BG_BASE, border: '1px solid #2a3e50',
          borderRadius: 5, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 12, color: '#7ec8e3', fontWeight: 600, marginBottom: 4 }}>
            ⟳ Enhancing via Topaz...
          </div>
          <div style={{
            fontSize: 10, color: TEXT_MUTED,
            fontFamily: "'DM Mono', monospace", marginBottom: 12,
          }}>
            This may take 30–60 seconds
          </div>
          <button onClick={handleCancel} style={enhBtnStyle('cancel')}>
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
        <div style={{
          background: '#1a0a2e', border: `1px solid ${PURPLE_AI}55`,
          borderRadius: 5, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 12, color: PURPLE_AI, fontWeight: 600, marginBottom: 2 }}>
            ✓ Enhanced via Topaz
          </div>
          <div style={{
            fontSize: 10, color: TEXT_MUTED,
            fontFamily: "'DM Mono', monospace", marginBottom: 10,
          }}>
            Model: {selected.enhancementModel || 'Topaz'}
          </div>
          <button onClick={handleRun} style={enhBtnStyle('primary')}>
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
      <div style={{
        background: BG_BASE, border: '1px solid #1e2c35',
        borderRadius: 5, padding: '12px 14px',
      }}>
        {/* Model selector */}
        <div style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: 9, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace",
            letterSpacing: '0.08em', marginBottom: 4,
          }}>
            MODEL
          </div>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{
              width: '100%', background: BG_DEEP, color: '#c8d8e0',
              border: `1px solid ${BORDER_DIM}`, borderRadius: 4,
              fontSize: 11, padding: '4px 6px', cursor: 'pointer',
            }}
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
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: 'pointer', marginBottom: 10, padding: '2px 0',
          }}
        >
          <div style={{
            width: 12, height: 12, borderRadius: 2, flexShrink: 0,
            background: faceEnhancement ? PURPLE_AI : BORDER_DIM,
            border: `2px solid ${faceEnhancement ? PURPLE_AI : '#4a6070'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
          }}>
            {faceEnhancement && (
              <span style={{ color: '#fff', fontSize: 8, fontWeight: 700, lineHeight: 1 }}>✓</span>
            )}
          </div>
          <span style={{ fontSize: 10, color: faceEnhancement ? PURPLE_AI : TEXT_DIM }}>
            Face enhancement
          </span>
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            fontSize: 10, color: '#ff8888', marginBottom: 8,
            wordBreak: 'break-word', lineHeight: 1.4,
          }}>
            {error}
          </div>
        )}

        {/* Run button */}
        <button onClick={handleRun} style={enhBtnStyle('primary')}>
          ✨ Upscale This Image
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
    <div style={{
      width: 260, background: BG_DEEP, borderLeft: '1px solid #1e2c35',
      padding: 20, overflowY: 'auto',
      display: 'flex', flexDirection: 'column', gap: 20,
      flexShrink: 0,
    }}>
      {/* QTY */}
      <QtyControl image={selected} onUpdateQty={onUpdateQty} />

      <Divider />

      {/* CMY */}
      <div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 12,
        }}>
          <SectionLabel>Colour Correction</SectionLabel>
          {hasCorrections && (
            <button
              onClick={handleReset}
              disabled={resetting}
              style={{
                fontSize: 9, fontFamily: "'DM Mono', monospace",
                color: '#cc6644', background: 'none',
                border: '1px solid #cc664444', borderRadius: 3,
                padding: '2px 7px', cursor: 'pointer',
                letterSpacing: '0.05em',
                opacity: resetting ? 0.5 : 1,
              }}
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

