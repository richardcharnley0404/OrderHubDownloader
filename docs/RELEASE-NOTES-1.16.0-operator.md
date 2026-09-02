# OrderHub Desktop v1.16.0 — what's changed

Download from **OrderHub → Settings → Info**.

This release adds **PDF and image imposition** for PDF Copy controllers
— OHD can now arrange multiple copies of a job on a large press sheet
and cut them down afterwards. It also carries forward the Fuji PIC Pro
cross-volume delivery fix and delivery-failure visibility fix from
1.15.3.

**The single most reassuring fact in this release: imposition is OFF
until you turn it on.** Every existing PDF Copy controller loads with
`applyImpositions: false`. A lab that upgrades to 1.16.0 and changes
no settings sees no change in behaviour at all — no imposition, no
new folders, no different file names. The rest of these notes only
matter if you want to try imposition.

## Installing

Windows will warn you that the publisher is unknown. That's expected
— our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers,
channel mappings, and any in-flight jobs are all preserved.

---

## New — imposition for PDF Copy controllers

**What imposition is.** Instead of sending one PDF per job to the
press, OHD arranges multiple copies of the job on a single large
press sheet, with cut lines between them. The press runs the sheet
once and the finished pieces are cut apart afterwards. For a small
product on a big press, this is the difference between one sheet
per order and one sheet per twenty orders — same printer, same ink,
much less running time.

**Off unless you turn it on.** As noted above: no existing controller
opts in on upgrade. To enable, edit a PDF Copy controller in
Settings → Routing and tick **Apply impositions**.

**Full setup walkthrough is in `docs/imposition-operator-guide.md`**
— the operator guide covers a 12×18 grad-card / 5×7 photo / 4-up
worked example with pictures, filename decoder, duplex flip-edge
check against the press, and a troubleshooting table. These release
notes summarise; the guide is the reference.

### Getting started — three things to configure in this order

1. **Paper sizes.** Settings → Imposition → Paper sizes. These are
   the sheets your press can run: `12×18 in`, `13×19 in`, `SRA3`, and
   so on. Add every paper size you actually cut down from.
2. **Imposition templates.** Settings → Imposition → Templates.
   Each template picks a paper size, a Finished Size (the piece
   you cut down to), bleed, gutter, margins, and a duplex mode
   (Simplex, or Duplex with a flip edge).
3. **Assign product codes to templates.** Each template lists the
   product codes it applies to (e.g. `5x7-lustre`, `5x7-glossy`).
   A job dispatched to a PDF Copy controller with **Apply
   impositions** on and a product code that matches a template
   gets imposed. Anything else passes through unchanged.

### Finished Size, bleed, gutter, margins — what you type in

- **Finished Size** — the final piece the customer receives, in
  inches. `5×7`, `4×6`, `A5`. This is what the cut lines mark on
  the sheet.
- **Artwork Bleed** — how much bleed each artwork PDF was
  designed with (typically 2–3 mm, entered in points). The
  engine inset-crops the artwork by this amount so its bleed
  lands EXACTLY on the sheet's cut line — a cut that lands
  slightly off the mark still hits ink, not paper.
- **Gutter** — the gap between adjacent copies on the sheet.
  The blade needs a lane; on most presses 0 mm is fine
  (edge-to-edge with a single cut between pieces) but a lab
  that wants a visible white gap can add 2 mm or more.
- **Margins** — how much white space to leave around all four
  sides of the sheet. Some presses have a grip edge that cannot
  print — set the top / bottom / left / right margins
  independently to match your press's printable area.

### Simplex and duplex — flip edge is the load-bearing setting

- **Simplex** — one side only. Front only.
- **Duplex — Long Edge** — the sheet flips over its long edge for
  the back side (typical for portrait letters and photos).
- **Duplex — Short Edge** — the sheet flips over its short edge for
  the back side (typical for landscape brochures).

**Match the flip edge to what your press is set to.** If they
disagree, the back-print lines up upside-down on the finished
piece. The imposition operator guide's §6 walks through a
one-sheet test to check this before you commit a batch.

### Fill last sheet — and Master mode

**Fill last sheet (per template, default ON).** A 20-copy job on an
8-up template is 2 full sheets (16) plus a half sheet (4). "Fill
last sheet" prints extra copies to top the last sheet up to 8, so
the press runs 3 full sheets. Get 24 finished pieces instead of 20
— the extras cost nothing extra to print.

Turn Fill last sheet OFF if the lab needs an exact count (limited
edition prints, some corporate orders).

**Master mode — "one sheet, N times" instead of N filled sheets.**
The Output Sheets setting on each template has two values:

- **All sheets** (default) — OHD emits every sheet needed to fill
  the quantity. A 40-copy job on an 8-up template is 5 sheets in
  the output folder.
- **One sheet** (master mode) — OHD emits ONE fully-imposed sheet
  and the press runs it N times to hit the quantity. This is the
  proof-then-multiply workflow: the operator opens the one sheet,
  eyeballs colour and register on a single proof, then punches
  the run-count into the press for the remaining N−1 sheets.
  Saves opening N nearly-identical PDFs in a review step.

### Output destination and filename control

Each template picks where its output PDFs land and what they're
named.

- **Destination subfolder** — a name relative to the controller's
  main output path. Blank means the controller's main path
  (equivalent to the pre-1.16.0 behaviour).
- **Absolute path override** — if a template's output needs to go
  somewhere completely different (a specific press's hot folder,
  a network share), enter the full path here. When set, this
  overrides the subfolder.
- **Job subfolder** — off by default. Hot folders usually want
  every output PDF sitting flat in one folder so the press can
  pick them up. Turn on if the destination is a lab review folder
  where per-job separation matters.
