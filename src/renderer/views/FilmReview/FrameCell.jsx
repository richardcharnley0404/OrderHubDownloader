/**
 * src/renderer/views/FilmReview/FrameCell.jsx
 *
 * Stateless thumbnail cell for the RollReview grid.
 *
 * Derives its visual treatment purely from the frame record — the parent
 * owns all selection/hover/flag-menu state. Three compounding confidence
 * channels per the design brief:
 *   1. Border: amber when confidence < 0.75, red when rotation_error,
 *      none otherwise (confident frames look clean).
 *   2. Corner dot (6px, top-right): always visible, color-coded by bucket.
 *      Green ≥ 0.90, neutral 0.75–0.90, amber < 0.75, red on error.
 *   3. Numeric % in the footer row — shown at regular/comfy density only.
 *      Tight 9×4 grid drops the footer entirely (brief: density wins).
 *
 * Rotation errors get an additional red "Rotation failed" ribbon in the
 * top-left corner so they're triagable at a glance even in tight density.
 *
 * Existing operator_flags render as a small badge bottom-left. The grid
 * only adds flags; removal happens in the FocusedFrame detail view (M4d).
 *
 * Thumbnails are fetched lazily via window.electronAPI.filmReviewGetThumbnail
 * on mount — with 36 frames per roll that's 36 cheap IPC calls, which beats
 * embedding file:// URLs in the record (those fail under Electron's default
 * security config for renderer <img> tags).
 */

import React, { useEffect, useState } from 'react';

// Bucket thresholds kept in sync with frame-metadata-store.js listRollsWithSummary()
// (< 0.75 low-confidence). The regular/high split (0.90) is a UI-only detail.
const CONF_LOW  = 0.75;
const CONF_HIGH = 0.90;

function confidenceBucket(confidence, hasError) {
  if (hasError) return 'error';
  if (!Number.isFinite(confidence)) return 'mid';
  if (confidence >= CONF_HIGH) return 'hi';
  if (confidence <  CONF_LOW)  return 'low';
  return 'mid';
}

export function FrameCell({
  frame,
  density,        // 'tight' | 'regular' | 'comfy'
  isFlashing,     // boolean — true briefly after quick-flag for visual confirmation
  onOpenFlagMenu, // fn(frame, anchorEl)
  onClick,        // fn(frame) — opens detail view (M4d); no-op until then
  onHoverStart,   // fn(frameId) — mouse enter or keyboard focus
  onHoverEnd,     // fn(frameId) — mouse leave or keyboard blur
}) {
  const rot        = frame.rotation || {};
  const confidence = typeof rot.confidence === 'number' ? rot.confidence : null;
  const hasError   = !!rot.error;
  const bucket     = confidenceBucket(confidence, hasError);
  const flags      = Array.isArray(frame.operatorFlags) ? frame.operatorFlags : [];

  // Cell-level modifier for visible border. `mid` bucket stays borderless.
  const modifier =
    hasError ? ' fr-frame-cell--error'
    : (bucket === 'low' ? ' fr-frame-cell--low-conf' : '');

  const [thumbUrl, setThumbUrl] = useState(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  // Cache-bust key. After manual rotation in FocusedFrame the rotate IPC
  // regenerates the thumbnail FILE in place, but the browser still has the
  // old bytes cached for the same file:// URL. Including operatorRotationAt
  // in the effect's dep array forces a re-fetch, and appending it as a query
  // string forces the <img> to reload bytes rather than serving from cache.
  // operatorRotationAt is null until the operator rotates the frame at least
  // once — for un-rotated frames the URL is unchanged, no spurious refetch.
  const rotKey = frame?.rotation?.operatorRotationAt || null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await window.electronAPI.filmReviewGetThumbnail(frame.frameId);
        if (cancelled) return;
        if (url) {
          // Append the rotation timestamp so changes invalidate the browser cache.
          // file:// URLs honour query strings for cache keying purposes.
          const busted = rotKey ? `${url}?v=${encodeURIComponent(rotKey)}` : url;
          setThumbUrl(busted);
          setThumbFailed(false);
        } else {
          setThumbFailed(true);
        }
      } catch {
        if (!cancelled) setThumbFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [frame.frameId, rotKey]);

  const handleFlagClick = (e) => {
    e.stopPropagation();
    onOpenFlagMenu?.(frame, e.currentTarget);
  };

  const handleCellClick = () => {
    onClick?.(frame);
  };

  // Keyboard: Enter opens detail (M4d wires it); F handled at the grid level
  // so hover and keyboard focus both work.
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(frame);
    }
  };

  return (
    <div
      className={
        'fr-frame-cell' + modifier +
        (isFlashing ? ' fr-frame-cell--flash' : '')
      }
      data-frame-id={frame.frameId}
      tabIndex={0}
      role="button"
      title={hasError ? `Rotation error: ${rot.error}` : undefined}
      aria-label={`Frame ${frame.frameIndex + 1}${hasError ? ' — rotation failed' : ''}`}
      onClick={handleCellClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => onHoverStart?.(frame.frameId)}
      onMouseLeave={() => onHoverEnd?.(frame.frameId)}
      onFocus={()      => onHoverStart?.(frame.frameId)}
      onBlur={()       => onHoverEnd?.(frame.frameId)}
    >
      <div className="fr-frame-cell__thumb-wrap">
        {thumbUrl ? (
          <img
            className="fr-frame-cell__thumb"
            src={thumbUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="fr-frame-cell__thumb--placeholder">
            {thumbFailed ? 'no thumbnail' : '...'}
          </div>
        )}

        {hasError && (
          <div className="fr-rot-err-ribbon" title={rot.error}>
            rotation failed
          </div>
        )}

        <span
          className={`fr-conf-dot fr-conf-dot--${bucket}`}
          title={
            hasError
              ? `Rotation error: ${rot.error}`
              : confidence != null
                ? `Confidence ${(confidence * 100).toFixed(0)}%`
                : 'No prediction'
          }
        />

        {flags.length > 0 && (
          <span className="fr-flag-badge" title={`${flags.length} operator flag(s)`}>
            ⚑ {flags.length}
          </span>
        )}

        <div className="fr-frame-cell__hover-actions">
          <button
            type="button"
            className="fr-flag-icon-btn"
            title="Flag this frame (or press F)"
            aria-label="Open flag menu"
            onClick={handleFlagClick}
          >
            ⚑
          </button>
        </div>
      </div>

      {density !== 'tight' && (
        <div className="fr-frame-cell__footer">
          <span className="fr-frame-cell__idx">#{frame.frameIndex + 1}</span>
          {confidence != null && (
            <span
              className={
                'fr-frame-cell__conf' +
                (hasError           ? ' fr-frame-cell__conf--red'
                 : bucket === 'low' ? ' fr-frame-cell__conf--amber'
                                    : '')
              }
            >
              {(confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}
