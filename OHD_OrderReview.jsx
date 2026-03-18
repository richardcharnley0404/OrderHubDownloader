import { useState, useRef, useEffect } from "react";

const BRAND_GREEN = "#72B622";
const BRAND_BLUE = "#415564";

// #415564 derived palette
const BG_DEEP    = "#2a3a45";
const BG_BASE    = "#324452";
const BG_PANEL   = "#2e3e4c";
const BG_CARD    = "#374d5c";
const BG_HOVER   = "#3d5464";
const BG_INPUT   = "#2a3a45";
const BORDER     = "#4a6070";
const BORDER_DIM = "#3a4e5e";
const TEXT_DIM   = "#8aa8be";
const TEXT_MUTED = "#5d7a8a";

// Generate mock images with canvas
function generateMockImage(seed, w = 120, h = 90) {
  const colors = [
    ["#d4a574", "#8b6340", "#f0c080"],
    ["#74a8d4", "#4060a0", "#a0c8f0"],
    ["#a4d474", "#608040", "#c8f0a0"],
    ["#d474a4", "#804060", "#f0a0c8"],
    ["#d4c074", "#806040", "#f0e0a0"],
    ["#74d4c0", "#408060", "#a0f0e0"],
    ["#c074d4", "#604080", "#e0a0f0"],
    ["#d47474", "#804040", "#f0a0a0"],
  ];
  const c = colors[seed % colors.length];
  return { primary: c[0], dark: c[1], light: c[2] };
}

const MOCK_JOBS = Array.from({ length: 12 }, (_, i) => ({
  id: `IMG_${String(i + 1).padStart(3, "0")}.jpg`,
  filename: `IMG_${String(i + 1).padStart(3, "0")}.jpg`,
  qtyOriginal: [1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 2, 1][i],
  qtyCurrent: [1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 2, 1][i],
  corrections: { cyan: 0, magenta: 0, yellow: 0 },
  reprint: false,
  enhanced: false,
  colors: generateMockImage(i * 3 + 7),
  label: ["Portrait", "Landscape", "Group", "Portrait", "Event", "Landscape", "Portrait", "Group", "Event", "Portrait", "Landscape", "Group"][i],
}));

function ThumbnailCanvas({ colors, corrections, reprint, selected, size = 110 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, colors.light);
    grad.addColorStop(1, colors.dark);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Fake photo elements
    ctx.fillStyle = colors.primary;
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.4, w * 0.22, h * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = colors.dark + "88";
    ctx.fillRect(w * 0.1, h * 0.65, w * 0.8, h * 0.2);

    ctx.fillStyle = colors.light + "99";
    ctx.beginPath();
    ctx.ellipse(w * 0.25, h * 0.3, w * 0.1, h * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();

    // Apply CMY correction as color overlay
    const { cyan, magenta, yellow } = corrections;
    if (cyan !== 0 || magenta !== 0 || yellow !== 0) {
      // Cyan reduces red, Magenta reduces green, Yellow reduces blue
      const r = Math.max(0, Math.min(255, -cyan * 2.5));
      const g = Math.max(0, Math.min(255, -magenta * 2.5));
      const b = Math.max(0, Math.min(255, -yellow * 2.5));
      const alpha = Math.min(0.35, (Math.abs(cyan) + Math.abs(magenta) + Math.abs(yellow)) / 60);
      if (alpha > 0) {
        ctx.fillStyle = `rgba(${r > 0 ? 0 : 255},${g > 0 ? 0 : 255},${b > 0 ? 0 : 255},${alpha})`;
        ctx.fillRect(0, 0, w, h);
      }
    }

    // Reprint overlay
    if (reprint) {
      ctx.fillStyle = "rgba(220, 50, 50, 0.18)";
      ctx.fillRect(0, 0, w, h);
    }

    // Selected border effect
    if (selected) {
      ctx.strokeStyle = BRAND_GREEN;
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
    }
  }, [colors, corrections, reprint, selected]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={Math.round(size * 0.75)}
      style={{ display: "block", borderRadius: 3 }}
    />
  );
}

