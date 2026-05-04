import { useRef, useEffect } from 'react';
import { ThumbnailCard } from './ThumbnailCard.jsx';

/**
 * src/renderer/views/JobReview/ThumbnailGrid.jsx
 *
 * Scrollable 3-column grid of ThumbnailCard components.
 *
 * Styling: classes defined in src/renderer/job-review.css.
 *
 * Props (passed down from useJobReview via index.jsx):
 *   images               ImageEntry[]
 *   selectedId           string        Currently selected filename
 *   jobPath              string        Absolute path to job root (for image file:// URLs)
 *   onSelect             (filename) => void
 *   aiQualityThreshold   number        Threshold below which the per-card score badge turns red
 */

export function ThumbnailGrid({ images, selectedId, jobPath, onSelect, aiQualityThreshold }) {
  const scrollRef = useRef(null);

  // Auto-scroll the selected card into view whenever selectedId changes
  // (covers keyboard nav, prev/next buttons, and initial open).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !selectedId) return;
    // ThumbnailCard sets aria-pressed="true" on the selected card's root div.
    const el = container.querySelector('[aria-pressed="true"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <div className="jr-grid-col">
      <div ref={scrollRef} className="jr-grid-scroll">
        {images.map(img => {
          // Construct the absolute path to the image file in /working/.
          // We join client-side because jobPath is already an absolute Windows path.
          const imagePath = jobPath
            ? `${jobPath}\\working\\${img.filename}`
            : null;

          return (
            <ThumbnailCard
              key={img.filename}
              image={img}
              imagePath={imagePath}
              isSelected={img.filename === selectedId}
              onClick={() => onSelect(img.filename)}
              aiQualityThreshold={aiQualityThreshold}
            />
          );
        })}

        {images.length === 0 && (
          <div className="jr-grid-empty">No images found in /working/</div>
        )}
      </div>
    </div>
  );
}
