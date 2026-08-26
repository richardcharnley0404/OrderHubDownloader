# PDF Copy Impositions in OHD — Operator Guide

OHD can step-and-repeat PDF artwork onto press sheets before it lands in a
PDF Copy hot folder, so a commercial digital printer receives one
press-ready sheet PDF per job instead of one card PDF per copy. This
guide is for lab managers and operators who set up and use the feature.
The design details live in [`pdf-imposition-investigation.md`](pdf-imposition-investigation.md).

---

## What it replaces

Before this feature, a lab whose press hot folder imposes inflexibly
needed a **separate hot folder for every product AND every orientation**:

- `…\hotfolders\Portrait 5x7 Cards\` — for Portrait 5×7 grad cards
- `…\hotfolders\Landscape 5x7 Cards\` — for Landscape 5×7 grad cards
- `…\hotfolders\Portrait 5x7 Cards Recycled\` — different stock, again
  per orientation

Now the lab defines the paper sizes the press takes (12×18 in, 12×24 in,
etc.) once, builds one **imposition template** per (paper, layout,
duplex mode) combination, and assigns product codes to it. **Auto-rotate**
collapses the orientation split: a Portrait 5×7 code and a Landscape
5×7 code point at the same template because the engine picks whichever
fit — 5×7 unrotated or 7×5 rotated — gives more per sheet.

The result is one hot folder per press, not per product-and-orientation.

---

## 1. Add the paper sizes the press takes

**Settings → Imposition → Paper Sizes → + Add Paper Size.**

For each press-sheet size the lab loads:

- **Name** — how the paper shows up in the template editor's paper-size
  dropdown. Use whatever the operator calls it: "12×18 gloss", "SRA3
  matte", "13×26 cardstock".
- **Width / Height** — the sheet dimensions in the unit you pick below.
- **Unit** — in or mm. The unit is per-paper-size, so the same lab can
  have "12×18 in" and "305×457 mm" side by side; internally OHD stores
  everything in PDF points so the two produce identical layouts.

Save. Paper sizes are the foundation for every template — build them
first.

Deleting a paper size is blocked while any template references it — the
error names the templates so the operator knows what to fix first.

---

## 2. Build imposition templates

**Settings → Imposition → Imposition Templates → + Add Template.**

The editor is a two-column modal: fields on the left, a **live layout
preview** on the right. The preview runs the real layout engine over
IPC, so the grid you see is the grid the press will run — if the
preview shows 4 per sheet, dispatch will produce 4 per sheet.

Fields, in the order that makes sense to fill:

- **Name** — how the template shows up in the templates list. Match
  what the lab calls the product family: "Grad card 5×7", "Business
  card duplex 3.5×2".
- **Paper Size** — pick from Step 1. All numeric fields below are then
  entered in this paper's unit.
- **Expected Artwork Width / Height** — the design-time cell size the
  template is built around. **Dispatch always uses the real artwork
  TrimBox** at print time; expectedArtwork is what save-time fit
  validation and the preview grid are computed against, and it's the
  reference the log's "artwork differs from template" warning
  compares against.
- **Margins (Top/Right/Bottom/Left)** — non-printing area around the
  sheet edges. The grid centres in the space that's left. Asymmetric
  margins are honoured — set a larger bottom margin if the press
  needs a grip edge there.
- **Gutter** — space between adjacent cells on the sheet. Cutters
  need it; templates whose gutter is 0 pack cells with no space
  between and are hard to cut.
- **Artwork Bleed** — points of bleed the artwork carries beyond its
  trim. **Leave at 0** to trust each PDF's TrimBox (the design tool
  did the work). **Set a positive value** for a family whose files
  carry bleed but no explicit TrimBox — the engine will inset the
  MediaBox by that value and use the result as the trim. Save-time
  check: `gutter ≥ 2 × bleed` — otherwise neighbouring cards' bleeds
  would overlap on the sheet and the finished cards would carry
  pieces of the neighbour's ink at the trim edge.
- **Auto-rotate to best fit** — tick this UNLESS the lab needs to pin
  paper grain direction for the stock. When ticked, the engine picks
  the orientation (unrotated or 90° rotated) that fits more per sheet.
  This is what makes Portrait 5×7 and Landscape 5×7 land on the same
  template.
- **Draw crop marks** — corner crop marks at every cell's trim
  corners, drawn outside the trim past the bleed. Cutters need these
  when artwork has bleed (the trim edge is otherwise invisible).
- **Mode** — Simplex (one-sided) or Duplex (two-sided).
- **Duplex Flip Edge** — Long-edge or Short-edge. Only shown when
  Duplex is picked. **This must match the press's duplex configuration**
  — see the duplex check in Section 4.
- **Product Codes** — one row per code. A product code may belong to
  only one template; save will reject a collision naming both
  templates so the operator can pick which one wins.
- **Output Path** (optional) — the absolute folder the imposed PDF
  should land in. Leave blank to use the controller's output path
  (today's default). Press hot folders can be anywhere on the
  network — this field is the escape hatch when the press folder
  doesn't sit under the controller root. The Browse button opens the
  same picker the controller Browse buttons use. Path must be
  absolute; a relative value rejects at Save.
- **Output Subfolder** (optional) — when set, imposed output for this
  template lands one level deeper under `{base}/{subfolder}/`, where
  `{base}` is the Output Path above if set, otherwise the controller's
  output path. Use it so imposed sheets don't share a directory with
  pass-through singletons (see Section 5) or to route two templates on
  the same base to different destinations. Single folder name; path
  separators reject at Save.
- **Place in a job subfolder** (checkbox, **off by default**) — off,
  the imposed PDF lands directly in the destination (flat — press hot
  folders usually don't scan subdirectories). Tick to wrap each job in
  `{orderNumber}_{jobId}/` (the pre-M8 shape). Combined with the
  Filename Template rule below, flat output stays safe from collisions.
- **Filename Template** (optional) — leave blank to use the default
  `{orderNumber}_{jobId}_QTY{qty}_IMPQTY{impQty}.pdf` shape shown as
  placeholder text. When set, the template resolves via the same
  `{token}` system Folder Copy uses, plus two imposition-specific
  tokens: `{qty}` for total copies across designs, `{impQty}` for
  total sheets. Click any chip below the field to copy the token to
  the clipboard. **Save requires at least one of `{orderNumber}`,
  `{jobName}`, or `{jobId}`** — otherwise files from different jobs
  would overwrite each other in the flat output folder; `{qty}` and
  `{impQty}` alone are not sufficient (two jobs with the same totals
  would collide). Extension is always `.pdf`, appended automatically;
  any `.pdf` you type in the template is stripped and re-added once.
- **Output sheets** — **All sheets** (default) puts every printed
  sheet in the file: the operator sends the file to the press and
  it prints once. **Single master sheet** puts one fully-imposed
  sheet in the file and the operator sets the press's own copy
  count to the IMPQTY in the filename (proof one sheet, run IMPQTY).
  Master mode always fills the sheet (Fill last sheet is ignored)
  and produces one file per design in multi-design jobs with
  `_D1`, `_D2`… suffixes. See §4's "Master mode — proof-then-multiply"
  paragraph for the worked example.

Watch the preview as you fill fields:

- **Grid cells** show where each card lands and how many fit per sheet.
- **Caption** reads "N per sheet — rotated (C×R)" or
  "N per sheet — unrotated (C×R)".
- **Duplex** adds "backs mirror across the long/short edge (front
  shown)" — the back grid isn't drawn separately (v1); it's the
  mirror of the front across the flip axis.
- **Red zero-fit error** appears if the expected artwork doesn't fit
  the paper at all — Save will refuse with the same message.

Save. The template now claims its product codes.

---

## 3. Turn imposition on for the PDF Copy controller

**Settings → Routing → PDF Copy controller → Edit.**

Two new fields, shown only for PDF Copy controllers:

- **Apply impositions from Settings → Imposition** — tick this. Until
  you tick it, the controller behaves EXACTLY like today: no template
  lookup, no imposition, no filename shape change.
- **Product with no matching template** — the pass-through posture
  (see Section 5). Default is "Write un-imposed to the controller's
  output folder (today's behaviour)".

Save. Auto-print will pick up the change on its next cycle.

---

## 4. Worked example — 12×18 grad card, 5×7 photo, 4-up

The canonical setup:

1. **Paper Size:** 12×18 in.
2. **Template:** "Grad card 5×7", paper size 12×18 in.
   - Expected Artwork 5 × 7 in.
   - Margins 0.25 in all round.
   - Gutter 0.25 in.
   - Artwork Bleed 0.
   - Auto-rotate ON.
   - Draw crop marks ON.
   - Mode Simplex.
   - Product Codes: `GRAD5X7` (add both orientations here if the
     product codes are split — auto-rotate collapses them onto the
     same 4-up grid).
3. **Live preview reads:** `4 per sheet — unrotated (2×2)`. The
   preview shows a 2×2 grid on the sheet with the 0.25 in margins
   around it and 0.25 in gutters between the cards.
4. Save.
5. **PDF Copy controller** for the press: tick Apply impositions;
   leave Product-with-no-matching-template on "root".

Send a job with 20 copies of a Portrait 5×7 grad card through auto-print.
Expected output:

```
{controller.outputPath}\{orderNumber}_{jobId}\{orderNumber}_{jobId}_QTY20_IMPQTY5.pdf
```

Decoding the filename:

- `{orderNumber}_{jobId}` — the standard OrderHub job folder shape;
  operators already recognise it from every other PDF Copy dispatch.
- `QTY20` — 20 copies (the customer's order).
- `IMPQTY5` — **5 sheets**. That's the run length the operator sets on
  the press. 20 copies at 4-up = 5 sheets.

Open the PDF: 5 pages, each 12×18 in, each with a 2×2 grid of the grad
card. The last sheet is fully populated (20 = 4 × 5).

A job of 10 copies through the same template lands as
`..._QTY10_IMPQTY3.pdf` — 3 pages, and by default the last sheet is
**filled with 2 extra copies** (12 cards printed on 3 sheets) because
the sheet prints either way and the overs cost nothing. QTY still
reads 10 (the customer's order); IMPQTY still reads 3 (the sheet
count the operator sets on the press). Untick **Fill last sheet
(prints extra copies rather than leaving blanks)** on the template
if the lab needs exact counts — the same 10-copy job then prints
2 cards on the last sheet with two empty slots.

### Master mode — proof-then-multiply

Set the template's **Output sheets** to **Single master sheet** for
labs that prefer to proof one sheet, then set the press's own copy
count to run the rest.

The output is one PDF containing **one fully-imposed sheet** (1 page
simplex, 2 pages duplex — that sheet's front and back). Everything
else stays the same. The filename does the multiplication maths for
the operator:

- Same 10-copy grad-card job as above lands as
  `..._QTY10_IMPQTY3.pdf` — 1 page in the file, but the filename
  reads "10 copies ordered, run **3 copies of this sheet**". Operator
  opens the file, checks the proof, sets the press to 3, prints 12
  cards, trims. QTY and IMPQTY have the same meaning as all-sheets
  mode; you get one page instead of 3.
- **Master mode always fills the sheet.** A master can't represent
  a partial — the whole workflow assumes each copy at the press is
  identical to the proof. **Fill last sheet is ignored** when
  master mode is on.
- **Multi-design jobs get one file per design.** The 5-card design A
  + 3-card design B job lands as two files:
  `..._QTY5_IMPQTY2_D1.pdf` and `..._QTY3_IMPQTY1_D2.pdf`. Run D1
  twice, run D2 once. Single-design jobs get no `_D` suffix.
- **Custom filename templates apply as normal.** `{qty}` and
  `{impQty}` resolve to the per-design values in multi-design master
  mode, not the cross-design sums.

Use all-sheets mode (the default) when the lab wants a single file
to send and print in one go — no press copy-count step. Use master
mode when the lab is comfortable multiplying at the press and wants
the smaller file / faster proof.

---

## 5. Pass-through — what happens to product codes without a template

The PDF Copy controller's **Product with no matching template** setting
decides where an uncovered product code lands:

- **Root** (default) — the PDF lands at the same location today's PDF
  Copy dispatch would land it: `{outputPath}/{orderNumber}_{jobId}/{filename}.pdf`.
  Use this when the lab adopts imposition gradually and wants uncovered
  codes to keep flowing to the same hot folder.
- **Product-code subfolder** — the PDF lands at
  `{outputPath}/{productCode}/{orderNumber}_{jobId}/{filename}.pdf`.
  Use this when the lab imposes uncovered products by hand and wants
  each one to arrive labelled with its product code so the operator
  knows which press to impose it on.

Either way a pass-through file **cannot be mistaken for a press-ready
imposed sheet** — its filename is the raw `{filename}.pdf` shape (not
the `..._QTY..._IMPQTY..._.pdf` shape) and its cell size is the design
size (not the paper size). Location and filename shape are the signals
that tell an operator "this one wasn't imposed."

Multi-design jobs (e.g. a grad-card order carrying two different
designs) always produce ONE output file when a template matches:
designs sequential inside the file, never mixed on a sheet.
`_QTY_` sums copies across designs; `_IMPQTY_` sums sheets. Two designs
of 40 copies at 4-up land as `..._QTY80_IMPQTY20.pdf` — 20 sheets on
the press, first 10 sheets are design A, next 10 are design B.

---

## 6. Duplex — the flip-edge check

For duplex templates, the **Duplex Flip Edge** on the template must
match the **physical duplex configuration** of the press it prints on.

- **Long-edge flip** is the common default — the press flips the sheet
  around its long edge (like turning a book page).
- **Short-edge flip** — the sheet flips around its short edge (like
  turning a wall calendar).

**Get this wrong and every card's back prints on the wrong front.**
For a business card, that's your neighbour's back on your front. For a
Christmas card, that's the inside message mirrored the wrong way
across the fold. No imposed run with the wrong flip edge is
recoverable without reprinting.

**Check it once, before running production:**

1. Set up a duplex template with **Draw crop marks** ON.
2. Send a small test job (4 or 8 copies) through the press.
3. Fold or trim the resulting sheet as the press would output it.
4. Confirm the back of each card is the intended back for that
   card — not the neighbour's, and not the mirror.
5. If it's wrong, flip the template's **Duplex Flip Edge** setting
   between Long and Short and try again.

The flip edge is on the template because it's a physical property of
the press, not the job. Once confirmed for a press, every duplex
template that dispatches to that press uses the same setting.

---

## 7. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| **Template Save shows a red "0 cells per sheet" or "does not fit usable area" error.** | Expected artwork is too big for the paper minus the margins and gutter. The engine will not save a template that dispatches to zero output. | Increase the paper size, shrink the margins, drop the gutter, tick Auto-rotate, or reduce Expected Artwork. The preview panel shows the same error in red as you edit — fix it there, then Save. |
| **Job errors at dispatch with "Imposition failed for job N: 0 cells per sheet".** | The REAL artwork trim is larger than the template's cell (unlike expectedArtwork, which passed save). The lab uploaded a card that's larger than the template was designed for. | The imposition run does NOT fall back to writing the raw PDF — that's deliberate (a wrongly-imposed sheet in the hot folder is worse than none). Fix the artwork or the template so they agree, then retry the job. |
| **Log line: "artwork trim X × Y pt differs from template 'T' expectedArtwork W × H pt by > 0.5 pt".** | The real artwork's trim differs from the template's design assumption by more than half a point. Dispatch **succeeded** — the layout was computed on the REAL trim, so the output is correct — but the template's design assumption drifted from what the artwork actually delivers. | Not an error, but worth investigating: has the design template on the customer side changed? If the divergence is intentional (a new bleed convention), update the template's Expected Artwork to match; if not, the artwork is wrong. |
| **Job landed unimposed in the controller's output root, filename is the raw card PDF.** | No template claimed the job's product code. Pass-through fired with the default "root" behaviour. | Check the product code on the job (Job Review shows it). Check the templates in Settings → Imposition — does any of them list that code? If yes, the code text may differ (case is ignored, whitespace is trimmed; a stray non-printable character isn't). If no, add the code to the appropriate template. |
| **Job landed in `{outputPath}/{productCode}/{orderNumber}_{jobId}/`.** | Same as above, but the controller's pass-through setting is "Product-code subfolder". This is the configured signal that the lab imposes this product manually. | Impose by hand, or add the code to a template and re-send the job. |
| **Duplex press produces sheets whose backs land on the wrong fronts.** | Template's Duplex Flip Edge doesn't match the press's physical duplex configuration. | Flip the template's Duplex Flip Edge between Long and Short, reprint the test job. See Section 6. |
| **Paper Size delete blocked with "used by template(s): X, Y".** | Templates reference this paper size. Deletion is blocked rather than cascading through templates — losing a template's paper reference silently would destroy hours of setup work. | Delete or reassign the named templates first, then delete the paper size. |
| **Save Template rejects "Product code 'X' is already assigned to template 'Y'".** | The one-code-one-template rule (same rule as shipping-method names). | Decide which template should own the code, remove it from the other template, then Save. |

---

## 8. Image artwork — JPEG and PNG (M10)

Imposition templates now accept **JPEG and PNG** artwork in addition
to PDF. The rules are:

- **Accepted formats:** `.jpg`, `.jpeg`, `.png` (and `.pdf`). The
  format is decided by the file's **magic bytes**, not the extension
  — a browser-download `.jpg` that's actually a PNG still gets
  embedded correctly.
- **CMYK JPEGs are rejected.** Re-export as RGB from the original
  tool (Photoshop: Image → Mode → RGB Color; Illustrator: File →
  Document Color Mode → RGB Color) and re-upload. The reject message
  names the file and points at the fix.
- **Images stretch to Finished Size + bleed.** The image is drawn at
  exactly `Finished Size × Bleed × 2` — no cropping, no clipping,
  and **the aspect ratio is allowed to distort**. This is deliberate:
  guillotine cutting needs ink all the way to the trim edge, so a
  scale-to-cover approach that leaves uncovered corners would produce
  visible white edges. **Supply artwork at the right aspect ratio**
  for undistorted output. A 5×7 in template stretches a 5:7 image
  cleanly; a 4:3 photo on the same template gets squeezed sideways.
- **Auto-rotation to reduce distortion.** If the image's pixel
  orientation opposes the cell orientation (landscape image on a
  portrait cell, or vice versa), the image is rotated 90° before
  stretching — this minimises the per-axis distortion.
- **Effective DPI guidance.** 300 DPI is recommended; anything
  **below 150 DPI on either axis** (measured at the stretched size)
  logs a WARN naming the file and both axes' DPI. The output still
  prints — the WARN is a quality hint, not a failure.
- **Duplex pairing — the two-image rule.** On a duplex template:
  - **1 image in the job** → one design; the back cells are blank
    (a WARN is logged, matching the 1-page PDF on duplex rule).
  - **2 images in the job** → **image 1 goes on the FRONT, image 2
    on the BACK** (manifest order). The pair's **quantities must
    match** — a mismatch rejects with a message naming both files
    and both quantities.
  - **3+ images** → rejected. Do not pair them silently.
- **Mixed PDF+image jobs** are supported. Each PDF is its own design;
  images collapse into 0 or 1 image-design per the duplex/simplex
  rules above. Everything else (multi-design output, master mode
  `_D{i}` filenames, custom filename templates) works the same way it
  does for PDFs.

Images do NOT flow through the non-imposition (pass-through) path.
An image in a job whose product code doesn't match any template goes
nowhere — the pass-through is PDF-only by design (an image in the
sheets root would confuse the operator).

**Known limitation — EXIF rotation is ignored.** JPEGs carry an
optional `Orientation` tag that photo viewers use to auto-rotate the
image on screen: a phone typically stores photos in the sensor's
native (usually landscape) orientation and sets the tag to "rotate
90° for display". OHD imposition reads only the stored pixel
dimensions, so a phone photo that previews upright in Photos or
Preview but is stored sideways **will impose sideways**. Artwork
exported from design tools (Photoshop, Illustrator, Affinity,
InDesign) writes the pixels in the intended orientation and is
unaffected. If a phone-camera JPEG needs to be imposed, open it in
any image editor and re-save (Photoshop: File → Export → Save for
Web; Preview on Mac: File → Export) — the editor bakes the EXIF
rotation into the pixel data and OHD then imposes it upright.

## 9. What v1 does NOT do

Recorded so they're chosen, not missed:

- **Ganging** — multiple jobs on one sheet. v1 is one job per sheet
  run (step-and-repeat of a single job's artwork). Ganging is a
  different feature (batching windows, cut planning, per-sheet job
  tracking).
- **Mixed orientations on one sheet.** v1 picks one orientation for
  the whole sheet.
- **Work-and-turn / work-and-tumble** press-economy styles. Digital
  duplex engines don't need them; v1 is simplex or duplex-sheetwise
  only.
- ~~**Fill-last-sheet quantity rounding.**~~ Shipped in M7 —
  see §4's Fill-last-sheet paragraph.
- **Per-sheet barcode / slug lines** for cut tracking. Would extend
  the existing order-identifier pipeline step.
- **Rasterised artwork preview** in the template editor. v1's preview
  is labelled rectangles — the grid geometry is right; adding the
  actual card art would require pdf.js in the renderer.
- ~~**Imposing raster (JPEG) artwork.**~~ Shipped in M10 — see
  §8 above.
