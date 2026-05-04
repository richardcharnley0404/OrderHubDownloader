/**
 * src/renderer/views/FilmReview/index.jsx
 *
 * Top-level component for the Film Review Panel (PW-007 Phase 1, Milestone 4).
 *
 * Owns the two pieces of state that survive view transitions:
 *   - `tweaks`   (density, showKbdHint) — persisted via IPC
 *   - `openRollId` — null => show RollList, set => show RollReview
 *
 * Light/dark theme used to live here as a panel-local tweak. During the
 * 2026-04-29 theming consistency pass it was lifted to a single app-header
 * toggle that drives `body.app-theme-dark`; this panel now picks up the
 * resulting --app-* token overrides via film-review.css aliases. The
 * `theme` field is still in the persisted shape (back-compat) but no
 * longer read from this component.
 *
 * Everything else (rolls list, frame data, flag menus) is fetched lazily by
 * the child components. This keeps the App shell small and means a bug in
 * RollReview can't crash the rolls list.
 *
 * Event handling:
 *   - onFilmReviewRollProcessed fires when Mode 2 finishes a roll. We bump
 *     a `refreshKey` counter; RollList re-fetches on key change. No shared
 *     cache, no stale-data race — the next query always hits IPC.
 *
 * The RollReview and FocusedFrame components land in M4c / M4d; for now
 * `openRollId !== null` renders a thin placeholder so M4b is shippable
 * and testable on its own.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RollList }   from './RollList.jsx';
import { RollReview } from './RollReview.jsx';

const DENSITIES = [
  { key: 'tight',   label: 'Tight'   },
  { key: 'regular', label: 'Regular' },
  { key: 'comfy',   label: 'Comfy'   },
];

const DEFAULT_TWEAKS = Object.freeze({
  density: 'regular',
  // theme: deprecated — kept in the persisted shape for back-compat with
  // existing film-review-prefs.json files but no longer read by this panel.
  // The app header now drives body.app-theme-dark globally.
  theme: 'light',
  showKbdHint: true,
});

export function FilmReviewApp() {
  const [tweaks,      setTweaks]      = useState(DEFAULT_TWEAKS);
  const [openRollId,  setOpenRollId]  = useState(null);
  const [refreshKey,  setRefreshKey]  = useState(0);
  const [tweaksLoaded, setTweaksLoaded] = useState(false);

  // Pull persisted tweaks once on mount. If the IPC call fails we fall back
  // to DEFAULT_TWEAKS — the panel still renders, just without the user's
  // last-saved preferences.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await window.electronAPI.filmReviewGetTweaks();
        if (!cancelled && stored) setTweaks({ ...DEFAULT_TWEAKS, ...stored });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[filmReview] failed to load tweaks, using defaults', err);
      } finally {
        if (!cancelled) setTweaksLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Listen for new rolls landing. Using a simple counter instead of a direct
  // state patch means we don't need to merge the event payload into RollList's
  // local state — it just re-queries.
  useEffect(() => {
    if (!window.electronAPI?.onFilmReviewRollProcessed) return;
    window.electronAPI.onFilmReviewRollProcessed(() => {
      setRefreshKey((k) => k + 1);
    });
  }, []);

  // Persist a tweak. Optimistic: update local state immediately, then write
  // through IPC. If the write is rejected (invalid value), revert.
  const setTweak = useCallback(async (key, value) => {
    const prev = tweaks;
    setTweaks({ ...prev, [key]: value });
    try {
      const ok = await window.electronAPI.filmReviewSetTweak(key, value);
      if (!ok) setTweaks(prev);
    } catch (err) {
      setTweaks(prev);
      // eslint-disable-next-line no-console
      console.warn('[filmReview] set-tweak failed', err);
    }
  }, [tweaks]);

  if (!tweaksLoaded) {
    // Avoid a flash of unstyled content — wait one tick so density
    // (which affects grid layout) is settled on first paint.
    return null;
  }

  return (
    <div className="film-review-panel">
      <header className="fr-chrome">
        <span className="fr-chrome__title">Film Review</span>
        {openRollId && (
          <>
            <span className="fr-chrome__crumb">/ {openRollId}</span>
            <button
              type="button"
              className="fr-chrome__btn"
              onClick={() => setOpenRollId(null)}
            >
              ← Back to rolls
            </button>
          </>
        )}
        <span className="fr-chrome__spacer" />
        {openRollId && (
          <div
            className="fr-filter-group"
            role="tablist"
            aria-label="Grid density"
            title="Thumbnail density"
          >
            {DENSITIES.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={tweaks.density === d.key}
                className={
                  'fr-filter-group__btn' + (tweaks.density === d.key ? ' is-active' : '')
                }
                onClick={() => setTweak('density', d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
      </header>

      {openRollId == null ? (
        <RollList
          refreshKey={refreshKey}
          onOpenRoll={(rollId) => setOpenRollId(rollId)}
        />
      ) : (
        <RollReview
          rollId={openRollId}
          tweaks={tweaks}
          onBack={() => setOpenRollId(null)}
        />
      )}
    </div>
  );
}
