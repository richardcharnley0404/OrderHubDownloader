/**
 * src/renderer/views/JobReview/CMYSliders.jsx
 *
 * Reusable CMY colour-correction slider component.
 * Renders three labelled sliders (Cyan, Magenta, Yellow) each with
 * +/− step buttons and a visual fill bar.
 *
 * Props:
 *   corrections  { cyan, magenta, yellow }  Current correction values
 *   onChange     (channel, value) => void   Called on any change
 *   disabled     boolean                    Locks all controls when true
 */

// Palette (brief §Brand Colours)
const TEXT_DIM   = '#8aa8be';
const TEXT_MUTED = '#5d7a8a';
const BG_DEEP    = '#2a3a45';
const BORDER_DIM = '#3a4e5e';
const BORDER     = '#4a6070';

const CHANNEL_META = [
  { key: 'cyan',    label: 'Cyan',    color: '#44cccc' },
  { key: 'magenta', label: 'Magenta', color: '#cc44cc' },
  { key: 'yellow',  label: 'Yellow',  color: '#cccc44' },
];

// ── Single channel slider ─────────────────────────────────────────────────────

function ChannelSlider({ label, value, onChange, color, disabled }) {
  const display = value > 0 ? `+${value}` : String(value);

  const fillPct  = (Math.abs(value) / 20) * 50;   // max 50 % from centre
  const fillLeft = value >= 0 ? '50%' : `${50 - fillPct}%`;

  return (
    <div style={{ marginBottom: 14 }}>
      {/* Label row */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 5,
      }}>
        <span style={{
          fontSize: 11, fontFamily: "'DM Mono', monospace",
          color: TEXT_DIM, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          {label}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Decrement */}
          <button
            onClick={() => !disabled && onChange(Math.max(-20, value - 1))}
            style={stepBtnStyle(disabled)}
            aria-label={`Decrease ${label}`}
          >−</button>

          {/* Value display */}
          <span style={{
            fontSize: 12, fontFamily: "'DM Mono', monospace",
            color: value !== 0 ? color : TEXT_MUTED,
            minWidth: 28, textAlign: 'center',
            fontWeight: value !== 0 ? 700 : 400,
          }}>
            {display}
          </span>

          {/* Increment */}
          <button
            onClick={() => !disabled && onChange(Math.min(20, value + 1))}
            style={stepBtnStyle(disabled)}
            aria-label={`Increase ${label}`}
          >+</button>
        </div>
      </div>

      {/* Track + fill + thumb */}
      <div style={{ position: 'relative', height: 6, background: BORDER_DIM, borderRadius: 3 }}>
        {/* Fill bar growing from centre */}
        <div style={{
          position: 'absolute',
          top: 0, bottom: 0,
          left: fillLeft,
          width: `${fillPct}%`,
          background: value !== 0 ? color : BORDER,
          borderRadius: 3,
          transition: 'width 0.1s, left 0.1s',
          pointerEvents: 'none',
        }} />

        <input
          type="range"
          min={-20} max={20}
          value={value}
          disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={`${label} correction`}
          style={{
            position: 'absolute', top: -4, left: 0,
            width: '100%', height: 14,
            appearance: 'none', background: 'transparent',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
          }}
        />
      </div>
    </div>
  );
}

function stepBtnStyle(disabled) {
  return {
    width: 18, height: 18,
    background: BG_DEEP,
    border: '1px solid #3a4a56',
    borderRadius: 3,
    color: TEXT_DIM,
    fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1,
    opacity: disabled ? 0.4 : 1,
    padding: 0,
  };
}

// ── Public component ──────────────────────────────────────────────────────────

export function CMYSliders({ corrections, onChange, disabled = false }) {
  return (
    <div>
      {CHANNEL_META.map(({ key, label, color }) => (
        <ChannelSlider
          key={key}
          label={label}
          value={corrections[key]}
          onChange={v => onChange(key, v)}
          color={color}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
