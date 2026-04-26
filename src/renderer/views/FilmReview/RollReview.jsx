/**
 * src/renderer/views/FilmReview/RollReview.jsx
 *
 * Second-stage view — one open roll. Renders the stats header, filter
 * chip row, and the 36-frame grid. Owns the filter / hover / flash /
 * flag-menu state; FrameCell is stateless by contract.
 *
 * Data flow:
 *   - Mount: fetch full roll (summary + frames[]) via filmReviewGetRoll.
 *   - Flag applied (quick or menu): patch the affected frame in local state
 *     optimistically from the IPC return value; no full refetch. Keeps
 *     interaction snappy and avoids a flicker on the 36-frame grid.
 *   - Mark reviewed: call IPC, then onBack() — parent's list view will
 *     refresh on its own via refreshKey on return.
 *
 * Keyboard:
 *   - F while hovering / focused on a frame → quick-flag as 'rotation'.
 *     The hover element tracks mouseenter/mouseleave; keyboard focus
 *     (tabbing through cells) counts as hover for this purpose because
 *     the design brief treats hover + F as "the" quick path.
 *   - Flag menu owns its own keys (1–4, Enter, Esc) once open.
 *
 * Filters (from the brief):
 *   all           — every frame
 *   auto_rotated  — rotation.applied === true
 *   low_conf      — confidence < 0.75 AND no error
 *   errors        — rotation.error set
 *   flagged       — operatorFlags.length > 0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FrameCell }    from './FrameCell.jsx';
import { FlagMenu }     from './FlagMenu.jsx';
import { FocusedFrame } from './FocusedFrame.jsx';

const LOW_CONF = 0.75;

const FILTERS = [
  { key: 'all',          label: 'All'           },
  { key: 'auto_rotated', label: 'Auto-rotated'  },
  { key: 'low_conf',     label: 'Low confidence', tone: 'amber' },
  { key: 'errors',       label: 'Rotation errors', tone: 'red'  },
  { key: 'flagged',      label: 'Flagged'       },
];

function matchesFilter(frame, filter) {
  const rot = frame.rotation || {};
  const flags = Array.isArray(frame.operatorFlags) ? frame.operatorFlags : [];
  if (filter === 'all')          return true;
  if (filter === 'auto_rotated') return rot.applied === true;
  if (filter === 'low_conf')     return !rot.error && typeof rot.confidence === 'number' && rot.confidence < LOW_CONF;
  if (filter === 'errors')       return !!rot.error;
  if (filter === 'flagged')      return flags.length > 0;
  return true;
}

function countFor(frames, filter) {
  return frames.reduce((n, f) => n + (matchesFilter(f, filter) ? 1 : 0), 0);
}

export function RollReview({ rollId, tweaks, onBack }) {
  const [roll,         setRoll]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [filter,       setFilter]       = useState('all');
  const [hoverFrame,   setHoverFrame]   = useState(null); // frameId
  const [flashFrame,   setFlashFrame]   = useState(null); // frameId, clears after animation
  const [flagMenu,     setFlagMenu]     = useState(null); // { frame, anchorRect }
  const [focusedFrameId, setFocusedFrameId] = useState(null); // frameId or null
  // M7-6: Manual-mode upload gating. pendingRotations counts in-flight
  // rotate-frame promises so the Approve & Upload button can be disabled
  // until disk writes have settled — otherwise a rapid R/L spam followed
  // by an immediate Approve would race the upload against the last rotation.
  const [pendingRotations, setPendingRotations] = useState(0);
  const [uploading,        setUploading]        = useState(false);
  const [uploadError,      setUploadError]      = useState(null);
  const flashTimer = useRef(null);
  // Serializes rapid-fire rotate-frame IPC calls. Without this, hitting R
  // four times quickly would fire four concurrent sharp rotations on the
  // same TIFF — guaranteed race. The chain ensures each rotation completes
  // (and the frame record is patched) before the next one starts.
  const rotateChainRef = useRef(Promise.resolve());

  // Load the roll on mount / when rollId changes. Flag mutations patch the
  // frames array in-place so we don't refetch on every action.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await window.electronAPI.filmReviewGetRoll(rollId);
        if (cancelled) return;
        setRoll(r);
        setError(r ? null : 'Roll not found');
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load roll');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rollId]);

  // Merge an updated frame record back into the roll. Used after flag ops.
  const patchFrame = useCallback((updated) => {
    if (!updated) return;
    setRoll((prev) => {
      if (!prev) return prev;
      const frames = prev.frames.map((f) =>
        f.frameId === updated.frameId ? { ...f, ...updated } : f
      );
      // Re-derive flaggedCount because the summary header reads from roll.
      const flaggedCount = frames.reduce(
        (n, f) => n + (Array.isArray(f.operatorFlags) && f.operatorFlags.length > 0 ? 1 : 0), 0
      );
      return { ...prev, frames, flaggedCount };
    });
  }, []);

  // Trigger the flash animation for visual confirmation of quick-flag.
  const flashOnce = useCallback((frameId) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashFrame(frameId);
    flashTimer.current = setTimeout(() => setFlashFrame(null), 450);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // Manual rotation (M4e): R / L in FocusedFrame, or the rotate buttons in
  // its chrome. Serialized via rotateChainRef so a hammering user can't
  // race the TIFF rotate against itself on disk. Every call optimistically
  // patches the frame record with the updated operatorRotation + auto-flag,
  // and the FocusedFrame img reloads via operatorRotationAt cache-bust.
  const rotateFrame = useCallback((frameId, delta) => {
    // M7-6: bump pendingRotations around the chained promise so the
    // Approve & Upload button knows when disk writes are still in flight.
    // Increment is synchronous so the button gates immediately on the
    // first keypress; decrement happens in the chained .then() when the
    // IPC has resolved (success or failure both unblock).
    setPendingRotations((n) => n + 1);
    const next = rotateChainRef.current.then(async () => {
      try {
        const updated = await window.electronAPI.filmReviewRotateFrame(frameId, delta);
        if (updated) {
          patchFrame(updated);
          flashOnce(frameId);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[filmReview] rotate-frame failed', err);
      } finally {
        setPendingRotations((n) => Math.max(0, n - 1));
      }
    });
    rotateChainRef.current = next;
    return next;
  }, [patchFrame, flashOnce]);

  // Quick-flag (F key, hovered frame): add a 'rotation' flag with no note.
  const quickFlag = useCallback(async (frameId) => {
    try {
      const updated = await window.electronAPI.filmReviewFlagFrame(frameId, { type: 'rotation' });
      if (updated) {
        patchFrame(updated);
        flashOnce(frameId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[filmReview] quick-flag failed', err);
    }
  }, [patchFrame, flashOnce]);

  // Open flag menu for a specific frame from the flag-icon button.
  const openFlagMenu = useCallback((frame, anchorEl) => {
    const rect = anchorEl?.getBoundingClientRect() ||
      { top: window.innerHeight / 2, bottom: window.innerHeight / 2, left: window.innerWidth / 2 };
    setFlagMenu({ frame, anchorRect: rect });
  }, []);

  const submitFlagMenu = useCallback(async ({ type, note, correctRotation }) => {
    const frame = flagMenu?.frame;
    setFlagMenu(null);
    if (!frame) return;
    try {
      const updated = await window.electronAPI.filmReviewFlagFrame(
        frame.frameId,
        { type, note, correctRotation }
      );
      if (updated) {
        patchFrame(updated);
        flashOnce(frame.frameId);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[filmReview] flag submit failed', err);
    }
  }, [flagMenu, patchFrame, flashOnce]);

  // Document-level F handler. Scoped to this view by keying on hoverFrame
  // — no hover = no-op. We don't fire if the flag menu is open (it owns
  // its own keys), the FocusedFrame overlay is open (IT owns F while open),
  // or the user is in any input/textarea.
  useEffect(() => {
    const onKey = (e) => {
      if (flagMenu) return;
      if (focusedFrameId) return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if ((e.key === 'f' || e.key === 'F') && hoverFrame) {
        e.preventDefault();
        quickFlag(hoverFrame);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hoverFrame, quickFlag, flagMenu, focusedFrameId]);

  // Filter counts are derived per render — cheap for 36 items, saves keeping
  // a parallel cache in sync with patchFrame.
  const counts = useMemo(() => {
    if (!roll?.frames) return {};
    const out = {};
    for (const f of FILTERS) out[f.key] = countFor(roll.frames, f.key);
    return out;
  }, [roll]);

  const filteredFrames = useMemo(() => {
    if (!roll?.frames) return [];
    return roll.frames.filter((f) => matchesFilter(f, filter));
  }, [roll, filter]);

  const onMarkReviewed = useCallback(async () => {
    try {
      await window.electronAPI.filmReviewMarkRollReviewed(rollId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[filmReview] mark-reviewed failed', err);
    } finally {
      onBack?.();
    }
  }, [rollId, onBack]);

  // M7-6 / M9: Manual-mode approval. Fire the approve-roll IPC and
  // immediately pop back to the rolls list — the operator shouldn't have
  // to sit on a "Uploading…" button waiting for S3. The list view picks up
  // the in-flight roll via the existing roll-processed event stream and
  // flips its card through Uploading → Uploaded (or Upload failed, in
  // which case the operator can click in to retry).
  const onApproveAndUpload = useCallback(() => {
    setUploadError(null);
    // Fire-and-forget: the IPC keeps running in main even after we
    // navigate away. Stamp the roll record to 'uploading' optimistically
    // so the list card shows the right badge before the IPC's first
    // updateRoll lands.
    Promise.resolve()
      .then(() => window.electronAPI.filmReviewApproveRoll(rollId))
      .catch((err) => {
        // Failures are surfaced via the roll's 'failed' uploadStatus
        // badge in the list — nothing to do here besides log.
        // eslint-disable-next-line no-console
        console.warn('[filmReview] approve-roll IPC rejected', err);
      });
    onBack?.();
  }, [rollId, onBack]);

  const onOpenFolder = useCallback(async () => {
    try {
      await window.electronAPI.filmReviewOpenFolder(rollId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[filmReview] open-folder failed', err);
    }
  }, [rollId]);

  // Prev/next navigation for FocusedFrame. Moves within the currently
  // *filtered* frames, so "only low-confidence" lets the operator cycle
  // through exactly the hard cases. No wrap-around — feels wrong if you're
  // trying to check "is there anything after frame 36?" and land back at 1.
  const navigateFocused = useCallback((delta) => {
    if (!focusedFrameId) return;
    const idx = filteredFrames.findIndex((f) => f.frameId === focusedFrameId);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= filteredFrames.length) return;
    setFocusedFrameId(filteredFrames[next].frameId);
  }, [focusedFrameId, filteredFrames]);

  // If the focused frame falls out of the filtered set (e.g. operator changed
  // the filter and the focused frame no longer matches), close the overlay
  // rather than leaving it pointing at a stale id.
  useEffect(() => {
    if (!focusedFrameId) return;
    const stillVisible = filteredFrames.some((f) => f.frameId === focusedFrameId);
    if (!stillVisible) setFocusedFrameId(null);
  }, [filteredFrames, focusedFrameId]);

  if (loading) {
    return <div className="fr-body"><div className="fr-empty"><div className="fr-empty__title">Loading roll…</div></div></div>;
  }
  if (error || !roll) {
    return (
      <div className="fr-body">
        <div className="fr-empty">
          <div className="fr-empty__title">Couldn't load roll</div>
          <div className="fr-empty__hint">{error || 'Unknown error'}</div>
        </div>
      </div>
    );
  }

  const density = tweaks?.density || 'regular';

  return (
    <div className="fr-body">
      <div className="fr-roll-stats">
        <div className="fr-roll-stats__item">
          <div className="fr-roll-stats__label">Frames</div>
          <div className="fr-roll-stats__value">{roll.frameCount}</div>
        </div>
        <div className="fr-roll-stats__item fr-roll-stats__item--muted">
          <div className="fr-roll-stats__label">Auto-rotated</div>
          <div className="fr-roll-stats__value">{roll.autoRotatedCount}</div>
        </div>
        {roll.lowConfidenceCount > 0 && (
          <div className="fr-roll-stats__item fr-roll-stats__item--amber">
            <div className="fr-roll-stats__label">Low confidence</div>
            <div className="fr-roll-stats__value">{roll.lowConfidenceCount}</div>
          </div>
        )}
        {roll.rotationErrorCount > 0 && (
          <div className="fr-roll-stats__item fr-roll-stats__item--red">
            <div className="fr-roll-stats__label">Rotation errors</div>
            <div className="fr-roll-stats__value">{roll.rotationErrorCount}</div>
          </div>
        )}
        <div className="fr-roll-stats__item">
          <div className="fr-roll-stats__label">Flagged</div>
          <div className="fr-roll-stats__value">{roll.flaggedCount}</div>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {uploadError && (
            <span
              className="fr-roll-stats__upload-error"
              title={uploadError}
              style={{
                color: 'var(--fr-danger, #d04848)',
                fontSize: 12,
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {uploadError}
            </span>
          )}
          <button
            type="button"
            className="fr-chrome__btn"
            onClick={onOpenFolder}
            title="Open the roll's source folder"
          >Open folder</button>
          {(() => {
            // M7-6 / M9: Button modes driven by roll.uploadStatus.
            //   undefined  → Off/Auto mode (or pre-M7 record): plain Mark reviewed.
            //   'pending'  → Manual/Smart-flagged, awaiting approval: Approve & Upload.
            //   'uploading'→ Approve was clicked, S3 in flight: disabled Uploading…
            //                (operator may have navigated away and back during upload).
            //   'failed'   → Prior upload failed: Retry upload.
            //   'uploaded' shouldn't render here (M7-7 filters it from the list),
            //              but we fall through to the reviewed-disabled state.
            const us = roll.uploadStatus;
            const rotating = pendingRotations > 0;
            const isInFlight = uploading || us === 'uploading';

            if (us === 'pending' || us === 'failed' || us === 'uploading') {
              const label = isInFlight
                ? 'Uploading…'
                : us === 'failed'
                  ? 'Retry upload'
                  : 'Approve & Upload';
              const tip = rotating
                ? 'Waiting for rotation to finish…'
                : isInFlight
                  ? 'Uploading roll to S3…'
                  : us === 'failed'
                    ? 'Retry the S3 upload'
                    : 'Approve this roll and upload it to S3';
              return (
                <button
                  type="button"
                  className="fr-chrome__btn fr-chrome__btn--primary"
                  onClick={onApproveAndUpload}
                  disabled={rotating || isInFlight}
                  title={tip}
                >
                  {label}
                </button>
              );
            }

            // Off / Auto mode (or already-reviewed): legacy behaviour.
            return (
              <button
                type="button"
                className="fr-chrome__btn fr-chrome__btn--primary"
                onClick={onMarkReviewed}
                disabled={roll.status === 'reviewed' || rotating}
                title={rotating ? 'Waiting for rotation to finish…' : undefined}
              >
                {roll.status === 'reviewed' ? 'Reviewed' : 'Mark reviewed'}
              </button>
            );
          })()}
        </div>
      </div>

      <div className="fr-chip-row">
        {FILTERS.map((f) => {
          const n = counts[f.key] ?? 0;
          const isActive = filter === f.key;
          const toneCls =
            f.tone && !isActive && n > 0 ? ` fr-chip--${f.tone}` : '';
          return (
            <button
              key={f.key}
              type="button"
              className={'fr-chip' + (isActive ? ' is-active' : '') + toneCls}
              onClick={() => setFilter(f.key)}
              disabled={n === 0 && f.key !== 'all'}
            >
              {f.label}
              <span className="fr-chip__count">{n}</span>
            </button>
          );
        })}
        {tweaks?.showKbdHint !== false && (
          <div className="fr-kbd-hint">
            Hover a frame &middot; <code>F</code> quick-flag &middot; click <span style={{fontSize: 13}}>⚑</span> for menu
          </div>
        )}
      </div>

      {filteredFrames.length === 0 ? (
        <div className="fr-empty">
          <div className="fr-empty__title">No frames in this filter</div>
        </div>
      ) : (
        <div
          className={`fr-frame-grid fr-frame-grid--${density}`}
          onMouseLeave={() => setHoverFrame(null)}
        >
          {filteredFrames.map((frame) => (
            <FrameCell
              key={frame.frameId}
              frame={frame}
              density={density}
              isFlashing={flashFrame === frame.frameId}
              onOpenFlagMenu={openFlagMenu}
              onClick={() => setFocusedFrameId(frame.frameId)}
              onHoverStart={(id) => setHoverFrame(id)}
              onHoverEnd={(id) => setHoverFrame((prev) => prev === id ? null : prev)}
            />
          ))}
        </div>
      )}

      {focusedFrameId && (() => {
        // Re-derive the focused frame from roll.frames on every render so the
        // overlay reflects optimistic flag patches immediately (parent-owned
        // state — FocusedFrame itself is pass-through).
        const focused = roll.frames.find((f) => f.frameId === focusedFrameId);
        if (!focused) return null;
        return (
          <FocusedFrame
            frame={focused}
            frames={filteredFrames}
            menuOpen={!!flagMenu}
            onClose={() => setFocusedFrameId(null)}
            onNavigate={navigateFocused}
            onQuickFlag={quickFlag}
            onOpenFlagMenu={openFlagMenu}
            onRotate={rotateFrame}
          />
        );
      })()}

      {flagMenu && (
        <FlagMenu
          frame={flagMenu.frame}
          anchorRect={flagMenu.anchorRect}
          onSubmit={submitFlagMenu}
          onClose={() => setFlagMenu(null)}
        />
      )}
    </div>
  );
}
