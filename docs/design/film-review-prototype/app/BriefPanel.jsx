// Design-brief / rationale panel — a collapsible "read me" overlay
// that explains the design decisions and variants.

const { useState: useStateDB } = React;

function BriefPanel({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="brief-backdrop" onClick={onClose}>
      <div className="brief" onClick={(e) => e.stopPropagation()}>
        <div className="brief-head">
          <div>
            <div className="brief-eyebrow">DESIGN · OHD FILM REVIEW PANEL</div>
            <h2 className="brief-title">Design brief + rationale</h2>
          </div>
          <button className="brief-x" onClick={onClose}>
            <Icon d={icons.close} size={16} />
          </button>
        </div>

        <div className="brief-body">
          <section>
            <h3>What this is</h3>
            <p>
              A new tab inside OrderHub Downloader, sitting next to <em>Jobs</em> and <em>Settings</em>,
              for operators to visually confirm that the AI-predicted rotation on a roll of film
              was correct. The operator doesn't fix rotations here — they <strong>flag</strong> wrong
              frames so the ML team can measure error rate and collect training data.
            </p>
          </section>

          <section>
            <h3>Layout pattern — two-stage, not master-detail</h3>
            <p>
              A rolls table at the top level, then drill into one roll to see its frames. I considered
              a master-detail (rolls list on the left, frames on the right) but rejected it:
              reviewing a roll is a focused, sequential task — once the operator commits to a roll
              they want every pixel of screen real estate devoted to seeing 36 frames
              at once. Plus, the lab's existing OHD "Jobs" tab is a full-width table, so a two-stage
              pattern feels native.
            </p>
          </section>

          <section>
            <h3>Confidence visualisation</h3>
            <p>
              The prompt specifically asks how to make low-confidence frames pop without making the
              98% of confident frames noisy. I landed on a three-channel approach, all subtle:
            </p>
            <ul>
              <li>
                <strong>A coloured border</strong> on frames below 75% confidence (amber) and on
                rotation errors (red). The default state has no border — confident frames look
                "clean." The eye is trained to spot the warm colour against grey.
              </li>
              <li>
                <strong>A 6px corner dot</strong> on every frame, colour-coded by confidence bucket
                (hi / mid / low / error). Always visible so the operator can glance-read
                certainty even on clean frames, but small enough to recede.
              </li>
              <li>
                <strong>Numeric % in the footer row</strong> at regular/comfy density. In the
                tightest grid (36 visible) the number is hidden — density wins over completeness.
              </li>
            </ul>
            <p>
              The Tweaks panel lets you swap between <em>border / opacity / corner-only / numeric</em>
              to audition the trade-off. The opacity variant dims confident frames to ~55% so
              low-conf frames are the only fully-lit cells — striking, but can feel like visual
              noise on a long review session. Borders are my default.
            </p>
          </section>

          <section>
            <h3>Rotation errors</h3>
            <p>
              These are the most important "something went wrong" signal because a rotation-errored
              frame flowed through <em>unrotated</em> and is much more likely to be wrong downstream.
              I mark them with:
            </p>
            <ul>
              <li>A red border (1px, not a 3px panic stripe).</li>
              <li>A small red "rotation failed" banner overlaid on the thumb.</li>
              <li>A red corner dot.</li>
              <li>A dedicated <em>Rotation errors</em> filter chip at the top — so an operator can
                triage errors first before the rest of the roll.</li>
            </ul>
          </section>

          <section>
            <h3>Flag interaction — one-second, keyboard-first</h3>
            <p>
              Three paths to flag, in order of speed:
            </p>
            <ol>
              <li>
                <strong>Hover + press <kbd>F</kbd></strong> → instantly flags as "rotation" (by far
                the most common flag type in this workflow). No modal, no confirmation. You can
                review a roll without touching the mouse.
              </li>
              <li>
                <strong>Hover + click the flag icon</strong> that appears in the overlay → opens
                a type-picker popover anchored to the frame. Four types, optional note, Enter to
                submit.
              </li>
              <li>
                <strong>Open the frame in detail view</strong> → flag from the side panel with
                full context.
              </li>
            </ol>
            <p>
              Flagged frames get a cyan outer ring and a corner flag icon, so they stay identifiable
              after the menu closes.
            </p>
          </section>

          <section>
            <h3>Thumbnail density</h3>
            <p>
              On a 1920×1080 lab monitor with the OHD chrome + stats header, we have roughly
              1900×820 for the grid. For a 36-frame roll:
            </p>
            <ul>
              <li><strong>Tight (9×4)</strong> — fits all 36 without scrolling. Thumbs ~200×135.
                Best for a fast "something's off" scan.</li>
              <li><strong>Regular (6×6)</strong> — default. Thumbs ~300×200. Footer row with
                frame #, confidence, applied rotation. My recommended default.</li>
              <li><strong>Comfy (4×9)</strong> — thumbs ~450×300, for rolls with subtle
                misrotations (upside-down portraits of small subjects).</li>
            </ul>
          </section>

          <section>
            <h3>Keyboard model</h3>
            <ul>
              <li><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> — move through grid</li>
              <li><kbd>F</kbd> — flag hovered/selected frame as rotation</li>
              <li><kbd>⏎</kbd> — open hovered frame in detail view</li>
              <li><kbd>Esc</kbd> — close detail / menu / back to rolls</li>
              <li><kbd>1–4</kbd> — pick flag type inside the flag menu</li>
            </ul>
          </section>

          <section>
            <h3>Palette</h3>
            <p>
              Matches the existing OHD — Pixfizz blue (#32C5FF) on steel-grey (#E8EBED), near-black
              text (#232429). Amber for low confidence (warm enough to pop against cool grey) and
              red for rotation errors. The dark theme tweak swaps to near-black surfaces for dim
              lab lighting while keeping the same accent hues.
            </p>
          </section>

          <section>
            <h3>Trade-offs I considered</h3>
            <ul>
              <li>
                <strong>Showing only low-conf frames by default</strong> — rejected. The operator
                still needs to check confident frames because misrotations at 95% confidence exist
                and those are the ones that will ship wrong.
              </li>
              <li>
                <strong>Auto-advancing after a flag</strong> — tempting but rejected. Review is a
                scanning task, not a queue task. Auto-advance is right for a per-frame confirm flow
                (phase 2), not for the spot-the-misrotation flow we have now.
              </li>
              <li>
                <strong>Grouping by confidence</strong> — rejected. Operators want to see the roll
                in scan order because context between adjacent frames helps spot issues.
              </li>
            </ul>
          </section>

          <section>
            <h3>Component map for the developer</h3>
            <p>Clean React component boundaries:</p>
            <code className="brief-code">
              {`<FilmPanel>
  <RollList />          // tab root: table of rolls
  <RollReview>          // tab root when a roll is open
    <RollStatsHeader />
    <FilterChips />
    <FrameGrid>
      <FrameCell>
        <ConfidenceDot />
        <FlagBadge />
        <ErrorBanner />
        <FlagMenu />     // anchored popover
      </FrameCell>
    </FrameGrid>
  </RollReview>
  <FocusedFrame />      // overlay
</FilmPanel>`}
            </code>
          </section>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { BriefPanel });