function Slider({ label, value, onChange, color }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: TEXT_DIM, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => onChange(Math.max(-20, value - 1))}
            style={{ width: 18, height: 18, background: BG_DEEP, border: "1px solid #3a4a56", borderRadius: 3, color: TEXT_DIM, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
          >−</button>
          <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: value !== 0 ? color : TEXT_MUTED, minWidth: 28, textAlign: "center", fontWeight: value !== 0 ? 700 : 400 }}>
            {value > 0 ? `+${value}` : value}
          </span>
          <button
            onClick={() => onChange(Math.min(20, value + 1))}
            style={{ width: 18, height: 18, background: BG_DEEP, border: "1px solid #3a4a56", borderRadius: 3, color: TEXT_DIM, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
          >+</button>
        </div>
      </div>
      <div style={{ position: "relative", height: 6, background: BORDER_DIM, borderRadius: 3, overflow: "visible" }}>
        <div style={{
          position: "absolute", left: "50%", top: 0, bottom: 0,
          width: `${Math.abs(value) / 20 * 50}%`,
          background: value !== 0 ? color : BORDER,
          transform: value >= 0 ? "none" : "translateX(-100%)",
          borderRadius: 3, transition: "width 0.1s",
        }} />
        <input
          type="range" min={-20} max={20} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            position: "absolute", top: -4, left: 0, right: 0, width: "100%",
            appearance: "none", background: "transparent", cursor: "pointer", height: 14,
          }}
        />
      </div>
    </div>
  );
}

