// Generated film-photograph-style SVG data URIs.
// These look like scanned 35mm frames: warm tones, slight vignette, an
// asymmetric subject so the correct orientation is obvious by eye.
// Intentionally varied so a misrotated frame stands out in the grid.

(function () {
  // Scene recipes — each is a small JS object the renderer turns into an SVG.
  // Each has a clear "up": sky at top, ground at bottom, main subject shifted
  // somewhere that isn't centered — so rotation is detectable.
  const SCENES = [
    // 0. portrait of a person, asymmetric (head in upper-left third)
    { kind: "portrait", sky: "#e3c9a4", ground: "#4a3826", skin: "#d8a77a", hair: "#2a1a12", shirt: "#6b3d2a", headX: 0.38, headY: 0.32 },
    { kind: "portrait", sky: "#b9c9d4", ground: "#2a3540", skin: "#c88f6a", hair: "#1a1410", shirt: "#3a4a5a", headX: 0.62, headY: 0.35 },
    { kind: "portrait", sky: "#e8d6b8", ground: "#5c4028", skin: "#e0b28a", hair: "#3e2820", shirt: "#8a5a3a", headX: 0.45, headY: 0.3 },
    // landscape — horizon high, sun/tree on one side
    { kind: "landscape", sky: "#f2d4a0", ground: "#6b4e2a", horizon: 0.35, sun: { x: 0.72, y: 0.22, r: 0.08, c: "#f8eac0" }, trees: [0.15, 0.82] },
    { kind: "landscape", sky: "#cfd9dc", ground: "#4d5a3e", horizon: 0.42, sun: null, trees: [0.22, 0.58, 0.86] },
    { kind: "landscape", sky: "#e9b97a", ground: "#2f2218", horizon: 0.3, sun: { x: 0.28, y: 0.18, r: 0.06, c: "#ffd58a" }, trees: [0.78] },
    // building — tall rectangle near one edge with sky above
    { kind: "building", sky: "#c9d4dc", ground: "#3f3428", bldgX: 0.55, bldgW: 0.3, bldgH: 0.7, bldgC: "#8a6f4a" },
    { kind: "building", sky: "#d8c9a8", ground: "#2e2218", bldgX: 0.18, bldgW: 0.24, bldgH: 0.55, bldgC: "#6a4e32" },
    // street — horizon vanishing point
    { kind: "street", sky: "#d2c0a0", ground: "#3a2e20", vpX: 0.42, vpY: 0.48 },
    { kind: "street", sky: "#b0bcc4", ground: "#2a2a30", vpX: 0.62, vpY: 0.52 },
    // still life — object on surface, table line across lower third
    { kind: "still", sky: "#e8d8b8", ground: "#7a5836", tableY: 0.62, obj: { x: 0.4, y: 0.45, w: 0.18, h: 0.22, c: "#a85028" } },
    { kind: "still", sky: "#d4c8b0", ground: "#4a3820", tableY: 0.7, obj: { x: 0.58, y: 0.52, w: 0.14, h: 0.26, c: "#2e4a3a" } },
    // window / interior
    { kind: "window", sky: "#b8c8d2", ground: "#2e2218", winX: 0.3, winY: 0.18, winW: 0.42, winH: 0.45 },
    // beach
    { kind: "beach", sky: "#cfd9e4", sea: "#5a7a8a", sand: "#d8b884", horizon: 0.42, surf: 0.58 },
    // tree
    { kind: "tree", sky: "#d8c0a0", ground: "#5a4228", trunkX: 0.62, trunkW: 0.05, canopyR: 0.22, canopyC: "#3a4a2a" },
    // tree 2
    { kind: "tree", sky: "#b8c4b0", ground: "#3e3020", trunkX: 0.32, trunkW: 0.04, canopyR: 0.18, canopyC: "#4a5a3a" },
    // dog
    { kind: "dog", sky: "#cfc0a4", ground: "#5a4228", dogX: 0.45, dogY: 0.58, dogC: "#8a6a42" },
    // car
    { kind: "car", sky: "#b8c4cc", ground: "#3a3028", carX: 0.35, carW: 0.42, carY: 0.58, carC: "#2a3a5a" },
  ];

  // Render one scene to an SVG string at the given aspect.
  // w/h in SVG user units; we always draw as 100×70 landscape or 70×100 portrait.
  function renderScene(s, portrait) {
    const W = portrait ? 70 : 100;
    const H = portrait ? 100 : 70;
    const horizon = s.horizon || 0.5;
    const parts = [];
    // grain/film base
    parts.push(`<rect width="${W}" height="${H}" fill="${s.sky}"/>`);
    // ground band
    parts.push(`<rect x="0" y="${H * horizon}" width="${W}" height="${H * (1 - horizon)}" fill="${s.ground}"/>`);

    if (s.kind === "portrait") {
      const hx = W * s.headX;
      const hy = H * s.headY;
      const hr = Math.min(W, H) * 0.16;
      // shoulders
      parts.push(`<path d="M ${hx - hr * 1.8} ${H} Q ${hx - hr * 1.5} ${hy + hr * 1.2} ${hx - hr * 0.9} ${hy + hr * 1.05} L ${hx + hr * 0.9} ${hy + hr * 1.05} Q ${hx + hr * 1.5} ${hy + hr * 1.2} ${hx + hr * 1.8} ${H} Z" fill="${s.shirt}"/>`);
      // head
      parts.push(`<circle cx="${hx}" cy="${hy}" r="${hr}" fill="${s.skin}"/>`);
      // hair
      parts.push(`<path d="M ${hx - hr} ${hy - hr * 0.1} Q ${hx - hr * 0.9} ${hy - hr * 1.2} ${hx} ${hy - hr * 1.05} Q ${hx + hr * 0.9} ${hy - hr * 1.2} ${hx + hr} ${hy - hr * 0.1} Q ${hx + hr * 0.6} ${hy - hr * 0.7} ${hx} ${hy - hr * 0.6} Q ${hx - hr * 0.6} ${hy - hr * 0.7} ${hx - hr} ${hy - hr * 0.1} Z" fill="${s.hair}"/>`);
      // eyes
      parts.push(`<ellipse cx="${hx - hr * 0.35}" cy="${hy - hr * 0.05}" rx="${hr * 0.07}" ry="${hr * 0.1}" fill="#1a1410"/>`);
      parts.push(`<ellipse cx="${hx + hr * 0.35}" cy="${hy - hr * 0.05}" rx="${hr * 0.07}" ry="${hr * 0.1}" fill="#1a1410"/>`);
    } else if (s.kind === "landscape") {
      const hy = H * s.horizon;
      // sun
      if (s.sun) {
        parts.push(`<circle cx="${W * s.sun.x}" cy="${H * s.sun.y}" r="${Math.min(W, H) * s.sun.r}" fill="${s.sun.c}" opacity="0.95"/>`);
      }
      // hills silhouette
      parts.push(`<path d="M 0 ${hy} Q ${W * 0.25} ${hy - H * 0.05} ${W * 0.5} ${hy - H * 0.02} T ${W} ${hy} L ${W} ${H} L 0 ${H} Z" fill="${s.ground}" opacity="0.9"/>`);
      // trees
      (s.trees || []).forEach((tx) => {
        const x = W * tx;
        parts.push(`<rect x="${x - 1}" y="${hy - H * 0.08}" width="2" height="${H * 0.08}" fill="#2a2018"/>`);
        parts.push(`<ellipse cx="${x}" cy="${hy - H * 0.1}" rx="${Math.min(W, H) * 0.06}" ry="${Math.min(W, H) * 0.08}" fill="#3a4a2a"/>`);
      });
    } else if (s.kind === "building") {
      const bx = W * s.bldgX, bw = W * s.bldgW, bh = H * s.bldgH;
      const by = H * horizon - bh;
      parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${s.bldgC}"/>`);
      // windows
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          parts.push(`<rect x="${bx + bw * 0.15 + (bw * 0.25) * c}" y="${by + bh * 0.1 + (bh * 0.16) * r}" width="${bw * 0.15}" height="${bh * 0.08}" fill="#e8d6a0" opacity="0.85"/>`);
        }
      }
    } else if (s.kind === "street") {
      const vpx = W * s.vpX, vpy = H * s.vpY;
      // road
      parts.push(`<path d="M 0 ${H} L ${vpx} ${vpy} L ${W} ${H} Z" fill="#3a3028"/>`);
      parts.push(`<path d="M ${W * 0.48} ${H} L ${vpx} ${vpy} L ${W * 0.52} ${H} Z" fill="#8a7a5a" opacity="0.5"/>`);
      // buildings left/right
      parts.push(`<rect x="0" y="${vpy - H * 0.25}" width="${vpx * 0.7}" height="${H - (vpy - H * 0.25)}" fill="#5a4a38"/>`);
      parts.push(`<rect x="${vpx + (W - vpx) * 0.3}" y="${vpy - H * 0.2}" width="${(W - vpx) * 0.7}" height="${H - (vpy - H * 0.2)}" fill="#6a5a48"/>`);
    } else if (s.kind === "still") {
      const ty = H * s.tableY;
      parts.push(`<rect x="0" y="${ty}" width="${W}" height="${H - ty}" fill="${s.ground}"/>`);
      const o = s.obj;
      parts.push(`<rect x="${W * o.x}" y="${H * o.y}" width="${W * o.w}" height="${H * o.h}" rx="${W * o.w * 0.15}" fill="${o.c}"/>`);
      // highlight
      parts.push(`<rect x="${W * o.x + W * o.w * 0.15}" y="${H * o.y + H * o.h * 0.1}" width="${W * o.w * 0.2}" height="${H * o.h * 0.3}" rx="2" fill="#fff" opacity="0.2"/>`);
    } else if (s.kind === "window") {
      parts.push(`<rect x="${W * s.winX}" y="${H * s.winY}" width="${W * s.winW}" height="${H * s.winH}" fill="#e8dab0"/>`);
      parts.push(`<line x1="${W * (s.winX + s.winW / 2)}" y1="${H * s.winY}" x2="${W * (s.winX + s.winW / 2)}" y2="${H * (s.winY + s.winH)}" stroke="#3a2a1a" stroke-width="1"/>`);
      parts.push(`<line x1="${W * s.winX}" y1="${H * (s.winY + s.winH / 2)}" x2="${W * (s.winX + s.winW)}" y2="${H * (s.winY + s.winH / 2)}" stroke="#3a2a1a" stroke-width="1"/>`);
    } else if (s.kind === "beach") {
      parts.push(`<rect width="${W}" height="${H * s.horizon}" fill="${s.sky}"/>`);
      parts.push(`<rect y="${H * s.horizon}" width="${W}" height="${H * (s.surf - s.horizon)}" fill="${s.sea}"/>`);
      parts.push(`<rect y="${H * s.surf}" width="${W}" height="${H * (1 - s.surf)}" fill="${s.sand}"/>`);
      parts.push(`<ellipse cx="${W * 0.2}" cy="${H * s.surf}" rx="${W * 0.12}" ry="2" fill="#fff" opacity="0.6"/>`);
    } else if (s.kind === "tree") {
      parts.push(`<rect x="${W * s.trunkX - W * s.trunkW / 2}" y="${H * horizon - H * 0.05}" width="${W * s.trunkW}" height="${H * 0.5}" fill="#3a2818"/>`);
      parts.push(`<circle cx="${W * s.trunkX}" cy="${H * horizon - H * 0.1}" r="${Math.min(W, H) * s.canopyR}" fill="${s.canopyC}"/>`);
    } else if (s.kind === "dog") {
      const dx = W * s.dogX, dy = H * s.dogY;
      parts.push(`<ellipse cx="${dx}" cy="${dy}" rx="${W * 0.12}" ry="${H * 0.08}" fill="${s.dogC}"/>`);
      parts.push(`<circle cx="${dx + W * 0.1}" cy="${dy - H * 0.06}" r="${Math.min(W, H) * 0.06}" fill="${s.dogC}"/>`);
      parts.push(`<rect x="${dx - W * 0.08}" y="${dy + H * 0.04}" width="2" height="${H * 0.08}" fill="${s.dogC}"/>`);
      parts.push(`<rect x="${dx + W * 0.06}" y="${dy + H * 0.04}" width="2" height="${H * 0.08}" fill="${s.dogC}"/>`);
    } else if (s.kind === "car") {
      const cx = W * s.carX, cw = W * s.carW, cy = H * s.carY;
      parts.push(`<rect x="${cx}" y="${cy - H * 0.05}" width="${cw}" height="${H * 0.12}" rx="4" fill="${s.carC}"/>`);
      parts.push(`<rect x="${cx + cw * 0.2}" y="${cy - H * 0.11}" width="${cw * 0.55}" height="${H * 0.07}" rx="3" fill="${s.carC}"/>`);
      parts.push(`<rect x="${cx + cw * 0.25}" y="${cy - H * 0.095}" width="${cw * 0.45}" height="${H * 0.05}" fill="#c8d4dc" opacity="0.7"/>`);
      parts.push(`<circle cx="${cx + cw * 0.22}" cy="${cy + H * 0.07}" r="${H * 0.035}" fill="#1a1410"/>`);
      parts.push(`<circle cx="${cx + cw * 0.78}" cy="${cy + H * 0.07}" r="${H * 0.035}" fill="#1a1410"/>`);
    }

    // film grain overlay (sparse dots)
    let grain = "";
    for (let i = 0; i < 40; i++) {
      const x = (i * 37.1) % W;
      const y = (i * 23.7) % H;
      const a = 0.03 + ((i * 7) % 9) * 0.008;
      grain += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="0.5" fill="#000" opacity="${a.toFixed(2)}"/>`;
    }
    parts.push(grain);
    // vignette
    parts.push(`<radialGradient id="v${Math.random().toString(36).slice(2, 7)}"><stop offset="65%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.35"/></radialGradient>`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${parts.join("")}</svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  // Produce a pool of varied thumbnails. Mix portrait and landscape.
  const THUMBS = SCENES.map((s, i) => ({
    src: renderScene(s, i % 5 === 0 || s.kind === "portrait" || s.kind === "window"),
    portrait: i % 5 === 0 || s.kind === "portrait" || s.kind === "window",
  }));

  window.FILM_THUMBS = THUMBS;
})();
