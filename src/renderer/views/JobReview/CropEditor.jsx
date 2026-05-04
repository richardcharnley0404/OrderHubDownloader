import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * src/renderer/views/JobReview/CropEditor.jsx
 *
 * Full-screen crop tool overlay.
 *
 * Displays the current working image on an HTML5 Canvas with:
 *   - Dark overlay outside the crop box
 *   - Aspect-ratio-locked crop box (ratio derived from channelMapping)
 *   - Four corner drag handles for resize (aspect-ratio preserved)
 *   - Interior drag for move
 *   - Rule-of-thirds grid
 *   - Size label inside the crop box
 *
 * The crop rect is tracked in *image-space* pixels (coordinates relative to
 * the natural pixel dimensions of the image) so the IPC handler can pass them
 * directly to Sharp without any rescaling.
 *
 * Props:
 *   image           ImageEntry   - selected image (filename, cropRect?)
 *   jobPath         string       - absolute path to the job root folder
 *   channelMapping  object|null  - selected channel mapping (used to infer aspect ratio)
 *   onApply         (cropRect) => void  - called with { x, y, w, h } in image-space pixels
 *   onCancel        () => void
 */

// ── Size parser ───────────────────────────────────────────────────────────────

/**
 * Attempt to derive a print size from a channel mapping object.
 * Checks: size field, sortString, printSizeCode, batchCode — in that order.
 * Recognises NxM patterns and well-known codes (KG = 4×6, 2L = 5×7).
 *
 * @param {object|null} mapping
 * @returns {{ w: number, h: number, label: string } | null}
 */
export function parseSizeFromMapping(mapping) {
  if (!mapping) return null;

  const candidates = [
    mapping.size,
    mapping.sortString,
    mapping.printSizeCode,
    mapping.batchCode,
  ].filter(Boolean);

  for (const str of candidates) {
    const match = String(str).match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      const w = parseFloat(match[1]);
      const h = parseFloat(match[2]);
      return { w, h, label: `${match[1]}×${match[2]}"` };
    }
  }

  // Well-known short codes
  const code = (mapping.printSizeCode || mapping.batchCode || '').toUpperCase().trim();
  if (code === 'KG')  return { w: 4, h: 6,  label: '4×6"'  };
  if (code === '2L')  return { w: 5, h: 7,  label: '5×7"'  };
  if (code === '3L')  return { w: 3.5, h: 5, label: '3.5×5"' };
  if (code === 'A4')  return { w: 8.27, h: 11.69, label: 'A4' };
  if (code === 'A5')  return { w: 5.83, h: 8.27, label: 'A5' };

  return null;
}

// ── Canvas drawing ────────────────────────────────────────────────────────────

const HANDLE_SIZE   = 8;   // drawn size of corner handles in canvas pixels
const HANDLE_HIT    = 14;  // pointer hit area radius
const MIN_CROP_IMG  = 40;  // minimum crop dimension in image-space pixels

function layoutForCanvas(canvas, imgW, imgH) {
  const padding = 24;
  const dw = canvas.width;
  const dh = canvas.height;
  const scale = Math.min((dw - padding * 2) / imgW, (dh - padding * 2) / imgH);
  const displayW = imgW * scale;
  const displayH = imgH * scale;
  const offsetX  = (dw - displayW) / 2;
  const offsetY  = (dh - displayH) / 2;
  return { scale, offsetX, offsetY, displayW, displayH };
}

function drawCanvas(canvas, imgEl, naturalSize, cropRect) {
  if (!canvas || !imgEl || !naturalSize.w || !cropRect) return;

  const ctx = canvas.getContext('2d');
  const { w: iw, h: ih } = naturalSize;
  const layout = layoutForCanvas(canvas, iw, ih);
  const { scale, offsetX, offsetY, displayW, displayH } = layout;

  // Store layout so pointer handlers can reference it without re-computing.
  canvas._cropLayout = layout;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Image ──────────────────────────────────────────────────────────────────
  ctx.drawImage(imgEl, offsetX, offsetY, displayW, displayH);

  // ── Crop box in canvas space ───────────────────────────────────────────────
  const cx = offsetX + cropRect.x * scale;
  const cy = offsetY + cropRect.y * scale;
  const cw = cropRect.w * scale;
  const ch = cropRect.h * scale;

  // Dark overlay (four rects surrounding the crop box)
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  // top
  ctx.fillRect(offsetX, offsetY, displayW, Math.max(0, cy - offsetY));
  // bottom
  ctx.fillRect(offsetX, cy + ch, displayW, Math.max(0, offsetY + displayH - (cy + ch)));
  // left
  ctx.fillRect(offsetX, cy, Math.max(0, cx - offsetX), ch);
  // right
  ctx.fillRect(cx + cw, cy, Math.max(0, offsetX + displayW - (cx + cw)), ch);

  // Crop border
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);

  // Rule-of-thirds grid
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 0.75;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(cx + (cw / 3) * i, cy); ctx.lineTo(cx + (cw / 3) * i, cy + ch); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + (ch / 3) * i); ctx.lineTo(cx + cw, cy + (ch / 3) * i); ctx.stroke();
  }

  // Corner handles
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur  = 3;
  [
    [cx,            cy           ],  // TL
    [cx + cw - HANDLE_SIZE, cy  ],  // TR
    [cx,            cy + ch - HANDLE_SIZE],  // BL
    [cx + cw - HANDLE_SIZE, cy + ch - HANDLE_SIZE],  // BR
  ].forEach(([hx, hy]) => ctx.fillRect(hx, hy, HANDLE_SIZE, HANDLE_SIZE));
  ctx.shadowBlur = 0;

  // Size label (top-left of crop box)
  ctx.font = '11px "DM Mono", monospace';
  const labelText = `${cropRect.w} × ${cropRect.h} px`;
  const labelW = ctx.measureText(labelText).width + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(cx + 4, cy + 4, labelW, 18);
  ctx.fillStyle = '#fff';
  ctx.fillText(labelText, cx + 8, cy + 16);
}

