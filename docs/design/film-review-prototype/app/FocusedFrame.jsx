// Focused Frame view — full-res detail for a single frame.
// Overlay that covers the grid. Arrow keys navigate; Esc closes.

const { useEffect: useEffectFF, useState: useStateFF } = React;

function FocusedFrame({ roll, frameId, onClose, onNav, onFlag, onUnflag }) {
  const idx = roll.frames.findIndex((f) => f.frame_id === frameId);
  const f = roll.frames[idx];
  const [showFlagMenu, setShowFlagMenu] = useStateFF(false);

  useEffectFF(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); onNav(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onNav(1); }
      else if ((e.key === "f" || e.key === "F") && !showFlagMenu) {
        e.preventDefault(); setShowFlagMenu(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNav, showFlagMenu]);

  if (!f) return null;
  const isError = !f.rotation_applied;
  const isLow = f.ai_confidence < 0.75;

  return (
    <div className="ff-backdrop" onClick={onClose}>
      <div className="ff" onClick={(e) => e.stopPropagation()}>
        <div className="ff-head">
          <div className="ff-head-l">
            <button className="ff-back" onClick={onClose}>
              <Icon d={icons.chevL} size={14} /> Back to roll
            </button>
            <span className="ff-head-sep" />
            <span className="ff-head-roll">Roll {roll.roll_id}</span>
            <span className="ff-head-sep" />
            <span className="ff-head-idx">
              Frame {f.scan_order_in_roll} of {roll.frame_count}
            </span>
          </div>
          <div className="ff-head-r">
            <button className="ff-navbtn" onClick={() => onNav(-1)} disabled={idx === 0}>
              <Icon d={icons.chevL} size={14} /> Prev
            </button>
            <button className="ff-navbtn" onClick={() => onNav(1)}
                    disabled={idx === roll.frames.length - 1}>
              Next <Icon d={icons.chevR} size={14} />
            </button>
            <button className="ff-close" onClick={onClose}>
              <Icon d={icons.close} size={16} />
            </button>
          </div>
        </div>

        <div className="ff-body">
          <div className="ff-stage">
            <div className="ff-img-wrap">
              <img
                className="ff-img"
                src={f.thumbnail_url}
                alt=""
                style={{ transform: `rotate(${f.display_rotation}deg)` }}
              />
            </div>
            {isError && (
              <div className="ff-error-bar">
                <Icon d={icons.alert} size={14} />
                <div>
                  <strong>Rotation failed.</strong> This frame was uploaded un-rotated.
                  <div className="ff-error-detail">{f.rotation_error}</div>
                </div>
              </div>
            )}
          </div>

          <aside className="ff-side">
            <div className="ff-side-sect">
              <div className="ff-side-title">AI prediction</div>
              <div className="ff-meta">
                <div className="ff-meta-row">
                  <span>Predicted rotation</span>
                  <span className="ff-meta-val">
                    {f.ai_predicted_angle}° <span className="ff-meta-sub">
                      {f.ai_predicted_angle === 0 ? "no change" : "clockwise"}
                    </span>
                  </span>
                </div>
                <div className="ff-meta-row">
                  <span>Confidence</span>
                  <span className={"ff-meta-val " + (isLow ? "ff-meta-val--warn" : "")}>
                    {pct(f.ai_confidence)}
                  </span>
                </div>
                <div className="ff-conf-bar">
                  <div className="ff-conf-bar-fill"
                       style={{
                         width: pct(f.ai_confidence),
                         background: isError ? "var(--pf-danger)"
                           : isLow ? "var(--pf-warning)"
                           : "var(--pf-success)",
                       }} />
                </div>
                <div className="ff-meta-row">
                  <span>Rotation applied</span>
                  <span className={"ff-meta-val " + (isError ? "ff-meta-val--err" : "")}>
                    {f.rotation_applied ? "Yes" : "No — failed"}
                  </span>
                </div>
              </div>
            </div>

            <div className="ff-side-sect">
              <div className="ff-side-title">Scan</div>
              <div className="ff-meta">
                <div className="ff-meta-row"><span>Frame order</span><span className="ff-meta-val">{f.scan_order_in_roll} / {roll.frame_count}</span></div>
                <div className="ff-meta-row"><span>Frame ID</span><span className="ff-meta-val ff-meta-mono">{f.frame_id}</span></div>
                <div className="ff-meta-row"><span>Roll ID</span><span className="ff-meta-val ff-meta-mono">{roll.roll_id}</span></div>
                <div className="ff-meta-row"><span>Processed</span><span className="ff-meta-val">{roll.processed_at ? fmtDate(roll.processed_at) : "—"}</span></div>
              </div>
            </div>

            <div className="ff-side-sect">
              <div className="ff-side-title-row">
                <span className="ff-side-title">Operator flags</span>
                {f.operator_flags.length > 0 && (
                  <span className="ff-tag ff-tag--accent">{f.operator_flags.length}</span>
                )}
              </div>
              {f.operator_flags.length === 0 ? (
                <div className="ff-empty">No flags on this frame.</div>
              ) : (
                <div className="ff-flags">
                  {f.operator_flags.map((fl, i) => (
                    <div key={i} className="ff-flag">
                      <div className="ff-flag-head">
                        <span className="ff-flag-type">
                          <Icon d={icons.flagFilled} size={11} /> {fl.type.replace("_", " ")}
                        </span>
                        <button className="ff-flag-x" onClick={() => onUnflag(f.frame_id, i)}>
                          <Icon d={icons.close} size={11} />
                        </button>
                      </div>
                      {fl.note && <div className="ff-flag-note">"{fl.note}"</div>}
                      <div className="ff-flag-time">{fmtDate(fl.flagged_at)}</div>
                    </div>
                  ))}
                </div>
              )}

              {showFlagMenu ? (
                <div className="ff-flagmenu">
                  <FlagMenu
                    frame={f}
                    onClose={() => setShowFlagMenu(false)}
                    onSubmit={(payload) => {
                      onFlag(f.frame_id, payload);
                      setShowFlagMenu(false);
                    }}
                  />
                </div>
              ) : (
                <Btn variant={f.operator_flags.length > 0 ? "ghost" : "primary"}
                     onClick={() => setShowFlagMenu(true)} className="ff-flag-add">
                  <Icon d={icons.flag} size={13} />
                  {f.operator_flags.length > 0 ? "Add another flag" : "Flag this frame"}
                  <span className="ff-flag-add-kbd"><kbd>F</kbd></span>
                </Btn>
              )}
            </div>

            <div className="ff-side-foot">
              <span className="ff-side-kbd">
                <kbd>←</kbd> <kbd>→</kbd> navigate · <kbd>F</kbd> flag · <kbd>esc</kbd> close
              </span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { FocusedFrame });
