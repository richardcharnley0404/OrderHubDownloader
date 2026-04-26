/**
 * src/renderer/views/FilmReview/mount.jsx
 *
 * React entry point for the Film Review Panel (PW-007 Phase 1, Milestone 4).
 *
 * Mounts a React root into <div id="film-review-root"> inside the Film tab.
 * Unlike the Job Review drawer (which opens/closes on CustomEvents from
 * renderer.js), the Film Review panel is a full tab surface that owns its
 * own view routing (rolls list <-> focused roll) and pulls data directly
 * via window.electronAPI.filmReview*. The vanilla tab-switching code in
 * renderer.js just toggles the tab-panel's `active` class; React doesn't
 * have to know or care whether the tab is currently visible.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { FilmReviewApp } from './index.jsx';

const container = document.getElementById('film-review-root');
if (container) {
  createRoot(container).render(<FilmReviewApp />);
} else {
  // Harmless if the tab has been stripped out of index.html for some reason —
  // log and move on so the rest of the renderer still boots.
  // eslint-disable-next-line no-console
  console.error('[OHD] Could not find #film-review-root — Film Review Panel will not mount.');
}
