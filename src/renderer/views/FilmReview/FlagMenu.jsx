/**
 * src/renderer/views/FilmReview/FlagMenu.jsx
 *
 * Keyboard-first flag type picker, rendered as a fixed popover above the
 * frame that was right-clicked / flag-icon-clicked.
 *
 * Opens pre-selected to `rotation` (by far the most common type in real
 * labs, per the design brief) so Enter submits immediately. Number keys
 * 1–4 re-pick the type, Enter submits, Esc cancels, clicking the backdrop
 * cancels. The optional note textarea captures free-text context for the
 * "other" case — empty note is persisted as null by appendFlag().
 *
 * Training-signal picker (rotation flags only):
 *   When type === 'rotation' we show a 4-way "correct orientation" picker.
 *   Value is the rotation (relative to what the operator currently sees) that
 *   would make the frame appear upright: 0 / 90 / 180 / 270. Starts unset —
 *   a flag without a pick is negative signal only ("model got it wrong"); a
 *   flag WITH a pick is a fully labelled training example. Arrow keys pick
 *   (Up=0, Right=90, Down=180, Left=270) so the whole flow stays keyboard-first.
 *
 * Positioning: the parent passes an anchor rect; we position the menu
 * below-right of the anchor, clamped into the viewport so it never spills
 * off screen. No arrow pointer — keeps the markup simple and matches the
 * brief's rationale ("subtle, not alarmist").
 *
 * Props:
 *   frame       — record for the frame being flagged (shown as context)
 *   anchorRect  — DOMRect of the originating button, in viewport coords
 *   onSubmit    — fn({ type, note, correctRotation }) — parent does the IPC call
 *   onClose     — fn()                                — user cancelled
 */

import React, { useEffect, useRef, useState } from 'react';

const TYPES = [
  { key: 'rotation',     label: 'Rotation',      hotkey: '1' },
  { key: 'scan_quality', label: 'Scan quality',  hotkey: '2' },
  { key: 'exposure',     label: 'Exposure',      hotkey: '3' },
  { key: 'other',        label: 'Other',         hotkey: '4' },
];

// Four canonical rotations (degrees, relative to what the operator currently
// sees). Picking one turns a "this is wrong" flag into a labelled training
// example. Arrow-key hints map intuitively: Up = already upright, Right = 90°
// CW, Down = upside down, Left = 90° CCW.
const ROTATIONS = [
  { deg: 0,   label: 'Already upright',  glyph: '↑', arrow: 'ArrowUp'    },
  { deg: 90,  label: 'Rotate 90° CW',    glyph: '↻', arrow: 'ArrowRight' },
  { deg: 180, label: 'Upside down',      glyph: '↕', arrow: 'ArrowDown'  },
  { deg: 270, label: 'Rotate 90° CCW',   glyph: '↺', arrow: 'ArrowLeft'  },
];

const MENU_WIDTH  = 260;
const MENU_MARGIN = 8;

function computePosition(anchorRect) {
  if (!anchorRect) return { top: 80, left: 80 };
  const vw = window.innerWidth  || 1920;
  const vh = window.innerHeight || 1080;

  let left = anchorRect.left;
  let top  = anchorRect.bottom + 6;

  // Clamp horizontally so we never spill off the right edge.
  if (left + MENU_WIDTH + MENU_MARGIN > vw) {
    left = Math.max(MENU_MARGIN, vw - MENU_WIDTH - MENU_MARGIN);
  }
  // Flip above anchor if there isn't enough room below. Menu is ~260px tall
  // with the orientation picker + note box; pad the estimate a little.
  const estimatedHeight = 280;
  if (top + estimatedHeight + MENU_MARGIN > vh) {
    top = Math.max(MENU_MARGIN, anchorRect.top - estimatedHeight - 6);
  }
  return { top, left };
}

