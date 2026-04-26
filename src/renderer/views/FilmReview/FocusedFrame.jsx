/**
 * src/renderer/views/FilmReview/FocusedFrame.jsx
 *
 * Fullscreen detail view for one frame (PW-007 Phase 1, Milestone 4d).
 *
 * Opened by clicking (or pressing Enter on) a FrameCell in the RollReview
 * grid. Lets the operator judge orientation properly — the 36-frame grid is
 * great for triage but the 120–150px tiles aren't enough to tell whether a
 * symmetric subject (a bouquet, a pattern, an empty landscape) is actually
 * right-side-up.
 *
 * Image source:
 *   We reuse the 512px JPEG thumbnail, scaled to fill the viewport. That's
 *   blurry at 1500px but more than crisp enough to answer "which way is up?"
 *   — which is the only question this view needs to answer. Lazy full-res
 *   preview generation is an easy follow-up if the blur becomes a problem.
 *
 * Navigation:
 *   `[` / `]` move between frames in the current *filtered* set (so
 *   "only low-confidence frames" flows naturally). Prev/next buttons do the
 *   same. Esc closes. F quick-flags the current frame (same semantics as the
 *   hover-F shortcut on the grid). Flag button opens the shared FlagMenu.
 *   ArrowLeft/ArrowRight rotate the current frame (same as L/R) — operators
 *   asked for arrows because the L/R keys are easy to miss while the hand is
 *   already on the arrow cluster.
 *
 * Key ownership:
 *   We bind a document keydown handler while open. The parent (RollReview)
 *   skips its own F handler whenever this overlay is mounted, so keys aren't
 *   double-handled. When the FlagMenu is open on top of us, we defer to it
 *   (via the `menuOpen` prop) so 1–4 pick flag types instead of moving frames.
 *
 * Props:
 *   frame         — the frame record to display
 *   frames        — the currently-filtered frame array, for prev/next nav
 *   menuOpen      — true while the FlagMenu popover is open on top of us
 *   onClose       — fn()                       — close the overlay
 *   onNavigate    — fn(delta: -1 | +1)         — move to prev/next frame
 *   onQuickFlag   — fn(frameId) => Promise     — hover-F equivalent
 *   onOpenFlagMenu— fn(frame, anchorEl)        — opens the shared FlagMenu
 *   onRotate      — fn(frameId, delta:90|-90|180) — persists manual rotation
 *                   to the TIFF on disk + updates correctRotation for training
 */

import React, { useEffect, useState } from 'react';

function confidenceTone(confidence, hasError) {
  if (hasError) return 'red';
  if (!Number.isFinite(confidence)) return null;
  if (confidence < 0.75) return 'amber';
  return null;
}

