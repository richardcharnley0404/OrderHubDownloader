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

// ── Pipeline status strip ──────────────────────────────────────────────────
//
// At-a-glance view of what the film-scan pipeline is doing in the background,
// computed entirely from the rolls list this panel already loads. The pipeline
// is serial (one roll at a time), so the operator's complaint — "scans take
// ages to show up" — is really a queue-depth problem; surfacing the queue makes
// it visible. Refreshes on the same roll-processed events that drive the cards.

// The single pipeline stage a roll is currently in. Order matters: provisional
// states (folder detected, no frames yet) take precedence over upload state.
// Returns null for rolls that are done (uploaded / reviewed / plain ready) —
// those aren't "in the pipeline" and don't belong in the strip.
function rollStage(r) {
  if (r.processingStatus === 'detected')   return 'watching';
  if (r.processingStatus === 'processing') return 'processing';
  if (r.processingStatus === 'converting') return 'converting';
  // M4 (2026-07-03): Perfectly Clear auto-apply stage. Sits alongside
  // 'converting' as a rotation/thumbnails-complete-but-not-yet-uploaded
  // sub-state so the pipeline card + counts stay honest.
  if (r.processingStatus === 'enhancing')  return 'enhancing';
  if (r.uploadStatus === 'uploading')      return 'uploading';
  if (r.uploadStatus === 'pending')        return 'pending';
  if (r.uploadStatus === 'failed')         return 'failed';
  return null;
}

const PIPELINE_STAGES = [
  { key: 'watching',   label: 'Watching' },
  { key: 'processing', label: 'Processing' },
  { key: 'converting', label: 'Converting' },
  { key: 'enhancing',  label: 'Enhancing' },
  { key: 'uploading',  label: 'Uploading' },
  { key: 'pending',    label: 'Awaiting approval' },
  { key: 'failed',     label: 'Failed' },
];

function PipelineStatus({ rolls }) {
  const { counts, active } = useMemo(() => {
    const counts = { watching: 0, processing: 0, converting: 0, enhancing: 0, uploading: 0, pending: 0, failed: 0 };
    let active = null;
    for (const r of rolls) {
      const stage = rollStage(r);
      if (!stage) continue;
      counts[stage] += 1;
      // Serial pipeline → at most one roll is actively in-flight at a time.
      if (!active && (stage === 'processing' || stage === 'converting' || stage === 'enhancing' || stage === 'uploading')) {
        active = { id: r.rollId, stage };
      }
    }
    return { counts, active };
  }, [rolls]);

  const activeCount  = counts.processing + counts.converting + counts.enhancing + counts.uploading;
  const waiting      = counts.watching + counts.pending;
  const outstanding  = activeCount + waiting;
  const total        = outstanding + counts.failed;
  // Stay out of the way when there's nothing waiting, in-flight, or failed.
  if (total === 0) return null;

  const shownChips = PIPELINE_STAGES.filter((s) => counts[s.key] > 0);

  let lead;
  if (activeCount > 0) {
    lead = <span>Working through the queue — <strong>{outstanding}</strong> roll{outstanding === 1 ? '' : 's'} waiting or in progress</span>;
  } else if (waiting > 0) {
    lead = <span><strong>{waiting}</strong> roll{waiting === 1 ? '' : 's'} waiting</span>;
  } else {
    lead = <span>Pipeline idle — <strong>{counts.failed}</strong> roll{counts.failed === 1 ? '' : 's'} need attention</span>;
  }

  return (
    <div className="fr-pipeline" role="status" aria-live="polite">
      <div className="fr-pipeline__lead">
        <span className={'fr-pipeline__pulse' + (activeCount > 0 ? ' is-active' : '')} aria-hidden="true" />
        {lead}
      </div>

      <div className="fr-pipeline__chips">
        {shownChips.map((s) => (
          <span key={s.key} className={`fr-pipeline__chip fr-pipeline__chip--${s.key}`}>
            <span className="fr-pipeline__chip-value">{counts[s.key]}</span>
            <span className="fr-pipeline__chip-label">{s.label}</span>
          </span>
        ))}
      </div>

      {active && (
        <div className="fr-pipeline__now" title="The pipeline processes one roll at a time">
          {active.stage === 'uploading' ? 'Uploading'
            : active.stage === 'converting' ? 'Converting'
            : active.stage === 'enhancing' ? 'Enhancing'
            : 'Processing'} <strong>{active.id}</strong>
        </div>
      )}
    </div>
  );
}

// ── Pipeline timing breakdown (v2) ─────────────────────────────────────────
//
// "Where the time goes" — averages each pipeline stage's duration across the
// most recent completed rolls (from the per-roll `timeline` stamped by
// folder-watch-service) and highlights the slowest stage. This is the
// bottleneck finder: it tells the operator whether the lag is the watchguard
// wait (config), the AI rotation (CPU), or the S3 upload (network).

function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 1)  return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

const TIMING_STAGES = [
  { key: 'wait',    label: 'Watchguard wait', from: 'detectedAt',       to: 'stableAt'     },
  { key: 'copy',    label: 'Copy',            from: 'stableAt',         to: 'copiedAt'     },
  { key: 'rotate',  label: 'AI rotate',       from: 'copiedAt',         to: 'rotatedAt'    },
  { key: 'convert', label: 'TIFF→JPEG',       from: 'convertStartedAt', to: 'convertedAt'  },
  { key: 'upload',  label: 'S3 upload',       from: 'uploadStartedAt',  to: 'uploadedAt'   },
];

