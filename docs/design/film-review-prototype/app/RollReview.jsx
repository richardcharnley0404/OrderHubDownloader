// Roll Review — the main design surface.
// Grid of frame thumbnails with confidence visualisation, flag menus,
// summary header, and filter chips.

const { useMemo: useMemoRR, useState: useStateRR, useEffect: useEffectRR, useRef: useRefRR } = React;

function RollReview({ roll, tweaks, onBack, onOpenFrame, onFlagFrame, onMarkReviewed }) {
  const [filter, setFilter] = useStateRR("all"); // all | low_conf | errors | flagged | auto_rot
  const [hoverFrame, setHoverFrame] = useStateRR(null);
  const [flagMenuFrame, setFlagMenuFrame] = useStateRR(null);

  const frames = roll.frames;
  const flagged = frames.filter((f) => f.operator_flags.length > 0).length;

  const visible = useMemoRR(() => {
    return frames.filter((f) => {
      if (filter === "low_conf") return f.ai_confidence < 0.75;
      if (filter === "errors") return !f.rotation_applied;
      if (filter === "flagged") return f.operator_flags.length > 0;
      if (filter === "auto_rot") return f.rotation_applied && f.ai_predicted_angle !== 0;
      return true;
    });
  }, [frames, filter]);

  // Keyboard: F to flag hovered frame as "rotation" (most-common flag);
  // Enter to open in detail view.
  useEffectRR(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (!hoverFrame) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        onFlagFrame(hoverFrame, { type: "rotation", note: null });
      } else if (e.key === "Enter") {
        e.preventDefault();
        onOpenFrame(hoverFrame);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hoverFrame, onFlagFrame, onOpenFrame]);

  const density = tweaks.density; // "tight" | "regular" | "comfy"
  const cols = density === "tight" ? 9 : density === "regular" ? 6 : 4;

  return (
    <div className="rr">
      <div className="rr-topbar">
        <button className="rr-back" onClick={onBack}>
          <Icon d={icons.chevL} size={16} />
          All rolls
        </button>
        <div className="rr-title">
          <div className="rr-title-name">Roll {roll.roll_id}</div>
          <div className="rr-title-sub">
            {roll.frame_count} frames · Scanned {fmtDate(roll.scanned_at)}
            {roll.processed_at ? " · Processed " + fmtDate(roll.processed_at) : ""}
          </div>
        </div>
        <div className="rr-actions">
          <Btn variant="ghost">
            <Icon d={icons.note} size={14} /> Open folder
          </Btn>
          <Btn variant="primary" onClick={() => onMarkReviewed(roll.roll_id)}
               disabled={roll.status === "reviewed"}>
            <Icon d={icons.check} size={14} />
            {roll.status === "reviewed" ? "Reviewed" : "Mark roll reviewed"}
          </Btn>
        </div>
      </div>

      {/* Summary stats */}
      <div className="rr-stats">
        <Stat label="Frames" value={roll.frame_count} />
        <Stat label="Auto-rotated" value={roll.auto_rotated_count}
              sub={`of ${roll.frame_count}`} />
        <Stat label="Low confidence" value={roll.low_confidence_count}
              warn={roll.low_confidence_count > 0} />
        <Stat label="Rotation errors" value={roll.rotation_error_count}
              err={roll.rotation_error_count > 0} />
        <Stat label="Operator flags" value={flagged}
              accent={flagged > 0} />
      </div>

      {/* Filter chips */}
      <div className="rr-chips">
        <Chip on={filter === "all"} onClick={() => setFilter("all")}>
          All <span className="chip-count">{frames.length}</span>
        </Chip>
        <Chip on={filter === "low_conf"} onClick={() => setFilter("low_conf")}
              tone="warning">
          <span className="chip-sw chip-sw--warn" /> Low confidence
          <span className="chip-count">{roll.low_confidence_count}</span>
        </Chip>
        <Chip on={filter === "errors"} onClick={() => setFilter("errors")}
              tone="danger">
          <span className="chip-sw chip-sw--err" /> Rotation errors
          <span className="chip-count">{roll.rotation_error_count}</span>
        </Chip>
        <Chip on={filter === "auto_rot"} onClick={() => setFilter("auto_rot")}>
          <Icon d={icons.rotateCW} size={12} /> Auto-rotated
          <span className="chip-count">{roll.auto_rotated_count}</span>
        </Chip>
        <Chip on={filter === "flagged"} onClick={() => setFilter("flagged")}
              tone="accent">
          <Icon d={icons.flag} size={12} /> Flagged
          <span className="chip-count">{flagged}</span>
        </Chip>

        <div className="rr-chips-spacer" />

        <div className="rr-hint">
          <Icon d={icons.keyboard} size={14} />
          <span><kbd>F</kbd> flag · <kbd>↵</kbd> open · <kbd>←</kbd> <kbd>→</kbd> navigate</span>
        </div>
      </div>

      {/* Grid */}
      <div className="rr-grid-wrap">
        <div className="rr-grid" style={{ "--cols": cols }}>
          {visible.map((f) => (
            <FrameCell
              key={f.frame_id}
              f={f}
              tweaks={tweaks}
              cols={cols}
              onMouseEnter={() => setHoverFrame(f.frame_id)}
              onMouseLeave={() => setHoverFrame(null)}
              onOpen={() => onOpenFrame(f.frame_id)}
              onOpenFlagMenu={() => setFlagMenuFrame(f.frame_id)}
              onQuickFlag={() => onFlagFrame(f.frame_id, { type: "rotation", note: null })}
              flagMenuOpen={flagMenuFrame === f.frame_id}
              onCloseFlagMenu={() => setFlagMenuFrame(null)}
              onFlag={(payload) => {
                onFlagFrame(f.frame_id, payload);
                setFlagMenuFrame(null);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, warn, err, accent }) {
  return (
    <div className={"rr-stat" + (warn ? " rr-stat--warn" : "") + (err ? " rr-stat--err" : "") + (accent ? " rr-stat--accent" : "")}>
      <div className="rr-stat-label">{label}</div>
      <div className="rr-stat-value">
        {value}
        {sub ? <span className="rr-stat-sub"> {sub}</span> : null}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children, tone }) {
  return (
    <button className={"chip " + (on ? "chip--on" : "") + (tone ? " chip--" + tone : "")}
            onClick={onClick}>
      {children}
    </button>
  );
}

// ---------- Frame cell ----------
function FrameCell({ f, tweaks, cols, onMouseEnter, onMouseLeave, onOpen, onOpenFlagMenu,
                    onQuickFlag, flagMenuOpen, onCloseFlagMenu, onFlag }) {
  const conf = f.ai_confidence;
  const isLow = conf < 0.75;
  const isError = !f.rotation_applied;
  const hasFlag = f.operator_flags.length > 0;

  // Confidence viz styles — driven by tweak
  const viz = tweaks.confidenceViz; // "border" | "opacity" | "corner" | "numeric"

  let cellStyle = {};
  let cellExtraClass = "";

  if (viz === "border") {
    if (isError) cellExtraClass = " frame--err-border";
    else if (isLow) cellExtraClass = " frame--low-border";
  } else if (viz === "opacity") {
    // Dim confident frames so low-conf ones pop by contrast.
    if (!isError && !isLow && !hasFlag) cellStyle.opacity = 0.55;
    if (isError) cellExtraClass = " frame--err-border";
  } else if (viz === "corner") {
    // Uniform treatment; just a status dot on the corner.
  } else if (viz === "numeric") {
    if (isError) cellExtraClass = " frame--err-border";
    else if (isLow) cellExtraClass = " frame--low-border";
  }

  if (hasFlag) cellExtraClass += " frame--flagged";

  return (
    <div
      className={"frame" + cellExtraClass}
      style={cellStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onOpen}
      tabIndex={0}
    >
      <div className="frame-thumb-wrap">
        <img
          className="frame-thumb"
          src={f.thumbnail_url}
          alt=""
          style={{ transform: `rotate(${f.display_rotation}deg)` }}
          draggable={false}
        />

        {/* Scan order */}
        <div className="frame-idx">{String(f.scan_order_in_roll).padStart(2, "0")}</div>

        {/* Confidence indicator — "corner" dot always on. Other vizzes add a dot too for consistency. */}
        <div className="frame-conf-dot" title={"AI confidence " + pct(conf)}>
          <ConfidenceDot conf={conf} isError={isError} />
        </div>

        {/* Numeric confidence — only when tweak set to numeric, or always on low-conf hover */}
        {viz === "numeric" && (
          <div className={"frame-conf-num" + (isLow ? " frame-conf-num--warn" : "")}>
            {pct(conf)}
          </div>
        )}

        {/* Error banner */}
        {isError && (
          <div className="frame-err-banner">
            <Icon d={icons.alert} size={12} /> rotation failed
          </div>
        )}

        {/* Flag badge (if flagged) */}
        {hasFlag && (
          <div className="frame-flag-badge" title={f.operator_flags[0].type}>
            <Icon d={icons.flagFilled} size={12} />
          </div>
        )}

        {/* Hover overlay with quick actions */}
        <div className="frame-overlay">
          <button
            className="frame-overlay-btn"
            onClick={(e) => { e.stopPropagation(); onOpenFlagMenu(); }}
            title="Flag (F)"
          >
            <Icon d={hasFlag ? icons.flagFilled : icons.flag} size={cols > 7 ? 14 : 16} />
          </button>
        </div>

        {/* Flag menu */}
        {flagMenuOpen && (
          <FlagMenu
            frame={f}
            onClose={onCloseFlagMenu}
            onSubmit={onFlag}
          />
        )}
      </div>

      {/* Footer row — only shown at regular/comfy density */}
      {cols <= 6 && (
        <div className="frame-footer">
          <span className="frame-order">#{f.scan_order_in_roll}</span>
          <span className={"frame-conf " + (isLow ? "frame-conf--warn" : isError ? "frame-conf--err" : "")}>
            {isError ? "err" : pct(conf)}
          </span>
          {f.ai_predicted_angle !== 0 && f.rotation_applied && (
            <span className="frame-rot" title={`rotated ${f.ai_predicted_angle}°`}>
              <Icon d={icons.rotateCW} size={10} /> {f.ai_predicted_angle}°
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceDot({ conf, isError }) {
  if (isError) return <span className="conf-dot conf-dot--err" />;
  if (conf < 0.6) return <span className="conf-dot conf-dot--low" />;
  if (conf < 0.75) return <span className="conf-dot conf-dot--mid" />;
  return <span className="conf-dot conf-dot--hi" />;
}

// ---------- Flag menu ----------
function FlagMenu({ frame, onClose, onSubmit }) {
  const [type, setType] = useStateRR("rotation");
  const [note, setNote] = useStateRR("");
  const ref = useRefRR(null);

  useEffectRR(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const types = [
    { id: "rotation", label: "Rotation", hint: "Sideways / upside-down", key: "1" },
    { id: "scan_quality", label: "Scan quality", hint: "Dust, scratches, blur", key: "2" },
    { id: "exposure", label: "Exposure", hint: "Too dark / too bright", key: "3" },
    { id: "other", label: "Other", hint: "See note", key: "4" },
  ];

  return (
    <div
      className="flagmenu"
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flagmenu-head">
        <span className="flagmenu-title">Flag frame #{frame.scan_order_in_roll}</span>
        <button className="flagmenu-x" onClick={onClose}>
          <Icon d={icons.close} size={12} />
        </button>
      </div>
      <div className="flagmenu-types">
        {types.map((t) => (
          <button
            key={t.id}
            className={"flagmenu-type " + (type === t.id ? "flagmenu-type--on" : "")}
            onClick={() => setType(t.id)}
          >
            <span className="flagmenu-type-key">{t.key}</span>
            <span className="flagmenu-type-body">
              <span className="flagmenu-type-label">{t.label}</span>
              <span className="flagmenu-type-hint">{t.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <textarea
        className="flagmenu-note"
        placeholder="Optional note…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <div className="flagmenu-foot">
        <span className="flagmenu-kbd"><kbd>⏎</kbd> submit · <kbd>esc</kbd> cancel</span>
        <Btn variant="primary" size="sm" onClick={() => onSubmit({ type, note: note || null })}>
          Flag
        </Btn>
      </div>
    </div>
  );
}

Object.assign(window, { RollReview, FrameCell, FlagMenu });
