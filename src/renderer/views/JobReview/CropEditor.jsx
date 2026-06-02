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
 *   image            ImageEntry  - selected image (filename, cropRect?)
 *   jobPath          string      - absolute path to the job root folder
 *   sizeOption       object|null - selected size option; w/h drive the aspect lock
 *   originalPath     string|null - absolute path to the customer's uncropped upload;
 *                                  truthy enables the Source = Customer crop | Original
 *                                  toggle (Phase 2 of Customer Originals)
 *   onApply          (cropRect) => void  - re-crop the printable JPEG (current behaviour)
 *   onApplyOriginal  (cropRect) => void  - re-crop the customer upload (Phase 2);
 *                                  only invoked when source toggle is "Original"
 *   onCancel         () => void
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

function drawCanvas(canvas, imgEl, naturalSize, cropRect, imageRotation = 0) {
  if (!canvas || !imgEl || !naturalSize.w || !cropRect) return;

  const ctx = canvas.getContext('2d');
  // M5c (2026-05-26): when imageRotation is 90/270 the EFFECTIVE
  // natural dimensions swap. naturalSize as passed in is the
  // POST-rotation dimensions (the caller computes them); cropRect's
  // coords are in that same post-rotation space. drawCanvas's job
  // here is just to render the rotated image at the right place on
  // the canvas — the rest of the math (crop box, handles, hit
  // testing) operates in the post-rotation coordinate system.
  const { w: iw, h: ih } = naturalSize;
  const layout = layoutForCanvas(canvas, iw, ih);
  const { scale, offsetX, offsetY, displayW, displayH } = layout;

  // Store layout so pointer handlers can reference it without re-computing.
  canvas._cropLayout = layout;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ── Image ──────────────────────────────────────────────────────────────────
  //
  // For rotation === 0: draw the image directly at the canvas-space
  // layout. M5a/b path; byte-identical visual to pre-M5c.
  //
  // For rotation !== 0: rotate the canvas around the centre of the
  // would-be displayW × displayH region, then draw the image
  // centred at origin. When rotation is 90 or 270, the source
  // image's natural dims are SWAPPED relative to displayW/displayH
  // — that's the whole point of swapping naturalSize at the caller.
  if (!imageRotation || imageRotation === 0) {
    ctx.drawImage(imgEl, offsetX, offsetY, displayW, displayH);
  } else {
    const centerX = offsetX + displayW / 2;
    const centerY = offsetY + displayH / 2;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((imageRotation * Math.PI) / 180);
    // After rotation, the image draws at its OWN natural-axis
    // dimensions, swapped. drawImage is centered at origin.
    const sourceDisplayW = (imageRotation === 90 || imageRotation === 270) ? displayH : displayW;
    const sourceDisplayH = (imageRotation === 90 || imageRotation === 270) ? displayW : displayH;
    ctx.drawImage(imgEl, -sourceDisplayW / 2, -sourceDisplayH / 2, sourceDisplayW, sourceDisplayH);
    ctx.restore();
  }

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

export function CropEditor({
  image, jobPath, sizeOption,
  originalPath = null,
  onApply, onApplyOriginal, onApplyAndSendReprint,
  onCancel,
  // M5c (2026-05-26): optional rotation + chrome-hiding props for
  // ManualCropMode (originally FocusedCropFrame, deleted in the
  // 2026-06-01 redesign that inlined its chrome into CropStage).
  // Both default to compatible-with-pre-M5c behaviour so the
  // standard-drawer caller is unaffected.
  imageRotation = 0,        // 0|90|180|270; rotates the displayed image + crop coord space
  hideOwnChrome = false,    // when true, suppresses Apply/Cancel/source/orientation chrome
  onCropRectChange,         // optional (cropRect) => void; emitted on every cropRect change
                            // so ManualCropMode can track + apply imperatively on Enter
  onImgLoadedChange,        // optional (boolean) => void; signals image-loaded state for
                            // ManualCropMode's Approve gate
  controlledOrientation, // optional 'portrait'|'landscape' — when present, overrides the
                         // internal orientationOverride state so ManualCropMode can drive
                         // the toggle from outside in hideOwnChrome mode
  // Manual Crop redesign (2026-06-02). Which job-relative folder to load
  // pixels from when source === 'customer'. Default 'working' preserves
  // M5a semantics for the standard-drawer caller and the Customer
  // Originals Phase 2 "Customer crop" toggle. ManualCropMode passes
  // 'originals' so the stage shows the pristine pre-crop source —
  // otherwise the saved cropRect doesn't fit the already-cropped
  // /working/<filename> for previously-approved images and the seed
  // effect below falls through to auto-fit, emitting a spurious
  // "modified" state via onCropRectChange.
  folderName = 'working',
}) {
  const canvasRef   = useRef(null);
  const imgRef      = useRef(null);
  const dragRef     = useRef(null);   // { handle, startX, startY, startRect }

  const [imgLoaded,    setImgLoaded]    = useState(false);
  const [naturalSize,  setNaturalSize]  = useState({ w: 0, h: 0 });
  const [cropRect,     setCropRect]     = useState(null);   // image-space { x, y, w, h }
  const [applying,     setApplying]     = useState(false);

  // Orientation override for the crop box. null = follow the routed size
  // as-is (fresh row, no saved crop); 'portrait' / 'landscape' = pinned,
  // either by the operator flipping the toggle or — on reopen — seeded from
  // a saved cropRect so the toggle and the aspect lock match the box that's
  // about to be drawn (no lock-state desync). Ephemeral per cropper session:
  // CropEditor remounts on every modal open, so this is never persisted.
  const [orientationOverride, setOrientationOverride] = useState(() => {
    const r = image?.cropRect;
    if (!r || !r.w || !r.h) return null;
    return r.w >= r.h ? 'landscape' : 'portrait';
  });

  // Customer Originals (Phase 2) — Source toggle.
  // The toggle is offered only when the renderer can resolve an originalPath
  // for this image AND a re-crop handler is wired up. With no original or no
  // handler we behave exactly like the pre-Phase-2 cropper (Customer crop only).
  const canUseOriginal = Boolean(originalPath && onApplyOriginal);
  const [source, setSource] = useState('customer'); // 'customer' | 'original'
  // If the cropper is re-opened on a row that lost its original, fall back
  // safely to customer mode rather than rendering a dead toggle.
  useEffect(() => {
    if (!canUseOriginal && source !== 'customer') setSource('customer');
  }, [canUseOriginal, source]);

  // Aspect ratio is derived from the routed sizeOption; default to square if
  // unset. `orientationOverride` lets the operator flip a non-square size
  // between portrait and landscape without changing the routed size itself.
  // Math.max/min over baseAspect and 1/baseAspect keeps this robust to a
  // sizeOption that is already landscape (e.g. a 6×4 channel mapping):
  // landscape always resolves to the >1 ratio, portrait to the <1.
  // The lock applies identically to both source modes — the brief is explicit
  // that the routed size is the authoritative aspect even on the original.
  const baseAspect  = sizeOption ? sizeOption.w / sizeOption.h : 1;
  const isSquare    = !sizeOption || Math.abs(baseAspect - 1) < 0.001;
  // M5c: external override wins when supplied (ManualCropMode's
  // per-image orientation toggle in hideOwnChrome mode). Falls
  // through to the internal state for the standard-drawer caller.
  const effectiveOrientationOverride = controlledOrientation || orientationOverride;
  const orientation = effectiveOrientationOverride
    ?? (baseAspect >= 1 ? 'landscape' : 'portrait');
  const aspectRatio = orientation === 'landscape'
    ? Math.max(baseAspect, 1 / baseAspect)
    : Math.min(baseAspect, 1 / baseAspect);

  // Image source:
  //   customer → /{folderName}/{image.filename}  (default folderName='working';
  //                                                ManualCropMode passes 'originals')
  //   original → originalPath                (manifest-resolved customer upload)
  const imageSrc = (() => {
    if (source === 'original' && canUseOriginal) {
      return `file:///${originalPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    }
    return jobPath && image?.filename
      ? `file://${jobPath.replace(/\\/g, '/')}/${folderName}/${image.filename}`
      : null;
  })();

  // Reset the load + rect state when the source toggle flips — the cropper
  // is about to point at a different file with different natural dimensions,
  // so any previous crop rect is meaningless until the new image loads.
  useEffect(() => {
    setImgLoaded(false);
    setNaturalSize({ w: 0, h: 0 });
    setCropRect(null);
  }, [source]);

  // ── Initialise crop rect once the image is loaded ─────────────────────────

  useEffect(() => {
    if (!imgLoaded || !naturalSize.w) return;

    // Reuse any existing crop ONLY in customer-crop mode. On the original
    // upload the dimensions are different from the printable JPEG, so a
    // saved cropRect against the printable wouldn't translate cleanly.
    // Two gates before reusing the saved rect:
    //   1. It must FIT the image currently loaded. ohd:job:crop-image does
    //      an IN-PLACE crop — it overwrites /working/{filename} with the
    //      cropped (smaller) result, while the saved cropRect stays in the
    //      PRE-crop coordinate space. Reusing it against the now-smaller
    //      working image yields an out-of-bounds rect that crashes
    //      sharp.extract() ("extract_area: bad extract area"). If it no
    //      longer fits, fall through and re-fit a fresh box.
    //   2. Its derived orientation must match the current effective
    //      `orientation` (compared via the rect's own w/h — robust to
    //      orientationOverride being nulled with a saved rect present).
    // A genuine orientation flip changes aspectRatio (in the deps below),
    // re-runs this effect, and falls through to the re-fit branch.
    if (source === 'customer' && image?.cropRect) {
      const r = image.cropRect;
      const fitsLoadedImage =
        r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 &&
        r.x + r.w <= naturalSize.w &&
        r.y + r.h <= naturalSize.h;
      const savedOrientation = r.w >= r.h ? 'landscape' : 'portrait';
      if (fitsLoadedImage && savedOrientation === orientation) {
        setCropRect({ ...r });
        return;
      }
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
  }, [imgLoaded, naturalSize.w, naturalSize.h, aspectRatio, source]);

  // ── Redraw canvas whenever crop rect changes ───────────────────────────────

  useEffect(() => {
    if (!imgLoaded || !cropRect) return;
    drawCanvas(canvasRef.current, imgRef.current, naturalSize, cropRect, imageRotation);
  }, [imgLoaded, cropRect, naturalSize, imageRotation]);

  // M5c (2026-05-26): when imageRotation changes while mounted (e.g.
  // ManualCropMode's R / L shortcut), swap naturalSize.w/h so the
  // crop-coord space matches the rotated view. Only fires when the
  // image is already loaded — the onLoad branch handles initial seed.
  useEffect(() => {
    if (!imgLoaded || !imgRef.current) return;
    const nw = imgRef.current.naturalWidth;
    const nh = imgRef.current.naturalHeight;
    if (!nw || !nh) return;
    const swap = (imageRotation === 90 || imageRotation === 270);
    const desired = { w: swap ? nh : nw, h: swap ? nw : nh };
    setNaturalSize((curr) => (curr.w === desired.w && curr.h === desired.h) ? curr : desired);
  }, [imageRotation, imgLoaded]);

  // M5c: emit cropRect + imgLoaded to the parent. ManualCropMode
  // uses these to fire its own apply (via electronAPI.jobCropImage)
  // when the operator hits Enter / Space — bypassing CropEditor's
  // internal handleApply since hideOwnChrome is set.
  useEffect(() => {
    if (typeof onCropRectChange === 'function') onCropRectChange(cropRect);
  }, [cropRect, onCropRectChange]);
  useEffect(() => {
    if (typeof onImgLoadedChange === 'function') onImgLoadedChange(imgLoaded);
  }, [imgLoaded, onImgLoadedChange]);

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
      if (source === 'original' && canUseOriginal) {
        await onApplyOriginal(cropRect);
      } else {
        await onApply(cropRect);
      }
    } finally {
      setApplying(false);
    }
  }

  // Apply the crop AND dispatch just this one image as a reprint. The parent
  // owns the sequence (apply → dispatch); `source` is passed so it can pick
  // the right apply path. Mirrors handleApply's applying-state handling.
  //
  // Apply & Send dispatches via the same path as the bundle
  // flow; for jobs with a customer original, customer-mode
  // in-place crops are not reflected in the reprint output —
  // use Original mode for those. See reprintManager.js header.
  async function handleApplyAndSend() {
    if (!cropRect || !imgLoaded) return;
    setApplying(true);
    try {
      await onApplyAndSendReprint(cropRect, source);
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
          // M5c (2026-05-26): when imageRotation is 90/270, the
          // EFFECTIVE image dimensions swap. Store the post-rotation
          // dims as `naturalSize` so all downstream math (canvas
          // layout, crop-rect coords, handle hit-testing) operates
          // in the rotated coordinate space. drawCanvas reuses
          // `imageRotation` to position/rotate the image element
          // itself; the crop math is rotation-agnostic past this
          // setNaturalSize call.
          const nw = e.target.naturalWidth;
          const nh = e.target.naturalHeight;
          const swap = (imageRotation === 90 || imageRotation === 270);
          setNaturalSize({ w: swap ? nh : nw, h: swap ? nw : nh });
          setImgLoaded(true);
        }}
        onError={() => setImgLoaded(false)}
        alt=""
      />

      {/* Header label — suppressed when the parent owns the chrome
          (ManualCropMode's inline CropStage). The standard-drawer
          caller leaves hideOwnChrome at the default false so its
          chrome renders unchanged. */}
      {!hideOwnChrome && (
      <div className="jr-crop-header">
        {sizeOption
          ? `Crop to ${sizeOption.label} — drag corners to resize`
          : 'Crop image — drag corners to resize'}
        {canUseOriginal && (
          <span
            role="radiogroup"
            aria-label="Crop source"
            className="jr-crop-source-toggle"
          >
            <button
              type="button"
              role="radio"
              aria-checked={source === 'customer'}
              className={'jr-crop-source-btn' + (source === 'customer' ? ' is-on' : '')}
              onClick={() => setSource('customer')}
              disabled={applying}
              title="Crop against the customer's printable JPEG"
            >
              Customer crop
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === 'original'}
              className={'jr-crop-source-btn' + (source === 'original' ? ' is-on' : '')}
              onClick={() => setSource('original')}
              disabled={applying}
              title="Crop against the customer's uncropped upload"
            >
              Original
            </button>
          </span>
        )}

        {/* Orientation toggle — flip a non-square size between portrait and
            landscape. Hidden for square sizes (nothing to flip). */}
        {!isSquare && (
          <span
            role="radiogroup"
            aria-label="Crop orientation"
            className="jr-crop-orient-toggle"
          >
            <button
              type="button"
              role="radio"
              aria-checked={orientation === 'portrait'}
              className={'jr-crop-orient-btn' + (orientation === 'portrait' ? ' is-on' : '')}
              onClick={() => setOrientationOverride('portrait')}
              disabled={applying}
              title="Crop a portrait (tall) box"
            >
              Portrait
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={orientation === 'landscape'}
              className={'jr-crop-orient-btn' + (orientation === 'landscape' ? ' is-on' : '')}
              onClick={() => setOrientationOverride('landscape')}
              disabled={applying}
              title="Crop a landscape (wide) box"
            >
              Landscape
            </button>
          </span>
        )}
      </div>
      )}

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

      {/* Buttons — suppressed in hideOwnChrome mode (ManualCropMode
          owns its own Approve/nav chrome). */}
      {!hideOwnChrome && (
      <div className="jr-crop-buttons">
        <button
          onClick={onCancel}
          disabled={applying}
          className="jr-crop-btn jr-crop-btn--cancel"
        >
          Cancel
        </button>

        {/* Single-image reprint — applies the crop then dispatches just this
            image. Hidden when the parent doesn't wire up the handler. */}
        {onApplyAndSendReprint && (
          <button
            onClick={handleApplyAndSend}
            disabled={!cropRect || !imgLoaded || applying}
            className="jr-crop-btn jr-crop-btn--reprint"
            title="Apply this crop and send just this image as a reprint"
          >
            {applying ? 'Applying…' : 'Apply & Send Reprint'}
          </button>
        )}

        <button
          onClick={handleApply}
          disabled={!cropRect || !imgLoaded || applying}
          className="jr-crop-btn jr-crop-btn--apply"
        >
          {applying
            ? 'Applying…'
            : (source === 'original' ? 'Re-Crop from Original' : 'Apply Crop')}
        </button>
      </div>
      )}

      {/* Crop dimensions readout */}
      {!hideOwnChrome && cropRect && imgLoaded && (
        <div className="jr-crop-readout">
          {cropRect.w} × {cropRect.h} px  |  source: {naturalSize.w} × {naturalSize.h} px
          {source === 'original' && ' — customer upload'}
        </div>
      )}
    </div>
  );
}
