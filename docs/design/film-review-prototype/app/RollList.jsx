// Rolls list — browse + select a roll.
// Layout: a full-width table echoing the existing OHD Jobs table.
// Filter chips at the top: Ready for review / Processing / Reviewed / All.
// Click a row to open the roll in the review grid.

const { useState: useStateRL } = React;

function RollList({ rolls, onOpen }) {
  const [filter, setFilter] = useStateRL("ready");
  const [query, setQuery] = useStateRL("");

  const filtered = rolls.filter((r) => {
    if (filter === "ready" && r.status !== "ready_for_review") return false;
    if (filter === "processing" && r.status !== "processing") return false;
    if (filter === "reviewed" && r.status !== "reviewed") return false;
    if (query && !r.roll_id.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const counts = {
    ready: rolls.filter((r) => r.status === "ready_for_review").length,
    processing: rolls.filter((r) => r.status === "processing").length,
    reviewed: rolls.filter((r) => r.status === "reviewed").length,
    all: rolls.length,
  };

  return (
    <div className="rl">
      <div className="rl-subtabs">
        <div className="rl-subtabs-left">
          <button className={"rl-subtab " + (filter === "ready" ? "rl-subtab--on" : "")}
                  onClick={() => setFilter("ready")}>
            Ready for review <span className="rl-subtab-count">{counts.ready}</span>
          </button>
          <button className={"rl-subtab " + (filter === "processing" ? "rl-subtab--on" : "")}
                  onClick={() => setFilter("processing")}>
            Processing <span className="rl-subtab-count">{counts.processing}</span>
          </button>
          <button className={"rl-subtab " + (filter === "reviewed" ? "rl-subtab--on" : "")}
                  onClick={() => setFilter("reviewed")}>
            Reviewed <span className="rl-subtab-count">{counts.reviewed}</span>
          </button>
          <button className={"rl-subtab " + (filter === "all" ? "rl-subtab--on" : "")}
                  onClick={() => setFilter("all")}>
            All rolls <span className="rl-subtab-count">{counts.all}</span>
          </button>
        </div>
        <div className="rl-subtabs-right">
          <div className="rl-search">
            <Icon d={icons.search} size={14} />
            <input placeholder="Search rolls…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Btn variant="ghost">
            <Icon d={icons.rotateCW} size={14} /> Refresh
          </Btn>
        </div>
      </div>

      <div className="rl-table">
        <div className="rl-thead">
          <div>STATUS</div>
          <div>ROLL ID</div>
          <div className="rl-num">FRAMES</div>
          <div className="rl-num">AUTO-ROT.</div>
          <div className="rl-num">LOW CONF.</div>
          <div className="rl-num">ERRORS</div>
          <div>SCANNED</div>
          <div>PROCESSED</div>
          <div className="rl-actions-h">ACTIONS</div>
        </div>
        {filtered.map((r) => (
          <RollRow key={r.roll_id} r={r} onOpen={onOpen} />
        ))}
        {filtered.length === 0 && (
          <div className="rl-empty">No rolls match the current filter.</div>
        )}
      </div>
    </div>
  );
}

function RollRow({ r, onOpen }) {
  const status = r.status;
  const statusLabel = status === "ready_for_review" ? "Ready" : status === "processing" ? "Processing" : "Reviewed";
  const statusKind = status === "ready_for_review" ? "info" : status === "processing" ? "warning" : "neutral";
  const canOpen = status !== "processing";
  return (
    <div className={"rl-row " + (canOpen ? "rl-row--click" : "")}
         onClick={() => canOpen && onOpen(r.roll_id)}>
      <div><Pill kind={statusKind} dot>{statusLabel}</Pill></div>
      <div className="rl-roll">
        <div className="rl-roll-name">{r.roll_id}</div>
        <div className="rl-roll-sub">{r.frame_count === 24 ? "24-exp" : r.frame_count === 120 ? "120" : "35mm"}</div>
      </div>
      <div className="rl-num">{r.frame_count}</div>
      <div className="rl-num">{r.auto_rotated_count}</div>
      <div className={"rl-num " + (r.low_confidence_count > 0 ? "rl-num--warn" : "")}>
        {r.low_confidence_count}
      </div>
      <div className={"rl-num " + (r.rotation_error_count > 0 ? "rl-num--err" : "")}>
        {r.rotation_error_count}
      </div>
      <div className="rl-ink2">{fmtDate(r.scanned_at)}</div>
      <div className="rl-ink2">{r.processed_at ? fmtDate(r.processed_at) : "—"}</div>
      <div className="rl-actions">
        {status === "processing" ? (
          <span className="rl-processing">
            <span className="rl-spinner" />
            Processing…
          </span>
        ) : (
          <Btn variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); onOpen(r.roll_id); }}>
            Review
          </Btn>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { RollList });