export function FocusedFrame({
  frame,
  frames,
  menuOpen,
  onClose,
  onNavigate,
  onQuickFlag,
  onOpenFlagMenu,
  onRotate,
}) {
  const [thumbUrl,    setThumbUrl]    = useState(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  // Reload the thumbnail whenever the focused frame changes. Clearing
  // thumbUrl first avoids the previous frame's image hanging around while
  // the new one loads — nav feels snappier when the image blanks instantly.
  useEffect(() => {
    let cancelled = false;
    setThumbUrl(null);
    setThumbFailed(false);
    (async () => {
      try {
        const url = await window.electronAPI.filmReviewGetThumbnail(frame.frameId);
        if (cancelled) return;
        if (url) setThumbUrl(url);
        else     setThumbFailed(true);
      } catch {
        if (!cancelled) setThumbFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [frame.frameId]);

  // Keyboard. We yield to the FlagMenu when it's open (it binds its own
  // keydown handler that owns 1–4 / Enter / Esc for type picking). Otherwise:
  // Esc closes, arrows navigate, F quick-flags.
  useEffect(() => {
    const onKey = (e) => {
      if (menuOpen) return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      } else if (e.key === '[') {
        e.preventDefault();
        onNavigate?.(-1);
      } else if (e.key === ']') {
        e.preventDefault();
        onNavigate?.(+1);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        onQuickFlag?.(frame.frameId);
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'ArrowRight') {
        e.preventDefault();
        onRotate?.(frame.frameId, 90);
      } else if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowLeft') {
        e.preventDefault();
        onRotate?.(frame.frameId, -90);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [frame, menuOpen, onClose, onNavigate, onQuickFlag, onRotate]);

  const rot        = frame.rotation || {};
  const confidence = typeof rot.confidence === 'number' ? rot.confidence : null;
  const hasError   = !!rot.error;
  const tone       = confidenceTone(confidence, hasError);
  const flags      = Array.isArray(frame.operatorFlags) ? frame.operatorFlags : [];
  const opRotation = typeof rot.operatorRotation === 'number' ? rot.operatorRotation : 0;

  // Cache-bust the thumbnail URL whenever the operator rotation timestamp
  // changes — the on-disk thumb has been regenerated but the file path is
  // the same, so the browser would serve the cached image without this.
  // Appending `?v=<timestamp>` forces the <img> to re-request.
  const cacheBust = rot.operatorRotationAt || '';
  const displayUrl = thumbUrl
    ? (cacheBust ? `${thumbUrl}?v=${encodeURIComponent(cacheBust)}` : thumbUrl)
    : null;

  const idx   = frames.findIndex((f) => f.frameId === frame.frameId);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < frames.length - 1;

  const handleFlagClick = (e) => {
    e.stopPropagation();
    onOpenFlagMenu?.(frame, e.currentTarget);
  };

  return (
    <div className="fr-focus-overlay" role="dialog" aria-modal="true" aria-label={`Frame ${frame.frameIndex + 1}`}>
      <div className="fr-focus-backdrop" onClick={onClose} />

      <header className="fr-focus-chrome">
        <button
          type="button"
          className="fr-chrome__btn"
          onClick={onClose}
          title="Close (Esc)"
        >← Back to grid</button>

        <div className="fr-focus-chrome__title">
          Frame #{frame.frameIndex + 1}
          {idx >= 0 && frames.length > 0 && (
            <span className="fr-focus-chrome__counter"> · {idx + 1} of {frames.length}</span>
          )}
        </div>

        <div className="fr-focus-chrome__meta">
          {hasError ? (
            <span className="fr-focus-pill fr-focus-pill--red" title={rot.error}>
              Rotation failed
            </span>
          ) : confidence != null ? (
            <span className={'fr-focus-pill' + (tone === 'amber' ? ' fr-focus-pill--amber' : '')}>
              Confidence {(confidence * 100).toFixed(0)}%
            </span>
          ) : null}

          {rot.applied && (
            <span className="fr-focus-pill fr-focus-pill--muted" title="Auto-rotated by the model">
              Auto-rotated {typeof rot.predictedAngle === 'number' ? `${rot.predictedAngle}°` : ''}
            </span>
          )}

          {flags.length > 0 && (
            <span className="fr-focus-pill fr-focus-pill--accent" title={`${flags.length} operator flag(s)`}>
              ⚑ {flags.length}
            </span>
          )}
        </div>

        <span className="fr-focus-chrome__spacer" />

        <div className="fr-focus-rotate-group" role="group" aria-label="Rotate frame">
          <button
            type="button"
            className="fr-chrome__btn"
            onClick={() => onRotate?.(frame.frameId, -90)}
            title="Rotate counter-clockwise 90° (L or ←)"
            aria-label="Rotate counter-clockwise"
          >↺ 90°</button>
          <button
            type="button"
            className="fr-chrome__btn"
            onClick={() => onRotate?.(frame.frameId, 90)}
            title="Rotate clockwise 90° (R or →)"
            aria-label="Rotate clockwise"
          >90° ↻</button>
          {opRotation > 0 && (
            <span className="fr-focus-rotate-badge" title="Cumulative operator rotation (training label)">
              {opRotation}°
            </span>
          )}
        </div>

        <button
          type="button"
          className="fr-chrome__btn"
          onClick={handleFlagClick}
          title="Flag this frame (or press F)"
        >
          ⚑ Flag…
        </button>
      </header>

      <div className="fr-focus-stage">
        <button
          type="button"
          className="fr-focus-nav-edge fr-focus-nav-edge--left"
          onClick={() => onNavigate?.(-1)}
          disabled={!hasPrev}
          title="Previous frame ([)"
          aria-label="Previous frame"
        >‹</button>

        {displayUrl ? (
          <img
            className="fr-focus-img"
            src={displayUrl}
            alt=""
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="fr-focus-img-placeholder">
            {thumbFailed ? 'No preview available' : 'Loading preview…'}
          </div>
        )}

        <button
          type="button"
          className="fr-focus-nav-edge fr-focus-nav-edge--right"
          onClick={() => onNavigate?.(+1)}
          disabled={!hasNext}
          title="Next frame (])"
          aria-label="Next frame"
        >›</button>
      </div>

      <footer className="fr-focus-footer">
        <div className="fr-focus-footer__flags">
          {flags.length === 0 ? (
            <span className="fr-focus-footer__flags-empty">No flags on this frame</span>
          ) : (
            flags.map((f, i) => (
              <span key={i} className="fr-focus-flag-pill" title={f.flaggedAt}>
                <strong>{f.type}</strong>
                {f.correctRotation != null && (
                  <span className="fr-focus-flag-pill__rot"> · correct: {f.correctRotation}°</span>
                )}
                {f.note && <span className="fr-focus-flag-pill__note"> — {f.note}</span>}
              </span>
            ))
          )}
        </div>

        <span className="fr-focus-footer__hint">
          <code>[</code>/<code>]</code> navigate · <code>R</code>/<code>→</code> rotate CW · <code>L</code>/<code>←</code> rotate CCW · <code>F</code> quick-flag · <code>Esc</code> close
        </span>
      </footer>
    </div>
  );
}