- **Filename template** — a filename with tokens, e.g.
  `{orderNumber}_{jobName}_QTY{qty}_IMPQTY{impQty}.pdf`.
  Available tokens include `{orderNumber}`, `{jobName}`,
  `{productCode}`, `{qty}` (customer's order quantity),
  `{impQty}` (imposition quantity — copies per sheet × sheet
  count = total printed), sheet indices, and the date. The
  imposition guide's §3 lists every token. `{qty}` and
  `{impqty}` (lowercase alias) are the two operators ask for
  most — the customer ordered 40, the press produced 48, and
  the filename can carry both.

### Image artwork — JPEG and PNG, in addition to PDF

Templates work on image artwork too, not just PDF. Drop a JPEG or
PNG in a PDF Copy job and the imposition engine treats it exactly
the same as a PDF page.

- **Accepted formats.** JPEG (`.jpg` / `.jpeg`) and PNG (`.png`).
  RGB colour only (see CMYK rejection below).
- **One image = simplex, two images = duplex.** A single image
  imposes on the front only. Two images impose front + back in
  order (first image = front, second image = back). Any other
  count (3+ or 0) errors the job.
- **Images are stretched to Finished Size + bleed.** The image is
  drawn at exactly the imposed cell size (Finished Size plus
  bleed on all four edges), regardless of the image's own aspect
  ratio. That guarantees cut lines always land on ink and never
  on paper — but it also means **artwork supplied at the wrong
  aspect ratio will look stretched**. Supply artwork at the right
  ratio: a 5×7 template wants a 5:7 (or 7:5) image, not a 4:3
  square, not a phone-camera 3:4. The imposition preview shows
  what will land on the sheet; check it before dispatching a
  large batch.
- **300 DPI recommended, warn below 150 DPI.** A 5×7 print at
  300 DPI wants an image at least 1500 × 2100 px. Below 150 DPI
  on either axis the imposition preview shows a ⚠ pill and the
  Activity Log carries a "low-resolution image" warning; below
  75 DPI the job errors.
- **CMYK JPEGs are rejected loudly.** Re-export the image as RGB
  from the original editor (Photoshop: Image → Mode → RGB, then
  File → Export → Save for Web). CMYK-in-JPEG is a common
  print-shop input and the reason for the loud rejection is that
  the imposition pipeline uses pdf-lib's RGB path only —
  silently mis-converting a CMYK image would produce wrong
  colours on the press.
- **Known limitation — EXIF rotation is ignored.** JPEGs carry
  an optional Orientation tag that photo viewers use to
  auto-rotate on screen. A phone photo that previews upright but
  is stored sideways with `Orientation=6` (rotate 90°) imposes
  sideways. Artwork exported from design tools (Photoshop,
  Illustrator, Affinity) is unaffected — those tools bake the
  rotation into the pixels. If a phone-camera JPEG needs to be
  imposed, open it in any editor and re-save; the editor bakes
  the EXIF rotation into the pixel data and OHD then imposes
  it upright.

---

## Also in this release — carried forward from v1.15.3

**Fuji PIC Pro cross-volume delivery is restored.** v1.15.0 removed
cross-volume delivery entirely and v1.15.1/v1.15.2 left it broken;
v1.15.3 restored it via a copy-then-rename inside DIGIN that runs
only after OrderGateway has consumed the `.txt`. Same-volume labs
are byte-for-byte unchanged. The full 1.15.3 write-up is at
`docs/RELEASE-NOTES-1.15.3-operator.md`, including the honest note
about the two hypotheses the fix rests on (PIC Pro's DIGIN watcher
ignoring the `.ohd-inbox-` prefix; OrderGateway waiting patiently
for the DIGIN folder). Neither hypothesis has been confirmed at a
lab as of this release — 1.15.3's lab test is still in progress.

**PIC Pro delivery failures now show as red jobs with an actionable
error** instead of the job sitting at "in production" forever. Also
from 1.15.3 — every kind of async delivery failure (permissions,
network drops, DIGIN unreachable, gateway timeout, build timeout)
now stamps the job with error state and the specific message that
tells the operator what to check.

---

## Help us prove this

**Imposition has been tested in development and by eye — no lab has
yet run an imposed sheet through a real press.** Duplex front-to-back
registration in particular is proven correct in the geometry and in
the test suite, but has not been folded and held up to the light on
real output. If you are the first lab to run imposed work through
this release, please:

- Run **one full duplex sheet** first (Simplex if you don't do
  duplex work). Do NOT commit a batch to the press until this one
  sheet has been checked.
- Fold the duplex sheet along its cut lines and hold it up to the
  light — every front-side piece should align exactly with its
  back-side pair. If a piece is offset, note by how much and in
  which direction (horizontal / vertical / a mix), and which flip
  edge (Long / Short) the template was set to.
- Send us the sheet PDF, the template settings, and the physical
  observation. If it looks right, tell us that too — that's the
  confirmation we need before treating imposition as press-verified.

The two things most likely to surface a real-world issue that
development testing didn't:

1. **Flip-edge mismatch** — if the sheet you fold shows the back
   registered correctly BUT rotated 180° from where you expected,
   the template's flip-edge setting disagrees with the press's
   duplex configuration. Switch the template from Long Edge to
   Short Edge (or vice versa) and re-check.
2. **Bleed at the cut lines** — pieces cut apart should have colour
   right up to the trimmed edge, no white sliver. If you see white
   at any edge, the Artwork Bleed setting on the template is
   smaller than the bleed the artwork was designed with; adjust
   and re-check.

---

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity
Log tab is the quickest place to spot the cause. For imposition
issues specifically, the imposition preview in Settings shows the
exact grid OHD will lay down; if the preview looks wrong, the
output will match the preview, so start there.