export function FlagMenu({ frame, anchorRect, onSubmit, onClose }) {
  const [type, setType] = useState('rotation');
  const [note, setNote] = useState('');
  const [correctRotation, setCorrectRotation] = useState(null); // 0|90|180|270|null
  const noteRef = useRef(null);
  const menuRef = useRef(null);

  const { top, left } = computePosition(anchorRect);
  const showRotationPicker = type === 'rotation';

  // Global key handler — 1–4 pick type, arrows pick orientation (rotation
  // flags only), Enter submits, Esc cancels. We bind to document so shortcuts
  // work even when the note doesn't have focus. Key handlers are skipped when
  // the note field is focused so typing in the note doesn't steal keys.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }
      const noteFocused = document.activeElement === noteRef.current;

      if (!noteFocused) {
        const t = TYPES.find((x) => x.hotkey === e.key);
        if (t) {
          e.preventDefault();
          setType(t.key);
          return;
        }
        if (showRotationPicker) {
          const r = ROTATIONS.find((x) => x.arrow === e.key);
          if (r) {
            e.preventDefault();
            // Re-pressing the same arrow clears the pick (toggle).
            setCorrectRotation((prev) => (prev === r.deg ? null : r.deg));
            return;
          }
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit?.({
          type,
          note: note.trim() || null,
          correctRotation: type === 'rotation' ? correctRotation : null,
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [type, note, correctRotation, showRotationPicker, onSubmit, onClose]);

  // On mount, focus the menu container so the keyboard handler picks up
  // keys immediately without the user having to click first.
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  // If the operator switches away from rotation, drop any pending label so
  // we never persist a correctRotation on a non-rotation flag.
  useEffect(() => {
    if (type !== 'rotation' && correctRotation !== null) {
      setCorrectRotation(null);
    }
  }, [type, correctRotation]);

  const submit = () => onSubmit?.({
    type,
    note: note.trim() || null,
    correctRotation: type === 'rotation' ? correctRotation : null,
  });

  return (
    <>
      <div className="fr-flag-menu-backdrop" onClick={onClose} />
      <div
        ref={menuRef}
        className="fr-flag-menu"
        style={{ top, left, width: MENU_WIDTH }}
        tabIndex={-1}
        role="dialog"
        aria-label={`Flag frame ${frame?.frameIndex != null ? frame.frameIndex + 1 : ''}`}
      >
        <div className="fr-flag-menu__title">
          Flag frame {frame?.frameIndex != null ? `#${frame.frameIndex + 1}` : ''}
        </div>

        <div className="fr-flag-menu__types">
          {TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={
                'fr-flag-menu__type' + (type === t.key ? ' is-selected' : '')
              }
              onClick={() => setType(t.key)}
            >
              <span className="fr-flag-menu__type-key">{t.hotkey}</span>
              {t.label}
            </button>
          ))}
        </div>

        {showRotationPicker && (
          <div className="fr-flag-menu__rot">
            <div className="fr-flag-menu__rot-label">
              Correct orientation <span className="fr-flag-menu__rot-hint">(optional — becomes training data)</span>
            </div>
            <div className="fr-flag-menu__rot-grid">
              {ROTATIONS.map((r) => (
                <button
                  key={r.deg}
                  type="button"
                  className={
                    'fr-flag-menu__rot-btn' + (correctRotation === r.deg ? ' is-selected' : '')
                  }
                  onClick={() =>
                    setCorrectRotation((prev) => (prev === r.deg ? null : r.deg))
                  }
                  title={`${r.label} (${r.arrow.replace('Arrow', '')} arrow)`}
                >
                  <span className="fr-flag-menu__rot-glyph">{r.glyph}</span>
                  <span className="fr-flag-menu__rot-text">{r.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <textarea
          ref={noteRef}
          className="fr-flag-menu__note"
          placeholder="Optional note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />

        <div className="fr-flag-menu__footer">
          <span>
            <code>1</code>–<code>4</code> type
            {showRotationPicker && <> · <code>↑↓←→</code> rotate</>}
            {' '}· <code>↵</code> submit · <code>Esc</code> cancel
          </span>
          <span className="fr-flag-menu__footer-spacer" />
          <button
            type="button"
            className="fr-flag-menu__btn"
            onClick={onClose}
          >Cancel</button>
          <button
            type="button"
            className="fr-flag-menu__btn fr-flag-menu__btn--primary"
            onClick={submit}
          >Flag</button>
        </div>
      </div>
    </>
  );
}
