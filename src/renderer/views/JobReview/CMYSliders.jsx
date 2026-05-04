/**
 * src/renderer/views/JobReview/CMYSliders.jsx
 *
 * Reusable CMY colour-correction slider component.
 * Renders three labelled sliders (Cyan, Magenta, Yellow) each with
 * +/− step buttons and a visual fill bar.
 *
 * Styling: classes defined in src/renderer/job-review.css. The per-channel
 * accent colour (cyan/magenta/yellow) is injected via the `--jr-channel-color`
 * CSS variable on the channel root, which both fill bar and value-readout
 * pick up via `var(--jr-channel-color)` in the stylesheet.
 *
 * Props:
 *   corrections  { cyan, magenta, yellow }  Current correction values
 *   onChange     (channel, value) => void   Called on any change
 *   disabled     boolean                    Locks all controls when true
 */

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

  const isActive = value !== 0;

  return (
    <div className="jr-cmy-channel" style={{ '--jr-channel-color': color }}>
      {/* Label row */}
      <div className="jr-cmy-row">
        <span className="jr-cmy-label">{label}</span>

        <div className="jr-cmy-controls">
          {/* Decrement */}
          <button
            onClick={() => !disabled && onChange(Math.max(-20, value - 1))}
            disabled={disabled}
            className="jr-cmy-step"
            aria-label={`Decrease ${label}`}
          >−</button>

          {/* Value display */}
          <span className={'jr-cmy-value' + (isActive ? ' is-active' : '')}>
            {display}
          </span>

          {/* Increment */}
          <button
            onClick={() => !disabled && onChange(Math.min(20, value + 1))}
            disabled={disabled}
            className="jr-cmy-step"
            aria-label={`Increase ${label}`}
          >+</button>
        </div>
      </div>

      {/* Track + fill + thumb */}
      <div className="jr-cmy-track">
        {/* Fill bar growing from centre */}
        <div
          className={'jr-cmy-fill' + (isActive ? ' is-active' : '')}
          style={{ left: fillLeft, width: `${fillPct}%` }}
        />

        <input
          type="range"
          min={-20} max={20}
          value={value}
          disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          aria-label={`${label} correction`}
          className="jr-cmy-input"
        />
      </div>
    </div>
  );
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
