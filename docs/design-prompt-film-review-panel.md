# Design Prompt — Film Review Panel for OrderHub Downloader

## What I need from you

I'm building a new UI panel inside a desktop app and I want you to design it. Not write the production code — produce a clear visual and interaction design I can share with my team and eventually hand to a developer to implement. Please deliver:

1. A written design brief covering layout, components, states, and interaction flow.
2. A self-contained HTML + CSS mockup of the main view (and any important secondary views like a focused-frame detail or a flagged-frames list). Inline styles or a `<style>` block is fine — no build step. Use placeholder images (any photo-like SVG or data URI) for thumbnails.
3. A short rationale section explaining the key decisions you made and the trade-offs you considered.

Feel free to show multiple variants if you think the trade-offs warrant it. I'd rather see two good options with reasoning than one take presented as obvious.

## Context

**The app.** OrderHub Downloader (OHD) is a Windows desktop app (Electron, React 18) used by photo lab operators. It handles two broad workflows: print job dispatch and film scan ingestion. The panel you're designing belongs to the film scan side — specifically, it's a review surface for scans that have been run through an AI orientation model.

**The workflow being supported.** A lab operator scans a roll of film (typically 36 frames, occasionally 24 or 120). The scans are saved as TIFFs in a watched folder. OHD processes them: it runs each frame through a local AI model that predicts the correct rotation (0°, 90°, 180°, or 270°) and automatically applies the predicted rotation using the image library sharp. The rotated images are then converted to JPEG and uploaded to cloud storage.

The operator's job in the Film Review Panel is to **look through the processed roll and visually confirm the AI got it right**. The AI is accurate but not perfect — some frames will come out sideways or upside-down. For this phase of the project, the operator does **not** manually fix these in the UI; they simply **flag** frames that look wrong so the team can (a) see the error rate in real labs and (b) build up training data for improving the model. Manual rotation will come in a later phase.

**What the user is not doing.** They're not editing images. They're not printing. They're not cropping. They're not making colour decisions. They are rapidly scanning a grid of thumbnails to spot wrongly-rotated frames and click a flag.

## Data model per frame

Each frame in a roll has the following data available:

| Field | Type | Notes |
|-------|------|-------|
| `frame_id` | string | Unique identifier |
| `thumbnail_url` | string | Local file path or data URI |
| `full_image_url` | string | Full-res version for a detail view |
| `ai_predicted_angle` | 0 \| 90 \| 180 \| 270 | What the model said to do |
| `ai_confidence` | number 0.0–1.0 | How sure it was |
| `rotation_applied` | boolean | True if sharp successfully rotated; false if the pipeline fell through due to an error |
| `rotation_error` | string \| null | Set if `rotation_applied` is false |
| `operator_flags` | array of flag objects | `{ type: 'rotation' \| 'scan_quality' \| 'exposure' \| 'other', note: string \| null, flagged_at: timestamp }` |
| `scan_order_in_roll` | integer | 1, 2, 3... for display order |

Each roll has:
- `roll_id`, `roll_name` (e.g. "Customer_Smith_2026-04-22_Roll1")
- `scanned_at`, `processed_at` timestamps
- `frame_count`, `auto_rotated_count`, `low_confidence_count`, `flagged_count`, `rotation_error_count`
- Status: `processing` | `ready_for_review` | `reviewed`

## Functional requirements

The design needs to handle all of:

- **Browse rolls.** Operator can see recently-processed rolls and open one. Sort by date, filter by status.
- **Scan a roll at a glance.** The main view is a grid of frame thumbnails for the opened roll, large enough that the operator can spot a misrotated frame without zooming. Density matters — ideally the whole 36-frame roll is visible without scrolling on a typical lab monitor.
- **Surface AI confidence visibly.** A frame the AI was 99% sure about and a frame it was 55% sure about should look different at a glance, so the operator's eye is drawn to the uncertain ones. Don't hide low confidence behind a click.
- **Surface rotation errors.** If the rotation step failed for a frame (`rotation_applied: false`), it needs to be obvious — that frame flowed through unrotated and is more likely to be wrong.
- **Flag a frame with a type.** One click to open a flag menu with four options (rotation, scan quality, exposure, other) and an optional free-text note. Flagged frames should be visually distinct in the grid.
- **Detail view.** Click a frame to see it larger, with full metadata (AI's predicted angle and confidence, rotation status, any existing flags). Navigation between frames (arrow keys, next/prev buttons).
- **Mark roll as reviewed.** When done, operator marks the whole roll reviewed. Reviewed rolls move out of the default view.
- **Summary stats per roll.** At the top of a roll view: frame count, how many were auto-rotated, how many were low confidence, how many operator-flagged, how many had rotation errors.

## Non-functional requirements and context

- **Desktop Electron app.** Typical target screen 1920×1080 or larger. Not mobile.
- **Lab environment.** Often dim lighting; dark mode or at least a muted palette works well. Avoid high-glare white backgrounds if possible.
- **Operators are not designers.** The interface needs to be fast and obvious, not clever. Affordances should be explicit (labelled buttons, visible states) rather than discovered through exploration.
- **Keyboard-driven workflow is a plus.** Operators may review hundreds of frames a day. Arrow keys to navigate, space or F to flag, Enter to confirm — that kind of thing.
- **No existing design system to inherit.** OHD has another panel (Job Review Panel) for a different domain, but don't feel obligated to match its look. This is a fresh surface; you can establish a visual language if it serves the workflow.
- **Built with React 18.** Your mockup doesn't have to be React — HTML/CSS is fine — but keep in mind it'll be ported to React components, so compose the UI in a way that maps cleanly to components.

## Questions I'd like you to weigh in on

1. **Layout pattern.** Master-detail (rolls list on the left, frames on the right)? Two-stage navigation (rolls index, then drill into a roll)? Single-page dashboard? What serves the workflow best?
2. **Confidence visualisation.** Numeric percentage? Colour-coded border? Opacity? Something else? What makes low-confidence frames pop without being visually noisy on the 98% of frames where the AI was fine?
3. **Flag interaction.** Inline menu on the thumbnail, modal, side panel, keyboard-first? I want flagging to be a one-second action, not a five-click ordeal.
4. **Thumbnail size and grid density.** 36 frames visible at once on a standard monitor — what's the sweet spot between thumbnail size (so you can see misrotations) and density (so you don't scroll)?
5. **How to show rotation errors.** These are rare but important. Make them stand out without becoming alarmist.

## What I'm not looking for

- Production-ready code.
- Branding, logos, illustrations.
- A design system with tokens and documentation — just the panel.
- Anything related to the print job side of OHD.

Please produce the design brief, the HTML mockup, and the rationale. If you have questions before you start, ask — otherwise just dive in.
