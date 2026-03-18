import { useRef, useEffect } from 'react';
import { ThumbnailCard } from './ThumbnailCard.jsx';

/**
 * src/renderer/views/JobReview/ThumbnailGrid.jsx
 *
 * Scrollable 3-column grid of ThumbnailCard components.
 *
 * Props (passed down from useJobReview via index.jsx):
 *   images       ImageEntry[]
 *   selectedId   string        Currently selected filename
 *   jobPath      string        Absolute path to job root (for image file:// URLs)
 *   onSelect     (filename) => void
 */

const BG_PANEL = '#2e3e4c';

export function ThumbnailGrid({ images, selectedId, jobPath, onSelect }) {
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
    // Outer wrapper: takes full height from parent flex-row stretch,
    // clips content so the inner div can scroll independently.
    <div
      style={{
        width: 460,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: BG_PANEL,
        borderRight: '1px solid #1e2c35',
        overflow: 'hidden',
      }}
    >
      {/* Inner grid: fills remaining height and scrolls vertically */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          alignContent: 'start',
        }}
      >
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
            />
          );
        })}

        {images.length === 0 && (
          <div style={{
            gridColumn: '1 / -1',
            padding: 32,
            textAlign: 'center',
            fontSize: 12,
            fontFamily: "'DM Mono', monospace",
            color: '#5d7a8a',
          }}>
            No images found in /working/
          </div>
        )}
      </div>
    </div>
  );
}
