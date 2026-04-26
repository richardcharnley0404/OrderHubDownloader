# OHD Film Review Panel — Design Summary

## Rationale

### Layout — two-stage, not master-detail

Rolls table → drill into one roll. A master-detail (list on the left, frames on the right) wastes pixels on the list once the operator commits to a roll. Review is a focused, sequential task — every pixel should go to seeing 36 frames at once. The two-stage pattern also mirrors the existing OHD Jobs tab, so it feels native.

### Roll identity — folder ID only

At ingest time we only have the watched-folder ID (e.g. `00001247`). Customer and film stock are not known, so the roll list and headers show the ID in monospace with no invented metadata.

### Confidence visualisation — layered, subtle

Three channels that compound without shouting:

- Coloured border only on frames below 75% confidence (amber) and rotation errors (red). Default is no border — confident frames look clean. The eye is trained to spot warm colour against cool grey.
- 6px corner dot on every frame, colour-coded by bucket. Always visible but recedes.
- Numeric % in the footer row at Regular/Comfy density only. In the tight 9×4 grid, density wins over completeness.

Tweaks expose four variants — border / opacity / corner / numeric — so the trade-off is auditable.

### Rotation errors — distinct but not alarmist

Red border + red corner dot + a small red "rotation failed" ribbon on the thumb + a dedicated filter chip. Rare, important, triagable first, but not a full-card red wash.

### Flag interaction — one-second, keyboard-first

Three paths in order of speed:

1. Hover + press `F` → instant flag as "rotation" (by far the most common type). No modal.
2. Hover + click the flag icon in the overlay → popover with 4 types, optional note, submit.
3. Open frame in detail view → full-context flagging from the side panel.

### Density — recommend 6×6 default

At 1920×1080 with chrome + stats header we have ~1900×820 for the grid.

- Tight (9×4) fits all 36 without scrolling at ~200×135px.
- **Regular (6×6)** at ~300×200px with per-frame footer is the recommended default.
- Comfy (4×9) for rolls with subtle misrotations.

### Trade-offs rejected

- **Auto-advance after flag** — right for a per-frame confirm flow (Phase 2), wrong for a scanning flow.
- **Group/sort by confidence** — operators want scan order for between-frame context.
- **Hide confident frames by default** — 95%-confidence misrotations exist and would ship wrong.

### Palette

Matches existing OHD: Pixfizz blue `#32C5FF` on steel-grey `#E8EBED`, ink `#232429`. Amber for low-conf, red for errors. Dark theme swaps surfaces for dim lab lighting, keeps accents.

---

## State per component

| Component | Local state | Props in |
|-----------|-------------|----------|
| `App` | `tab`, `rolls[]`, `openRollId`, `focusedFrame`, `briefOpen`, `tweaks` | — |
| `RollList` | `filter` (ready / processing / reviewed / all), `query` | `rolls`, `onOpenRoll` |
| `RollReview` | `filter` (all / low_conf / errors / auto_rot / flagged), `hoverFrame`, `flagMenuFrame` | `roll`, `tweaks`, `onBack`, `onOpenFrame`, `onFlagFrame`, `onMarkReviewed` |
| `FrameCell` | — (stateless; derives treatment from `f` + `tweaks.confidenceViz`) | `f`, `tweaks`, `cols`, hover/open/flag handlers |
| `FlagMenu` | `type` (rotation / scan_quality / exposure / other), `note` | `frame`, `onClose`, `onSubmit` |
| `FocusedFrame` | `showFlagMenu` | `roll`, `frameId`, `onClose`, `onNav`, `onFlag`, `onUnflag` |
| `BriefPanel` | — | `open`, `onClose` |
| `OHDChrome` | — | `tab`, `onSelectTab`, `badges`, `dark` |

**Persisted via Tweaks (survives reload):** `density`, `confidenceViz`, `flagBadgeStyle`, `theme`, `showKbdHint`.

---

## Keyboard shortcuts

### Roll grid (`RollReview`)

| Key | Action |
|-----|--------|
| `F` | Flag hovered frame as rotation (quick-flag) |
| `↵` | Open hovered frame in detail view |

### Focused frame (`FocusedFrame`)

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next frame |
| `F` | Open flag menu |
| `Esc` | Close detail view |

### Flag menu (`FlagMenu`)

| Key | Action |
|-----|--------|
| `1` – `4` | Pick flag type (rotation / scan quality / exposure / other) |
| `↵` | Submit |
| `Esc` | Cancel |

All shortcuts are surfaced inline in the UI (hint row above the grid, footer of the side panel, footer of the flag menu) so operators discover them without a manual.