// ── Handle detection ──────────────────────────────────────────────────────────

function detectHandle(px, py, canvas, cropRect, scale, offsetX, offsetY) {
  if (!cropRect) return null;

  const cx = offsetX + cropRect.x * scale;
  const cy = offsetY + cropRect.y * scale;
  const cw = cropRect.w * scale;
  const ch = cropRect.h * scale;

  const corners = [
    { name: 'TL', x: cx,                       y: cy                       },
    { name: 'TR', x: cx + cw - HANDLE_HIT,     y: cy                       },
    { name: 'BL', x: cx,                       y: cy + ch - HANDLE_HIT     },
    { name: 'BR', x: cx + cw - HANDLE_HIT,     y: cy + ch - HANDLE_HIT     },
  ];

  for (const c of corners) {
    if (px >= c.x && px <= c.x + HANDLE_HIT && py >= c.y && py <= c.y + HANDLE_HIT) {
      return c.name;
    }
  }

  // Interior — move
  if (px >= cx && px <= cx + cw && py >= cy && py <= cy + ch) return 'MOVE';

  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CropEditor({ image, jobPath, sizeOption, onApply, onCancel }) {
  const canvasRef   = useRef(null);
  const imgRef      = useRef(null);
  const dragRef     = useRef(null);   // { handle, startX, startY, startRect }

  const [imgLoaded,    setImgLoaded]    = useState(false);
  const [naturalSize,  setNaturalSize]  = useState({ w: 0, h: 0 });
  const [cropRect,     setCropRect]     = useState(null);   // image-space { x, y, w, h }
  const [applying,     setApplying]     = useState(false);

  // Aspect ratio comes directly from the sizeOption; default to square if unset.
  const aspectRatio = sizeOption ? sizeOption.w / sizeOption.h : 1;

  // Working-copy URL — the image in /working/ is what the user sees
  const imageSrc = jobPath && image?.filename
    ? `file://${jobPath.replace(/\\/g, '/')}/working/${image.filename}`
    : null;

  // ── Initialise crop rect once the image is loaded ─────────────────────────

  useEffect(() => {
    if (!imgLoaded || !naturalSize.w) return;

    // Reuse any existing crop that was applied previously
    if (image?.cropRect) {
      setCropRect({ ...image.cropRect });
      return;
    }

    // Fit the largest possible crop box of the target aspect ratio
    const { w: iw, h: ih } = naturalSize;
    let cw, ch;
    if (iw / ih > aspectRatio) {
      ch = ih;
      cw = ch * aspectRatio;
    } else {
      cw = iw;
      ch = cw / aspectRatio;
    }
    const cx = (iw - cw) / 2;
    const cy = (ih - ch) / 2;
    setCropRect({ x: Math.round(cx), y: Math.round(cy), w: Math.round(cw), h: Math.round(ch) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgLoaded, naturalSize.w, naturalSize.h, aspectRatio]);

  // ── Redraw canvas whenever crop rect changes ───────────────────────────────

  useEffect(() => {
    if (!imgLoaded || !cropRect) return;
    drawCanvas(canvasRef.current, imgRef.current, naturalSize, cropRect);
  }, [imgLoaded, cropRect, naturalSize]);

  // ── Canvas size matches its container ────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth  || 880;
      canvas.height = canvas.offsetHeight || 580;
      if (imgLoaded && cropRect) {
        drawCanvas(canvas, imgRef.current, naturalSize, cropRect);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgLoaded, cropRect, naturalSize]);

  // ── Pointer helpers ───────────────────────────────────────────────────────

  function canvasPoint(e) {
    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    // Map CSS pixels → canvas pixels
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      px: (e.clientX - rect.left) * scaleX,
      py: (e.clientY - rect.top)  * scaleY,
    };
  }

  const onPointerDown = useCallback((e) => {
    if (!canvasRef.current || !cropRect) return;
    const layout = canvasRef.current._cropLayout;
    if (!layout) return;
    const { px, py } = canvasPoint(e);
    const handle = detectHandle(px, py, canvasRef.current, cropRect, layout.scale, layout.offsetX, layout.offsetY);
    if (!handle) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { handle, startX: px, startY: py, startRect: { ...cropRect } };
  }, [cropRect]);

  const onPointerMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layout = canvas._cropLayout;
    if (!layout) return;
    const { px, py } = canvasPoint(e);

    // Update cursor even when not dragging
    if (!dragRef.current) {
      const handle = detectHandle(px, py, canvas, cropRect, layout.scale, layout.offsetX, layout.offsetY);
      if (!handle)                      canvas.style.cursor = 'default';
      else if (handle === 'MOVE')       canvas.style.cursor = 'move';
      else if (handle === 'TL' || handle === 'BR') canvas.style.cursor = 'nwse-resize';
      else                              canvas.style.cursor = 'nesw-resize';
      return;
    }

    const { handle, startX, startY, startRect } = dragRef.current;
    const { scale }   = layout;
    const { w: iw, h: ih } = naturalSize;

    // Deltas in image-space pixels
    const dx = (px - startX) / scale;
    const dy = (py - startY) / scale;

    let { x, y, w, h } = startRect;

    if (handle === 'MOVE') {
      x = Math.max(0, Math.min(iw - w, startRect.x + dx));
      y = Math.max(0, Math.min(ih - h, startRect.y + dy));
    } else {
      // Resize with aspect-ratio lock
      if (handle === 'BR') {
        w = Math.max(MIN_CROP_IMG, startRect.w + dx);
        h = w / aspectRatio;
      } else if (handle === 'TR') {
        w = Math.max(MIN_CROP_IMG, startRect.w + dx);
        h = w / aspectRatio;
        y = startRect.y + startRect.h - h;
      } else if (handle === 'BL') {
        w = Math.max(MIN_CROP_IMG, startRect.w - dx);
        h = w / aspectRatio;
        x = startRect.x + startRect.w - w;
      } else if (handle === 'TL') {
        w = Math.max(MIN_CROP_IMG, startRect.w - dx);
        h = w / aspectRatio;
        x = startRect.x + startRect.w - w;
        y = startRect.y + startRect.h - h;
      }

      // Clamp to image bounds
      if (x < 0)      { w += x;      h = w / aspectRatio; x = 0;    }
      if (y < 0)      { h -= y;      w = h * aspectRatio; y = 0;    }
      if (x + w > iw) { w = iw - x;  h = w / aspectRatio;           }
      if (y + h > ih) { h = ih - y;  w = h * aspectRatio;           }

      // Final minimum guard
      w = Math.max(MIN_CROP_IMG, w);
      h = Math.max(MIN_CROP_IMG, h);
    }

    setCropRect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropRect, naturalSize, aspectRatio]);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── Apply ─────────────────────────────────────────────────────────────────

  async function handleApply() {
    if (!cropRect || !imgLoaded) return;
    setApplying(true);
    try {
      await onApply(cropRect);
    } finally {
      setApplying(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Crop image"
      className="jr-crop-overlay"
    >
      {/* Hidden img element used as canvas source */}
      <img
        ref={imgRef}
        src={imageSrc}
        style={{ display: 'none' }}
        onLoad={e => {
          setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight });
          setImgLoaded(true);
        }}
        onError={() => setImgLoaded(false)}
        alt=""
      />

      {/* Header label */}
      <div className="jr-crop-header">
        {sizeOption
          ? `Crop to ${sizeOption.label} — drag corners to resize`
          : 'Crop image — drag corners to resize'}
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="jr-crop-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {!imgLoaded && (
        <div className="jr-crop-loading">Loading image…</div>
      )}

      {/* Buttons */}
      <div className="jr-crop-buttons">
        <button
          onClick={onCancel}
          disabled={applying}
          className="jr-crop-btn jr-crop-btn--cancel"
        >
          Cancel
        </button>

        <button
          onClick={handleApply}
          disabled={!cropRect || !imgLoaded || applying}
          className="jr-crop-btn jr-crop-btn--apply"
        >
          {applying ? 'Applying…' : 'Apply Crop'}
        </button>
      </div>

      {/* Crop dimensions readout */}
      {cropRect && imgLoaded && (
        <div className="jr-crop-readout">
          {cropRect.w} × {cropRect.h} px  |  source: {naturalSize.w} × {naturalSize.h} px
        </div>
      )}
    </div>
  );
}