export default function OHDOrderReview() {
  const [images, setImages] = useState(MOCK_JOBS);
  const [selectedId, setSelectedId] = useState(MOCK_JOBS[0].id);
  const [holdCorrection, setHoldCorrection] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [reprintSent, setReprintSent] = useState(false);
  const [reprintCount, setReprintCount] = useState(0);

  const selected = images.find(img => img.id === selectedId);

  function updateCorrection(channel, val) {
    setImages(prev => prev.map(img => {
      if (holdCorrection) {
        return { ...img, corrections: { ...img.corrections, [channel]: val } };
      }
      if (img.id !== selectedId) return img;
      return { ...img, corrections: { ...img.corrections, [channel]: val } };
    }));
  }

  function updateQty(id, delta) {
    setImages(prev => prev.map(img => {
      if (img.id !== id) return img;
      const next = Math.max(0, img.qtyCurrent + delta);
      return { ...img, qtyCurrent: next };
    }));
  }

  function toggleReprint(id) {
    setImages(prev => prev.map(img =>
      img.id !== id ? img : { ...img, reprint: !img.reprint }
    ));
  }

  function resetImage() {
    setImages(prev => prev.map(img =>
      img.id !== selectedId ? img : {
        ...img,
        corrections: { cyan: 0, magenta: 0, yellow: 0 },
        qtyCurrent: img.qtyOriginal,
        reprint: false,
      }
    ));
    setShowResetConfirm(false);
  }

  function sendReprints() {
    const count = images.filter(i => i.reprint).length;
    if (count === 0) return;
    setReprintCount(prev => prev + 1);
    setReprintSent(true);
    setImages(prev => prev.map(img => ({ ...img, reprint: false })));
    setTimeout(() => setReprintSent(false), 3000);
  }

  const reprintImages = images.filter(i => i.reprint);
  const modifiedImages = images.filter(i =>
    i.qtyCurrent !== i.qtyOriginal ||
    i.corrections.cyan !== 0 || i.corrections.magenta !== 0 || i.corrections.yellow !== 0
  );
  const hasCorrections = selected && (
    selected.corrections.cyan !== 0 || selected.corrections.magenta !== 0 || selected.corrections.yellow !== 0
  );

  const jobId = "JOB-00452";
  const reprintJobId = reprintCount > 0 ? `${jobId}-r${reprintCount}` : null;

  return (
    <div style={{
      background: BG_BASE,
      minHeight: "100vh",
      fontFamily: "'DM Sans', system-ui, sans-serif",
      color: "#c8d8e0",
      display: "flex",
      flexDirection: "column",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px;
          border-radius: 50%;
          background: #c8d8e0;
          border: 2px solid #415564;
          cursor: pointer;
          box-shadow: 0 0 0 3px rgba(114,182,34,0.15);
        }
        input[type=range]::-webkit-slider-thumb:hover {
          background: #72B622;
          border-color: #72B622;
        }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: ${BG_BASE}; }
        ::-webkit-scrollbar-thumb { background: ${BG_DEEP}; border-radius: 3px; }
        .thumb-card:hover { background: ${BG_HOVER} !important; }
        .action-btn:hover { opacity: 0.85; }
        .icon-btn:hover { background: ${BG_DEEP} !important; }
      `}</style>

      {/* Top bar */}
      <div style={{
        background: BG_DEEP,
        borderBottom: "1px solid #1e2c35",
        padding: "10px 20px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: BRAND_GREEN, boxShadow: `0 0 8px ${BRAND_GREEN}` }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: BRAND_GREEN, letterSpacing: "0.05em" }}>OHD</span>
          <span style={{ color: BG_DEEP, fontSize: 13 }}>›</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: TEXT_DIM }}>Order Review</span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Job ID + info */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#c8d8e0", fontWeight: 500 }}>{jobId}</div>
            <div style={{ fontSize: 10, color: TEXT_MUTED, letterSpacing: "0.06em" }}>PIXFIZZ STORE · 12 IMAGES</div>
          </div>

          {reprintJobId && (
            <div style={{ background: "#1e0a0a", border: "1px solid #cc3333", borderRadius: 4, padding: "4px 10px" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#ff6666" }}>
                {reprintJobId} sent ✓
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ background: BG_INPUT, border: "1px solid #2a3a45", borderRadius: 4, padding: "4px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#c8d8e0", fontFamily: "'DM Mono', monospace" }}>{images.reduce((s, i) => s + i.qtyCurrent, 0)}</div>
              <div style={{ fontSize: 9, color: TEXT_MUTED, letterSpacing: "0.08em" }}>TOTAL PRINTS</div>
            </div>
            <div style={{ background: BG_INPUT, border: "1px solid #2a3a45", borderRadius: 4, padding: "4px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: modifiedImages.length > 0 ? BRAND_GREEN : TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>{modifiedImages.length}</div>
              <div style={{ fontSize: 9, color: TEXT_MUTED, letterSpacing: "0.08em" }}>MODIFIED</div>
            </div>
            <div style={{ background: reprintImages.length > 0 ? "#1e0a0a" : BG_INPUT, border: `1px solid ${reprintImages.length > 0 ? "#cc3333" : BG_DEEP}`, borderRadius: 4, padding: "4px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: reprintImages.length > 0 ? "#ff6666" : TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>{reprintImages.length}</div>
              <div style={{ fontSize: 9, color: TEXT_MUTED, letterSpacing: "0.08em" }}>REPRINTS</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "calc(100vh - 53px)" }}>

        {/* Thumbnail grid */}
        <div style={{
          width: 460,
          background: BG_PANEL,
          borderRight: "1px solid #1e2c35",
          overflowY: "auto",
          padding: 12,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          alignContent: "start",
        }}>
          {images.map(img => {
            const isSelected = img.id === selectedId;
            const isModified = img.qtyCurrent !== img.qtyOriginal ||
              img.corrections.cyan !== 0 || img.corrections.magenta !== 0 || img.corrections.yellow !== 0;

            return (
              <div
                key={img.id}
                className="thumb-card"
                onClick={() => setSelectedId(img.id)}
                style={{
                  background: isSelected ? BG_HOVER : BG_CARD,
                  border: `1px solid ${isSelected ? BRAND_GREEN : img.reprint ? "#cc3333" : BORDER_DIM}`,
                  borderRadius: 5,
                  padding: 6,
                  cursor: "pointer",
                  position: "relative",
                  transition: "all 0.15s",
                  boxShadow: isSelected ? `0 0 0 1px ${BRAND_GREEN}22` : "none",
                }}
              >
                <ThumbnailCanvas
                  colors={img.colors}
                  corrections={img.corrections}
                  reprint={img.reprint}
                  selected={isSelected}
                  size={128}
                />

                {/* Status badges */}
                <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 3 }}>
                  {img.reprint && (
                    <div style={{ background: "#cc3333", borderRadius: 2, padding: "1px 5px", fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#fff", letterSpacing: "0.05em" }}>
                      REPRINT
                    </div>
                  )}
                  {isModified && !img.reprint && (
                    <div style={{ background: BRAND_GREEN, borderRadius: 2, padding: "1px 5px", fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#fff" }}>
                      MOD
                    </div>
                  )}
                </div>

                {/* QTY badge */}
                {img.qtyCurrent !== img.qtyOriginal && (
                  <div style={{ position: "absolute", top: 8, right: 8, background: "#415564", borderRadius: 2, padding: "1px 5px", fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#fff" }}>
                    ×{img.qtyCurrent}
                  </div>
                )}

                {/* Filename */}
                <div style={{ marginTop: 5, fontSize: 10, fontFamily: "'DM Mono', monospace", color: isSelected ? "#c8d8e0" : TEXT_MUTED, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {img.filename}
                </div>
              </div>
            );
          })}
        </div>

        {/* Right panel */}
        {selected && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

            {/* Large preview + controls */}
            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

              {/* Preview area */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, background: BG_PANEL }}>
                <div style={{ position: "relative" }}>
                  <ThumbnailCanvas
                    colors={selected.colors}
                    corrections={selected.corrections}
                    reprint={selected.reprint}
                    selected={false}
                    size={320}
                  />

                  {/* Correction overlay indicator */}
                  {hasCorrections && (
                    <div style={{ position: "absolute", bottom: 8, left: 8, background: "rgba(114,182,34,0.9)", borderRadius: 3, padding: "2px 8px", fontSize: 10, fontFamily: "'DM Mono', monospace", color: "#fff" }}>
                      CORRECTED
                    </div>
                  )}
                  {selected.reprint && (
                    <div style={{ position: "absolute", bottom: 8, right: 8, background: "rgba(204,51,51,0.9)", borderRadius: 3, padding: "2px 8px", fontSize: 10, fontFamily: "'DM Mono', monospace", color: "#fff" }}>
                      FLAGGED FOR REPRINT
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 12, fontFamily: "'DM Mono', monospace", fontSize: 12, color: TEXT_MUTED }}>
                  {selected.filename} · {selected.label}
                </div>

                {/* Navigation arrows */}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      const idx = images.findIndex(i => i.id === selectedId);
                      if (idx > 0) setSelectedId(images[idx - 1].id);
                    }}
                    style={{ background: BG_INPUT, border: "1px solid #2a3a45", borderRadius: 4, color: TEXT_DIM, padding: "5px 14px", cursor: "pointer", fontSize: 13 }}
                  >← prev</button>
                  <span style={{ padding: "5px 8px", fontSize: 11, fontFamily: "'DM Mono', monospace", color: TEXT_MUTED }}>
                    {images.findIndex(i => i.id === selectedId) + 1} / {images.length}
                  </span>
                  <button
                    className="icon-btn"
                    onClick={() => {
                      const idx = images.findIndex(i => i.id === selectedId);
                      if (idx < images.length - 1) setSelectedId(images[idx + 1].id);
                    }}
                    style={{ background: BG_INPUT, border: "1px solid #2a3a45", borderRadius: 4, color: TEXT_DIM, padding: "5px 14px", cursor: "pointer", fontSize: 13 }}
                  >next →</button>
                </div>
              </div>

              {/* Controls panel */}
              <div style={{ width: 260, background: BG_DEEP, borderLeft: "1px solid #1e2c35", padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>

                {/* QTY */}
                <div>
                  <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: TEXT_MUTED, letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>Quantity</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: BG_BASE, border: "1px solid #1e2c35", borderRadius: 5, padding: "10px 14px" }}>
                    <button
                      onClick={() => updateQty(selectedId, -1)}
                      style={{ width: 28, height: 28, background: BORDER_DIM, border: "none", borderRadius: 4, color: "#c8d8e0", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >−</button>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 24, fontWeight: 600, color: selected.qtyCurrent !== selected.qtyOriginal ? BRAND_GREEN : "#c8d8e0" }}>
                        {selected.qtyCurrent}
                      </div>
                      {selected.qtyCurrent !== selected.qtyOriginal && (
                        <div style={{ fontSize: 10, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
                          orig: {selected.qtyOriginal}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => updateQty(selectedId, 1)}
                      style={{ width: 28, height: 28, background: BORDER_DIM, border: "none", borderRadius: 4, color: "#c8d8e0", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >+</button>
                  </div>
                </div>

                {/* Divider */}
                <div style={{ borderTop: "1px solid #1e2c35" }} />

                {/* CMY Correction */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: TEXT_MUTED, letterSpacing: "0.1em", textTransform: "uppercase" }}>Colour Correction</div>
                    {hasCorrections && (
                      <button
                        onClick={() => setShowResetConfirm(true)}
                        style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#cc6644", background: "none", border: "1px solid #cc664444", borderRadius: 3, padding: "2px 7px", cursor: "pointer", letterSpacing: "0.05em" }}
                      >RESET</button>
                    )}
                  </div>

                  <Slider label="Cyan" value={selected.corrections.cyan} onChange={v => updateCorrection("cyan", v)} color="#44cccc" />
                  <Slider label="Magenta" value={selected.corrections.magenta} onChange={v => updateCorrection("magenta", v)} color="#cc44cc" />
                  <Slider label="Yellow" value={selected.corrections.yellow} onChange={v => updateCorrection("yellow", v)} color="#cccc44" />

                  {/* Hold toggle */}
                  <div
                    onClick={() => setHoldCorrection(!holdCorrection)}
                    style={{
                      marginTop: 12,
                      display: "flex", alignItems: "center", gap: 8,
                      background: holdCorrection ? "#1a2d1a" : BG_BASE,
                      border: `1px solid ${holdCorrection ? BRAND_GREEN + "88" : BORDER_DIM}`,
                      borderRadius: 4, padding: "7px 10px", cursor: "pointer",
                    }}
                  >
                    <div style={{
                      width: 14, height: 14, borderRadius: 3,
                      background: holdCorrection ? BRAND_GREEN : BORDER_DIM,
                      border: `2px solid ${holdCorrection ? BRAND_GREEN : BORDER}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.15s", flexShrink: 0,
                    }}>
                      {holdCorrection && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: holdCorrection ? BRAND_GREEN : TEXT_DIM, fontWeight: 500 }}>Hold Correction</div>
                      <div style={{ fontSize: 9, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>Apply to all images</div>
                    </div>
                  </div>
                </div>

                {/* Divider */}
                <div style={{ borderTop: "1px solid #1e2c35" }} />

                {/* Reprint */}
                <div>
                  <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: TEXT_MUTED, letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>Reprint</div>
                  <div
                    onClick={() => toggleReprint(selectedId)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      background: selected.reprint ? "#1e0a0a" : BG_BASE,
                      border: `1px solid ${selected.reprint ? "#cc3333" : BORDER_DIM}`,
                      borderRadius: 5, padding: "10px 12px", cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      background: selected.reprint ? "#cc3333" : BORDER_DIM,
                      border: `2px solid ${selected.reprint ? "#cc3333" : BORDER}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      transition: "all 0.15s", flexShrink: 0,
                    }}>
                      {selected.reprint && <span style={{ color: "#fff", fontSize: 10, lineHeight: 1 }}>✕</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: selected.reprint ? "#ff6666" : TEXT_DIM, fontWeight: 500 }}>
                        {selected.reprint ? "Flagged for Reprint" : "Flag for Reprint"}
                      </div>
                      <div style={{ fontSize: 9, color: TEXT_MUTED, fontFamily: "'DM Mono', monospace" }}>
                        {reprintCount > 0 ? `next: ${jobId}-r${reprintCount + 1}` : `creates ${jobId}-r1`}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Enhancement stub */}
                <div style={{ borderTop: "1px solid #1e2c35", paddingTop: 16 }}>
                  <div style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: BG_DEEP, letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>Enhancement</div>
                  <div style={{ background: BG_DEEP, border: "1px dashed #1e2c35", borderRadius: 5, padding: "10px 12px", opacity: 0.5 }}>
                    <div style={{ fontSize: 11, color: BORDER }}>Perfectly Clear</div>
                    <div style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: BG_DEEP, marginTop: 2 }}>Available in Phase 3</div>
                  </div>
                </div>

              </div>
            </div>

            {/* Bottom action bar */}
            <div style={{
              background: BG_DEEP,
              borderTop: "1px solid #1e2c35",
              padding: "12px 20px",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}>
              {showResetConfirm ? (
                <>
                  <span style={{ fontSize: 12, color: "#cc6644" }}>Reset corrections for this image?</span>
                  <button onClick={resetImage} style={{ background: "#cc3333", border: "none", borderRadius: 4, color: "#fff", padding: "6px 14px", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Confirm Reset</button>
                  <button onClick={() => setShowResetConfirm(false)} style={{ background: BORDER_DIM, border: "1px solid #2a3a45", borderRadius: 4, color: TEXT_DIM, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Cancel</button>
                </>
              ) : (
                <>
                  {reprintImages.length > 0 && (
                    <button
                      className="action-btn"
                      onClick={sendReprints}
                      style={{
                        background: "#cc3333", border: "none", borderRadius: 5,
                        color: "#fff", padding: "8px 18px", fontSize: 12, fontWeight: 600,
                        cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                    >
                      ↺ Send {reprintImages.length} Reprint{reprintImages.length > 1 ? "s" : ""} →
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, opacity: 0.85 }}>
                        {jobId}-r{reprintCount + 1}
                      </span>
                    </button>
                  )}
                  <div style={{ flex: 1 }} />

                  {modifiedImages.length > 0 && (
                    <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: TEXT_MUTED }}>
                      {modifiedImages.length} image{modifiedImages.length !== 1 ? "s" : ""} modified
                    </span>
                  )}

                  <button
                    className="action-btn"
                    style={{
                      background: BG_INPUT, border: "1px solid #2a3a45",
                      borderRadius: 5, color: TEXT_DIM, padding: "8px 16px",
                      fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    Save & Close
                  </button>
                  <button
                    className="action-btn"
                    style={{
                      background: BRAND_GREEN, border: "none",
                      borderRadius: 5, color: "#fff", padding: "8px 20px",
                      fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    Send to Print Controller →
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
