// Chrome + shared primitives for the OHD Film Review Panel prototype.
// Mirrors the visual language of the existing OHD screenshot: thin top bar
// with app title and window controls, tabs below, and a sub-tab filter bar.

const { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } = React;

// ---------- Icons (thin-line, Lucide-style, hand-rolled to avoid a CDN) ----------
const Icon = ({ d, size = 16, stroke = 1.5 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);
const icons = {
  flag: "M4 21V4h12l-2 4 2 4H4",
  flagFilled: <path d="M4 21V4h12l-2 4 2 4H4" fill="currentColor" stroke="currentColor" />,
  alert: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /></>,
  check: "M20 6 9 17l-5-5",
  chevL: "M15 18l-6-6 6-6",
  chevR: "M9 18l6-6-6-6",
  chevD: "M6 9l6 6 6-6",
  rotateCW: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  x: "M18 6 6 18M6 6l18 12".replace("18 12","12 12"),
  close: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
  film: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M3 16h18M8 3v18M16 3v18"/></>,
  grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
  note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></>,
};

// ---------- Window chrome + tab bar ----------
function OHDChrome({ dark, children, onSelectTab, tab, badges }) {
  return (
    <div className={"ohd " + (dark ? "ohd--dark" : "")}>
      <div className="ohd-titlebar">
        <div className="ohd-titlebar-left">
          <img src="assets/pixfizz-mark.svg" className="ohd-mark" alt="" />
          <span className="ohd-title">OrderHub Downloader</span>
        </div>
        <div className="ohd-titlebar-right">
          <span className="ohd-version">v1.1.0</span>
          <button className="ohd-wb">—</button>
          <button className="ohd-wb">▢</button>
          <button className="ohd-wb ohd-wb--close">×</button>
        </div>
      </div>
      <div className="ohd-tabs">
        {[
          { id: "jobs", label: "Jobs" },
          { id: "film", label: "Film Rolls", badge: badges?.film },
          { id: "settings", label: "Settings" },
          { id: "activity", label: "Activity Log" },
        ].map((t) => (
          <button
            key={t.id}
            className={"ohd-tab " + (tab === t.id ? "ohd-tab--on" : "")}
            onClick={() => onSelectTab?.(t.id)}
          >
            {t.label}
            {t.badge ? <span className="ohd-tab-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="ohd-body">{children}</div>
    </div>
  );
}

// ---------- Empty state for Jobs tab (keep the existing panel believable) ----------
function JobsPlaceholder() {
  return (
    <div className="jobs-placeholder">
      <div className="jobs-placeholder-card">
        <Icon d={icons.grid} size={22} />
        <div>
          <div className="jobs-ph-title">Jobs panel</div>
          <div className="jobs-ph-sub">Not part of this design review — see the existing OHD build.</div>
        </div>
      </div>
    </div>
  );
}

// ---------- Badge ----------
function Pill({ kind = "neutral", children, dot }) {
  return (
    <span className={"pf-pill pf-pill--" + kind}>
      {dot ? <span className="pf-pill-dot" /> : null}
      {children}
    </span>
  );
}

// ---------- Button ----------
function Btn({ variant = "default", size = "md", children, onClick, disabled, title, iconLeft, iconRight, className = "" }) {
  return (
    <button
      className={`pf-btn pf-btn--${variant} pf-btn--${size} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {iconLeft ? <span className="pf-btn-icon">{iconLeft}</span> : null}
      {children}
      {iconRight ? <span className="pf-btn-icon">{iconRight}</span> : null}
    </button>
  );
}

// ---------- Format helpers ----------
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function fmtDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function pct(x) { return Math.round(x * 100) + "%"; }

Object.assign(window, {
  Icon, icons, OHDChrome, JobsPlaceholder, Pill, Btn, fmtDate, fmtDateShort, pct,
});
