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
            <RollCard key={r.rollId} roll={r} onOpen={onOpenRoll} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function RollCard({ roll, onOpen }) {
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
