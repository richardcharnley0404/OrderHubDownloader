/**
 * src/renderer/views/JobReview/ImageInfoStrip.jsx
 *
 * A single-line horizontal strip rendered directly beneath the main
 * preview image in BOTH review modes:
 *
 *   Standard mode  — under PreviewArea in index.jsx.
 *   Manual mode    — under the CropEditor inside CropStage in ManualCropMode.
 *
 * The strip is the single info anchor for the currently-selected image:
 * filename (bigger, mid-ellipsis if long), the AI Quality score (via the
 * shared ScoreBadge — same threshold + tooltip logic as the grid corner
 * dot), and compact state chips (flagged / cropped / enhanced) rendered
 * only when applicable.
 *
 * The two review modes don't need to be identical — this component
 * standardises the INFORMATION, not the layout.
 *
 * Props:
 *   image                 ImageEntry | null
 *   aiQualityThreshold    number  (from useJobReview → index.jsx)
 *
 * Empty state:
 *   image == null (nothing selected, or images list is empty) → render
 *   nothing. Callers can safely mount unconditionally.
 */

import { ScoreBadge } from './ScoreBadge.jsx';

function midEllipsis(str, max = 64) {
  if (!str || str.length <= max) return str;
  const keep  = max - 1;
  const front = Math.ceil(keep / 2);
  const back  = keep - front;
  return str.slice(0, front) + '…' + str.slice(str.length - back);
}

export function ImageInfoStrip({ image, aiQualityThreshold }) {
  if (!image || !image.filename) return null;

  const {
    filename,
    aiQuality,
    reprint,
    // Manual-mode cropping uses `cropApplied` on the sidecar entry (M5a
    // contract); the strip surfaces it identically in both modes so
    // "cropped" reads the same everywhere.
    cropApplied,
    enhanced,
    enhancementSource,
  } = image;

  // Compact per-image state chips. Each renders only when its predicate
  // is true — keeps the strip calm on ordinary images and adds signal
  // only when there IS something to say.
  const chips = [];
  if (reprint) {
    chips.push({ key: 'reprint', label: 'Flagged', kind: 'reprint',
      title: 'Flagged for reprint' });
  }
  if (cropApplied) {
    chips.push({ key: 'cropped', label: 'Cropped', kind: 'cropped',
      title: 'A crop has been applied to this image' });
  }
  if (enhanced) {
    const src = enhancementSource === 'perfectly-clear' ? 'Perfectly Clear'
      : enhancementSource === 'topaz-direct' ? 'Topaz'
      : enhancementSource === 'local' ? 'Pixfizz AI'
      : 'Enhancement';
    chips.push({ key: 'enhanced', label: 'Enhanced', kind: 'enhanced',
      title: `Enhanced (${src})` });
  }

  return (
    <div className="jr-info-strip">
      <span className="jr-info-strip__filename" title={filename}>
        {midEllipsis(filename)}
      </span>
      <ScoreBadge aiQuality={aiQuality} threshold={aiQualityThreshold} />
      {chips.length > 0 && (
        <span className="jr-info-strip__chips">
          {chips.map((c) => (
            <span
              key={c.key}
              className={`jr-info-strip__chip jr-info-strip__chip--${c.kind}`}
              title={c.title}
            >
              {c.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
