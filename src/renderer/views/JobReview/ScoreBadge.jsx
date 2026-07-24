/**
 * src/renderer/views/JobReview/ScoreBadge.jsx
 *
 * Single source of truth for AI Quality score display across Job Review.
 * Extracted 2026-07-24 from the inline ScoreBadge that previously lived
 * in ThumbnailCard.jsx so both the standard-grid corner marker and the
 * new ImageInfoStrip (visible in both review modes) share identical
 * threshold / error / tooltip logic — a change in one place changes
 * everywhere.
 *
 * Exports:
 *   computeScoreDisplay(aiQuality, threshold)  low-level helper
 *   ScoreBadge  { aiQuality, threshold }       pill form (numeric, red border sub-threshold)
 *   ScoreDot    { aiQuality, threshold }       compact dot form (colour-coded only)
 *
 * Display rules (identical across all callers):
 *   - unscored (no aiQuality block, or scored: false)   → render nothing
 *   - errored  (aiQuality.error populated)              → "n/a"; tooltip carries the error text
 *   - scored, above threshold                           → white text on dark pill (or neutral dot)
 *   - scored, below threshold                           → red text + red border (or red dot)
 *
 * Tooltip lines (assembled once by computeScoreDisplay):
 *   Error: <error>              (only when hasError)
 *   Scored: <local date/time>   (aiQuality.scoredAt)
 *   Model: <version>            (aiQuality.modelVersion)
 *   Mode:  <mode>               (aiQuality.modeAtScoreTime)
 *   Threshold at scoring: <n>   (aiQuality.thresholdAtScoreTime)
 */

/**
 * Assemble the render decision for a given aiQuality block + current
 * operator-configured threshold. Returns an object even when nothing
 * should render — the caller checks `shouldRender`.
 */
export function computeScoreDisplay(aiQuality, threshold) {
  if (!aiQuality || !aiQuality.scored) {
    return { shouldRender: false };
  }
  const hasError      = !!aiQuality.error;
  const score         = typeof aiQuality.score === 'number' ? aiQuality.score : null;
  const subThreshold  = !hasError && score !== null && score < threshold;
  const display       = hasError || score === null ? 'n/a' : score.toFixed(1);

  const tipLines = [];
  if (hasError) tipLines.push(`Error: ${aiQuality.error}`);
  if (aiQuality.scoredAt) {
    try {
      tipLines.push(`Scored: ${new Date(aiQuality.scoredAt).toLocaleString()}`);
    } catch { /* ignore parse failure */ }
  }
  if (aiQuality.modelVersion) tipLines.push(`Model: ${aiQuality.modelVersion}`);
  if (aiQuality.modeAtScoreTime) tipLines.push(`Mode: ${aiQuality.modeAtScoreTime}`);
  if (aiQuality.thresholdAtScoreTime != null) {
    tipLines.push(`Threshold at scoring: ${aiQuality.thresholdAtScoreTime}`);
  }
  const tooltip = tipLines.join('\n');

  return { shouldRender: true, hasError, subThreshold, display, tooltip };
}

/**
 * Pill form — numeric score in a small dark rectangle, red border and
 * red text when sub-threshold. Used by ImageInfoStrip below the main
 * preview image in both review modes.
 *
 * CSS classes intentionally match the pre-2026-07-24 in-thumbnail form
 * (.jr-score, .jr-score--sub) so the existing style block in
 * job-review.css keeps working byte-for-byte for every consumer.
 */
export function ScoreBadge({ aiQuality, threshold }) {
  const d = computeScoreDisplay(aiQuality, threshold);
  if (!d.shouldRender) return null;
  return (
    <div
      title={d.tooltip}
      className={'jr-score' + (d.subThreshold ? ' jr-score--sub' : '')}
    >
      {d.display}
    </div>
  );
}

/**
 * Dot form — a small colour-coded circle carrying the same threshold
 * signal without the number. Used in the standard ThumbnailCard corner
 * (replaces the pill so the grid declutters) and in CropThumbRail.
 * Tooltip carries the full context so hover still surfaces the number
 * and calibration metadata.
 *
 * Renders nothing for unscored images (same as ScoreBadge).
 */
export function ScoreDot({ aiQuality, threshold }) {
  const d = computeScoreDisplay(aiQuality, threshold);
  if (!d.shouldRender) return null;
  // Errored images get the sub-threshold red styling too — the score is
  // unknown, so treating it as pass would be misleading. Tooltip has the
  // error text.
  const isRed = d.subThreshold || d.hasError;
  return (
    <span
      title={d.tooltip}
      aria-label={`AI quality score: ${d.display}${d.subThreshold ? ' (below threshold)' : ''}`}
      className={'jr-score-dot' + (isRed ? ' jr-score-dot--sub' : '')}
    />
  );
}
