/**
 * src/renderer/views/FilmReview/RollList.jsx
 *
 * First-stage navigation for the Film Review Panel — the rolls index.
 *
 * Fetches roll summaries from window.electronAPI.filmReviewListRolls() on
 * mount (and whenever `refreshKey` changes — the parent bumps it when Mode 2
 * finishes processing a new roll). Renders a filterable, searchable grid of
 * roll cards. Clicking a card calls `onOpenRoll(rollId)` which transitions
 * the parent to the RollReview view.
 *
 * Filter buttons are not exhaustive — only the filters with at least one
 * matching roll are enabled; the rest show their count as 0 but stay
 * clickable (operators may want to confirm "reviewed is empty"). Search
 * is a plain case-insensitive substring match against rollId — cheap and
 * obvious, which is what the design brief asks for.
 *
 * Counts are displayed per the design brief:
 *   frameCount   — always black
 *   autoRotated  — muted (informational, not actionable)
 *   lowConf      — amber (worth a look)
 *   rotationErr  — red (must triage)
 *   flagged      — default ink (operator has already acted)
 *
 * Props:
 *   refreshKey   — number; changes force a re-fetch
 *   onOpenRoll   — fn(rollId) called on card click / Enter
 */

import React, { useEffect, useMemo, useState } from 'react';

const FILTERS = [
  { key: 'ready',    label: 'Ready to review' },
  { key: 'reviewed', label: 'Reviewed' },
  { key: 'all',      label: 'All' },
];

function matchesFilter(roll, filter) {
  if (filter === 'all') return true;
  if (filter === 'ready')    return roll.status === 'ready_for_review';
  if (filter === 'reviewed') return roll.status === 'reviewed';
  return true;
}

