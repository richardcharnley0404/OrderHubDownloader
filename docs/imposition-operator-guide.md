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
- **Output Subfolder** (optional) — when set, imposed output for this
  template lands in `{controller.outputPath}/{subfolder}/` instead of
  the controller's root, so imposed sheets don't share a directory
  with pass-through singletons (see Section 5). Single folder name;
  path separators are rejected.

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
card. The last sheet is fully populated (20 = 4 × 5); a job with 19
copies would produce IMPQTY5 too, with the last sheet showing 3 cards
and one empty slot.

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

## 8. What v1 does NOT do

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
- **Fill-last-sheet quantity rounding.** A job of 19 copies on 4-up
  produces 5 sheets with the last showing 3 cards + one empty slot.
- **Per-sheet barcode / slug lines** for cut tracking. Would extend
  the existing order-identifier pipeline step.
- **Rasterised artwork preview** in the template editor. v1's preview
  is labelled rectangles — the grid geometry is right; adding the
  actual card art would require pdf.js in the renderer.
- **Imposing raster (JPEG) artwork.** PDF Copy is PDF-only today; that
  stays.