function PipelineTiming({ rolls }) {
  const { stages, sampleCount } = useMemo(() => {
    // Rolls are sorted lastSeenAt-desc, so the first 25 with a completed
    // timeline are the most recent. Averaging smooths per-roll variance.
    const withTl = rolls.filter((r) => r.timeline && r.timeline.uploadedAt).slice(0, 25);
    const acc = {};
    for (const s of TIMING_STAGES) acc[s.key] = { sum: 0, n: 0 };
    for (const r of withTl) {
      const tl = r.timeline;
      for (const s of TIMING_STAGES) {
        const a = Date.parse(tl[s.from]);
        const b = Date.parse(tl[s.to]);
        if (isFinite(a) && isFinite(b) && b >= a) {
          acc[s.key].sum += (b - a);
          acc[s.key].n += 1;
        }
      }
    }
    const stages = TIMING_STAGES.map((s) => ({
      ...s,
      avg: acc[s.key].n > 0 ? acc[s.key].sum / acc[s.key].n : null,
    }));
    return { stages, sampleCount: withTl.length };
  }, [rolls]);

  if (sampleCount === 0) return null;

  const slowest = stages.reduce(
    (best, s) => (s.avg != null && (best == null || s.avg > best.avg) ? s : best),
    null,
  );

  return (
    <div className="fr-timing" role="group" aria-label="Pipeline stage timing">
      <span className="fr-timing__lead">
        Where the time goes
        <span className="fr-timing__sample">avg of {sampleCount} roll{sampleCount === 1 ? '' : 's'}</span>
      </span>
      <div className="fr-timing__stages">
        {stages.filter((s) => s.avg != null).map((s) => (
          <span
            key={s.key}
            className={'fr-timing__stage' + (slowest && s.key === slowest.key ? ' is-slowest' : '')}
            title={slowest && s.key === slowest.key ? 'Slowest stage — likely your bottleneck' : undefined}
          >
            <span className="fr-timing__stage-label">{s.label}</span>
            <span className="fr-timing__stage-value">{fmtDur(s.avg)}</span>
          </span>
        ))}
      </div>
    </div>
  );
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
      <PipelineStatus rolls={rolls} />
      <PipelineTiming rolls={rolls} />

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
    : roll.processingStatus === 'converting' ? 'Converting'
    : roll.processingStatus === 'enhancing' ? 'Enhancing'
    : roll.processingStatus === 'detected' ? 'Watching' : null;
  const provisionalClass =
    roll.processingStatus === 'processing'
      ? 'fr-roll-card__status fr-roll-card__status--processing'
      : roll.processingStatus === 'converting'
      ? 'fr-roll-card__status fr-roll-card__status--converting'
      : roll.processingStatus === 'enhancing'
      ? 'fr-roll-card__status fr-roll-card__status--enhancing'
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
  // M5 (Film Development Auto Assignment): three refined labels for
  // pending rolls held by the auto-assign feature. Gate A is
  // reviewPassed, Gate B is matchedJobId. The plain 'Awaiting approval'
  // label is still used for legacy pending rolls (Manual/Smart-flagged
  // without auto-assign).
  const isAutoAssignHeld = us === 'pending' && roll.awaitingAssignment === true;
  const hasMatch         = !!roll.matchedJobId;
  const gateA            = roll.reviewPassed === true;
  const matchedLabelBase = roll.matchedJobNumber || roll.matchedOrderNumber || '';
  const matchedLabelTail = matchedLabelBase ? ` (${matchedLabelBase})` : '';
  let uploadBadge = null;
  if (isAutoAssignHeld) {
    if (!gateA && !hasMatch) {
      uploadBadge = { label: 'Awaiting review', cls: 'fr-roll-card__upload fr-roll-card__upload--pending' };
    } else if (gateA && !hasMatch) {
      uploadBadge = { label: 'Awaiting job match', cls: 'fr-roll-card__upload fr-roll-card__upload--pending' };
    } else if (!gateA && hasMatch) {
      uploadBadge = { label: `Matched — awaiting review${matchedLabelTail}`, cls: 'fr-roll-card__upload fr-roll-card__upload--pending' };
    } else {
      // Both gates passed but no upload flip yet — very brief transient.
      uploadBadge = { label: `Matched${matchedLabelTail}`, cls: 'fr-roll-card__upload fr-roll-card__upload--pending' };
    }
  } else {
    uploadBadge =
      us === 'pending'   ? { label: 'Awaiting approval', cls: 'fr-roll-card__upload fr-roll-card__upload--pending' } :
      us === 'uploading' ? { label: 'Uploading…',         cls: 'fr-roll-card__upload fr-roll-card__upload--uploading' } :
      us === 'failed'    ? { label: 'Upload failed',      cls: 'fr-roll-card__upload fr-roll-card__upload--failed' } :
      us === 'uploaded'  ? { label: 'Uploaded',           cls: 'fr-roll-card__upload fr-roll-card__upload--uploaded' } :
      null;
  }

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
            {roll.matchedTwinCheck && (
              <span
                className="fr-roll-card__twin"
                title={[
                  roll.matchedJobNumber   ? `Job ${roll.matchedJobNumber}`     : null,
                  roll.matchedOrderNumber ? `Order ${roll.matchedOrderNumber}` : null,
                ].filter(Boolean).join(' · ') || `Twin ${roll.matchedTwinCheck}`}
              >
                Twin {roll.matchedTwinCheck}
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
            : roll.processingStatus === 'converting'
            ? 'Converting TIFFs to JPEG…'
            : roll.processingStatus === 'enhancing'
            ? 'Running Perfectly Clear on frames…'
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