// Humanize an ISO timestamp into a short relative label. Rolls are usually
// minutes-to-days old, so this covers the common cases; anything older falls
// back to the date. Keeping this local to the file — no shared date-fns
// dependency for one helper.
function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const deltaMs = Date.now() - then;
  const min  = Math.round(deltaMs / 60000);
  const hr   = Math.round(deltaMs / 3600000);
  const day  = Math.round(deltaMs / 86400000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  if (hr  < 24)  return `${hr}h ago`;
  if (day <  7)  return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function RollList({ refreshKey, onOpenRoll }) {
  const [rolls,   setRolls]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [filter,  setFilter]  = useState('ready');
  const [query,   setQuery]   = useState('');

  // Fetch rolls. Two triggers: mount (refreshKey starts at 0) and every
  // increment of refreshKey from the parent (new roll landed).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await window.electronAPI.filmReviewListRolls();
        if (!cancelled) {
          setRolls(Array.isArray(list) ? list : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load rolls');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rolls.filter((r) => {
      if (!matchesFilter(r, filter)) return false;
      if (q && !String(r.rollId).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rolls, filter, query]);

  return (
    <div className="fr-body">
      <div className="fr-rolls-toolbar">
        <div className="fr-filter-group" role="tablist" aria-label="Roll status filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={
                'fr-filter-group__btn' + (filter === f.key ? ' is-active' : '')
              }
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="fr-search"
          placeholder="Search by roll ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="fr-rolls-toolbar__count">
          {filtered.length} of {rolls.length}
        </div>
      </div>

      {loading && rolls.length === 0 && (
        <div className="fr-empty">
          <div className="fr-empty__title">Loading rolls…</div>
        </div>
      )}

      {!loading && error && (
        <div className="fr-empty">
          <div className="fr-empty__title">Couldn't load rolls</div>
          <div className="fr-empty__hint">{error}</div>
        </div>
      )}

      {!loading && !error && rolls.length === 0 && (
        <div className="fr-empty">
          <div className="fr-empty__title">No rolls processed yet</div>
          <div className="fr-empty__hint">
            Rolls appear here after Mode 2 runs the orientation model over a
            scanned folder. Check your Film Scans settings if this looks wrong.
          </div>
        </div>
      )}

      {!loading && !error && rolls.length > 0 && filtered.length === 0 && (
        <div className="fr-empty">
          <div className="fr-empty__title">No rolls match</div>
          <div className="fr-empty__hint">
            Try a different filter or clear your search.
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="fr-roll-grid">
          {filtered.map((r) => (
            <RollCard
              key={r.rollId}
              roll={r}
              onOpen={onOpenRoll}
              onDeleted={() => setRolls((prev) => prev.filter((x) => x.rollId !== r.rollId))}
              onApproved={() => setRolls((prev) => prev.map((x) =>
                x.rollId === r.rollId
                  ? { ...x, status: 'reviewed', uploadStatus: 'uploading' }
                  : x
              ))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function RollCard({ roll, onOpen, onDeleted, onApproved }) {
  const [deleting,  setDeleting]  = useState(false);
  const [approving, setApproving] = useState(false);
  const isReviewed = roll.status === 'reviewed';

  // M8-3: provisional rolls (detected/processing) have no frames yet — they
  // exist only because folder-watch wrote a placeholder record so the
  // operator can see their scan is queued. The card is inert (no click,
  // no hover lift) and shows a status pill explaining the state.
  const isProvisional = !!roll.processingStatus;
  const provisionalLabel =
    roll.processingStatus === 'processing' ? 'Processing'
    : roll.processingStatus === 'detected' ? 'Watching' : null;
  const provisionalClass =
    roll.processingStatus === 'processing'
      ? 'fr-roll-card__status fr-roll-card__status--processing'
      : 'fr-roll-card__status fr-roll-card__status--watching';

  const statusLabel = isReviewed ? 'Reviewed' : 'Ready';
  const statusClass = isReviewed
    ? 'fr-roll-card__status fr-roll-card__status--reviewed'
    : 'fr-roll-card__status fr-roll-card__status--ready';

  // M7-7: Upload status badge. Only Manual-mode rolls carry an uploadStatus —
  // for Auto/Off rolls the field is undefined and we render nothing extra.
  // 'uploading' is a transient state surfaced if the operator opens the panel
  // mid-upload; 'uploaded' rolls usually fall out of the "Ready" filter via
  // status='reviewed' so this is mostly visible under the "All" filter.
  const us = roll.uploadStatus;
  const uploadBadge =
    us === 'pending'   ? { label: 'Awaiting approval', cls: 'fr-roll-card__upload fr-roll-card__upload--pending' } :
    us === 'uploading' ? { label: 'Uploading…',         cls: 'fr-roll-card__upload fr-roll-card__upload--uploading' } :
    us === 'failed'    ? { label: 'Upload failed',      cls: 'fr-roll-card__upload fr-roll-card__upload--failed' } :
    us === 'uploaded'  ? { label: 'Uploaded',           cls: 'fr-roll-card__upload fr-roll-card__upload--uploaded' } :
    null;

  const onKeyDown = (e) => {
    if (isProvisional) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(roll.rollId);
    }
  };

  // Delete-roll affordance. Disabled for already-uploaded rolls (the IPC
  // also refuses, but disabling at the UI is friendlier). Confirms via
  // window.confirm — matches the rest of the panel's lightweight tone
  // and avoids pulling in a modal component for one button.
  const isUploaded = us === 'uploaded';
  const isUploading = us === 'uploading';
  const canDelete = !isProvisional && !isUploaded && !isUploading && !deleting;
  const onDeleteClick = async (e) => {
    // Stop the click from bubbling to the card's onClick (which opens the
    // roll). Same for keydown so Space/Enter on the button doesn't open.
    e.stopPropagation();
    if (!canDelete) return;
    const ok = window.confirm(
      `Delete roll ${roll.rollId}?\n\n` +
      `The local files will be moved aside (renamed __DELETED__) and this roll will not be uploaded to S3. ` +
      `You can recover the files manually from the storage folder if needed.`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await window.electronAPI.filmReviewDeleteRoll(roll.rollId);
      if (!res || !res.ok) {
        window.alert(`Couldn't delete roll: ${res?.error || 'unknown error'}`);
        setDeleting(false);
        return;
      }
      if (res.warning) {
        // Soft success — metadata was scrubbed but the folder rename failed.
        window.alert(res.warning);
      }
      // The roll-processed event will also re-fetch, but optimistically
      // remove from the local list so the card disappears immediately.
      onDeleted?.();
    } catch (err) {
      window.alert(`Couldn't delete roll: ${err?.message || String(err)}`);
      setDeleting(false);
    }
  };
  const onDeleteKeyDown = (e) => {
    // Prevent Space/Enter on the button from triggering the card's keydown.
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
    }
  };

  // Approve & Upload affordance — only shown when the roll is awaiting
  // approval (Manual / Smart-flagged rolls). Lets the operator skip the
  // grid view entirely when they trust the roll on sight. Confirms first
  // since the action commits the upload to S3 without per-frame review.
  // The IPC awaits the full S3 upload, but `onApproved` updates local
  // state immediately so the card reflects 'uploading' before the
  // roll-processed event arrives.
  const canApprove = !isProvisional && us === 'pending' && !approving && !deleting;
  const onApproveClick = async (e) => {
    e.stopPropagation();
    if (!canApprove) return;
    const ok = window.confirm(
      `Approve and upload roll ${roll.rollId}?\n\n` +
      `${roll.frameCount} frame${roll.frameCount === 1 ? '' : 's'} will be uploaded to S3 without further per-frame review.`
    );
    if (!ok) return;
    setApproving(true);
    // Reflect the new state immediately — the IPC blocks until S3 is done,
    // but we don't want the operator to wonder if the click registered.
    onApproved?.();
    try {
      const res = await window.electronAPI.filmReviewApproveRoll(roll.rollId);
      if (!res || !res.ok) {
        window.alert(`Couldn't approve roll: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      window.alert(`Couldn't approve roll: ${err?.message || String(err)}`);
    } finally {
      // The roll-processed event the main side fires will refresh us into
      // 'uploaded' (or 'failed') state; clearing local approving state lets
      // that re-render happen cleanly.
      setApproving(false);
    }
  };
  const onApproveKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
    }
  };

  // Non-clickable provisional cards: no role=button, no tabIndex, no onClick.
  // Keeps assistive tech from announcing them as actionable, and the cursor
  // styling in CSS makes the inert state obvious to mouse users.
  const cardProps = isProvisional
    ? { className: 'fr-roll-card fr-roll-card--inert', 'aria-disabled': true }
    : {
        className: 'fr-roll-card',
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(roll.rollId),
        onKeyDown,
      };

  return (
    <div {...cardProps}>
      <div className="fr-roll-card__header">
        <span className="fr-roll-card__id">{roll.rollId}</span>
        <span className="fr-roll-card__time">
          {formatRelative(isProvisional ? roll.detectedAt || roll.lastSeenAt : roll.lastSeenAt)}
        </span>
      </div>

      <div className="fr-roll-card__status-row">
        {isProvisional ? (
          <span className={provisionalClass}>{provisionalLabel}</span>
        ) : (
          <>
            <span className={statusClass}>{statusLabel}</span>
            {uploadBadge && (
              <span
                className={uploadBadge.cls}
                title={us === 'failed' && roll.uploadError ? roll.uploadError : undefined}
              >
                {uploadBadge.label}
              </span>
            )}
            <span className="fr-roll-card__actions">
              {us === 'pending' && (
                <button
                  type="button"
                  className="fr-roll-card__approve"
                  onClick={onApproveClick}
                  onKeyDown={onApproveKeyDown}
                  disabled={!canApprove}
                  title={`Approve roll and upload ${roll.frameCount} frame${roll.frameCount === 1 ? '' : 's'} to S3`}
                  aria-label={`Approve and upload roll ${roll.rollId}`}
                >
                  {approving ? 'Approving…' : 'Approve & Upload'}
                </button>
              )}
              <button
                type="button"
                className="fr-roll-card__delete"
                onClick={onDeleteClick}
                onKeyDown={onDeleteKeyDown}
                disabled={!canDelete}
                title={
                  isUploaded ? 'Already uploaded to S3 — local copy auto-cleaned'
                  : isUploading ? 'Upload in progress — wait for it to finish'
                  : 'Delete this roll (will not upload to S3)'
                }
                aria-label={`Delete roll ${roll.rollId}`}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </span>
          </>
        )}
      </div>

      {isProvisional ? (
        <div className="fr-roll-card__hint">
          {roll.processingStatus === 'processing'
            ? 'Rotating frames and generating thumbnails…'
            : 'Waiting for the watchguard timer before processing.'}
        </div>
      ) : (
        <div className="fr-roll-card__stats">
          <Stat label="frames"       value={roll.frameCount} />
          <Stat label="auto-rotated" value={roll.autoRotatedCount} tone="muted" />
          {roll.lowConfidenceCount > 0 && (
            <Stat label="low conf"   value={roll.lowConfidenceCount} tone="amber" />
          )}
          {roll.rotationErrorCount > 0 && (
            <Stat label="rot errors" value={roll.rotationErrorCount} tone="red" />
          )}
          {roll.flaggedCount > 0 && (
            <Stat label="flagged"    value={roll.flaggedCount} />
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const cls =
    'fr-roll-card__stat' + (tone ? ` fr-roll-card__stat--${tone}` : '');
  return (
    <span className={cls}>
      <span className="fr-roll-card__stat-value">{value}</span>
      <span>{label}</span>
    </span>
  );
}
