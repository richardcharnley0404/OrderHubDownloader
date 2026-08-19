# PDF Copy — imposition templates & paper sizes

**Status:** investigation, 2026-08-19. Nothing built. Work in progress —
this is the largest single feature proposed for OHD to date and it will take
several releases to land well.

**Ask:** commercial digital printer hot folders impose artwork inflexibly — a
lab ends up with one hot folder per product-and-orientation (Portrait 5x7
cards, Landscape 5x7 cards, …). Instead: the lab defines **paper sizes**
(12x18, 12x24, 13x26 in), builds **imposition templates** on those sheets
(auto-rotate to best fit, gutter spacing, trim-aware, simplex/duplex,
industry-standard layout), and assigns **one or more product codes** to each
template — so `0507_Grad_Card` and `0705_Grad_Card` both land on the same
sheet layout. OHD imposes the PDFs itself and writes press-ready sheets to a
single hot folder.

---

## 1. What exists today — the foundations are better than expected

**`pdf_copy` controllers already exist and already transform PDFs.**
`_sendViaPdfCopyRouted` (`print-service.js:3835`) reads the job's PDFs from
the manifest, runs each through the per-controller **PDF pipeline**
(`src/pdf-pipeline/pipeline.js`), and writes the result to
`{outputPath}/{orderNumber}_{jobId}/`. The pipeline has five step types
(interleave blanks, insert blanks, insert pages, order identifier, banner
sheet), a step-builder UI in Settings, and a per-step error posture (log and
skip).

**`pdf-lib` 1.17.1 is already a dependency** and is exactly the right tool:
`embedPage()` + `drawPage()` with x/y/rotate transforms is the standard way
to build N-up sheets, and the page-box APIs (`getTrimBox`, `getMediaBox`,
`getBleedBox`) cover trim detection. No new dependency is needed for the
core engine. (Rendering *previews* of PDF artwork in Settings is a separate
question — §7.6.)

**What does not exist:** any use of `embedPage` or the box APIs (imposition
is genuinely new code), any concept of paper sizes, and — important for the
product-code ask — **`pdf_copy` controllers have no channel mappings**. The
route literal (`routing-service.js:399`) carries only
outputPath/bannerSheet/pdfPipeline. Jobs reach a `pdf_copy` controller by
*process* routing alone; the product code is on the job but nothing in the
pdf_copy path consumes it. Product-code → imposition assignment is therefore
a new mapping layer, not an extension of an existing one.

## 2. The shape of the feature

Three new concepts, in dependency order:

1. **Paper sizes** — org-level list: name, width, height, unit (in/mm).
   e.g. `12x18"`, `12x24"`, `13x26"`.
2. **Imposition templates** — name + paper size + layout rules (gutter,
   margins, auto-rotate, bleed handling, simplex/duplex + flip edge, crop
   marks) + assigned product codes.
3. **Dispatch integration** — a `pdf_copy` controller opts in; at dispatch,
   the job's product code selects a template; OHD steps-and-repeats the
   job's PDF across as many sheets as the quantity needs and writes ONE
   press-ready PDF to the hot folder.

The win: one hot folder per press/paper instead of one per
product-orientation, because auto-rotation makes `0507` and `0705`
equivalent at imposition time.

## 3. The layout engine — the actual mathematics

Pure geometry, no I/O — this should be a standalone module
(`src/pdf-pipeline/imposition-layout.js`) with exhaustive unit tests, in the
same spirit as `folder-copy-filename.js`.

### 3.1 Cell size: trim, bleed, and the gutter

The unit being placed is the **trim box** (finished size), not the media
box. PDF page boxes nest: MediaBox ⊇ BleedBox ⊇ TrimBox.

- **TrimBox present and smaller than MediaBox** → artwork has bleed. Place
  on trim centres; the bleed extends into the gutter. The gutter must be
  ≥ 2× the bleed on each side or neighbouring bleeds overlap (v1 rule:
  validate and warn in the template editor, don't silently overlap).
- **No TrimBox (or TrimBox == MediaBox)** → treat the MediaBox as the trim
  (no bleed). Most consumer-generated PDFs are this shape.
- **Template override:** an "artwork bleed" field (default 0) for labs whose
  files carry bleed but no TrimBox — common with hobbyist-designed cards.
  When set, OHD derives trim = MediaBox inset by the stated bleed.

### 3.2 Grid fitting and auto-rotate

For a usable area (sheet minus margins) and a cell of trim `w × h` with
gutter `g`:

```
count(w, h) = floor((usableW + g) / (w + g)) * floor((usableH + g) / (h + g))
```

Compute for 0° and 90°; pick the orientation with the higher count (tie →
unrotated). This is what makes portrait and landscape product codes
converge: a 5x7 and a 7x5 both become "the orientation that fits more per
sheet". **Auto-rotate must be a per-template toggle, not always-on** — paper
grain direction is a real constraint on some stocks and some labs will need
to pin orientation.

v1 keeps one uniform orientation per sheet (standard for step-and-repeat,
and what guillotine cutting wants). Mixed-orientation packing is a
nesting problem — out of scope, noted in §8.

The grid is centred in the usable area, and rows/columns spaced by the
gutter. A **grip-edge margin** (one edge, larger) should be a template field
— digital presses can't print to the lead edge and finishers need it.

### 3.3 Duplex — the part that must follow industry convention exactly

Terminology per the industry-standard work styles (sheetwise, work-and-turn,
work-and-tumble — see Kodak Preps' work-styles reference and the standard
print-production texts):

- **Simplex** — each output sheet is one imposed page.
- **Duplex (sheetwise for a duplex digital engine)** — output pages
  alternate front, back, front, back; the press's duplex unit turns the
  sheet. The back layout must be **mirrored across the flip axis** so that
  back N lands behind front N:
  - **Long-edge flip** (the common default) → mirror the grid columns
    (left-right) on the back page.
  - **Short-edge flip** → mirror the rows (top-bottom).
  The flip edge must be a template setting because it must match the press's
  duplex configuration — a wrong guess prints every back on the wrong card.
- **Work-and-turn / work-and-tumble** (front and back ganged on the SAME
  side of one layout, sheet turned and fed again) are press-economy styles
  for litho plates. For a digital duplex engine they buy nothing — v1
  supports simplex and duplex-sheetwise only, and the doc says why.

**Duplex artwork convention (decision needed, §7.2):** the natural rule is a
2-page PDF = front/back. Simplex artwork = 1 page. What a 1-page PDF means
to a duplex template (blank backs? reject?) has to be decided, not defaulted.

### 3.4 Quantity

The established trap applies here with money attached: `job.quantity` is
unreliable (film = per-image, manual = total, Pixfizz = recomputed). The
**per-image manifest quantity** is the true print count — the batch splitter
and print-count gate already use it. Imposition must too: qty 100 on a
24-up sheet = 4 full sheets + one 4-up partial. Partial last sheets are
normal; a "fill last sheet" rounding toggle can wait.

### 3.5 Crop marks

Cutters need them when artwork has bleed (the trim edge is otherwise
invisible). v1: optional per-template corner crop marks drawn outside the
trim, standard 0.25pt, offset past the bleed. pdf-lib line drawing is
sufficient.

## 4. Where imposition sits in the dispatch flow

Recommended: imposition is a **dispatch-time transform inside
`_sendViaPdfCopyRouted`**, applied *before* the existing pdfPipeline steps —
not a sixth pipeline step. Reasons:

- Pipeline steps are per-job cosmetic transforms with a skip-on-error
  posture. Imposition failing must FAIL the dispatch loudly (a skipped
  imposition writes an un-imposed PDF into a press hot folder expecting
  13x26 sheets — worse than no output).
- Imposition needs the product code and manifest quantity; pipeline steps
  deliberately get only a small job context.
- Banner sheet / order identifier steps still make sense *after* imposition
  (a banner page on the front of the imposed run).

Resolution order at dispatch: controller has "Apply impositions" on →
look up the job's `product_code` in the assignments → template found →
impose → then existing pipeline → write. No template found → **configurable
pass-through** (§7.4, decided 2026-08-19): the controller picks one of
(a) write the un-imposed PDF to `outputPath` root — today's `pdf_copy`
behaviour, so a lab that adopts imposition gradually keeps its existing
hot-folder shape for uncovered product codes; or (b) write the un-imposed
PDF into a product-code subfolder (`{outputPath}/{product_code}/` or the
equivalent) so the lab knows which press to impose it on by hand. A
template MAY additionally specify its own output subfolder for its imposed
output so imposed sheets and pass-through singletons never share a
directory. The earlier fail-loudly recommendation here was overruled and
the reasoning is sound: an un-imposed one-off PDF sitting in the sheets
root cannot be mistaken for a press-ready sheet the way a wrongly-imposed
PDF could, so the "worse than no output" argument for fail-loudly does not
actually apply — location disambiguates instead.

## 5. Data model (org-level, electron-store, same pattern as controllers)

```
paperSizes:        [{ id, name, width, height, unit }]
impositionTemplates: [{
  id, name, paperSizeId,
  gutter, margins { top, bottom, left, right, gripEdge? },
  autoRotate: bool,
  artworkBleed: number,          // 0 = trust TrimBox
  cropMarks: bool,
  mode: 'simplex' | 'duplex',
  duplexFlipEdge: 'long' | 'short',
  productCodes: string[]         // the assignment
}]
```

Validation at save (renderer + IPC mirror, the established pattern):
- a product code may belong to **one** template (the same
  one-inbound-name-one-target rule as shipping methods);
- cell must fit the sheet at all (a 13x19 product on a 12x18 sheet is a
  save-time error, not a dispatch surprise);
- gutter ≥ 2× artworkBleed when bleed is stated;
- deleting a paper size in use by a template is blocked (or cascades with a
  confirm — decide in build).

## 6. Screens

Following the existing Settings → Routing patterns (vanilla renderer.js +
modals). Three pieces:

1. **Paper Sizes** — a simple list + add/edit modal (name, width, height,
   unit). The trivial one; build first.
2. **Imposition Templates** — list + editor modal. The editor is the big
   screen: paper size select, all §5 fields, product-code assignment
   (chips + add), and — the highest-value control — a **live layout
   preview**: a scaled SVG/canvas of the sheet showing the computed grid,
   cell count per sheet, orientation chosen, gutters and margins drawn. The
   folder-copy filename preview earned its keep three times over; this is
   the same idea for geometry, and it runs the REAL layout engine (the M5a
   lesson: never a parallel implementation).
3. **Controller hookup** — on the `pdf_copy` controller modal: an "Apply
   impositions" toggle. Assignment lives on the template, not the
   controller, so one template serves any number of controllers.

Where in Settings these live is a UX call — a new "Imposition" section
beside Routing, or nested under it. New section recommended: it's org-level
setup, not per-controller routing.

## 7. Decisions needed before building

> **Update 2026-08-19:** Richard has decided all seven items — 1, 2, 4, 5,
> 6, 7 in the earlier pass; 3 in a later same-day pass. Individual
> decisions are logged inline below; §4 has been rewritten to match the
> new item-4 posture; §7.5 has an added paragraph covering the
> multi-design case unlocked by the item-3 decision.

1. **Ganging.** v1 = one job per sheet run (step-and-repeat of a single
   job's artwork). Ganging multiple jobs onto shared sheets is a different
   feature (batching windows, cut planning, job tracking per sheet) — the
   order-merge work showed how much complexity "combine jobs" hides.
   Recommend explicitly out of scope; revisit with real lab demand.

   **Decision (2026-08-19):** confirmed — one job per sheet run; ganging
   is explicitly out of scope for v1. Revisit only on real lab demand.

2. **Duplex artwork rule.** 2-page PDF = front/back. And a 1-page PDF hitting
   a duplex template: blank backs, or reject? (Recommend blank backs with a
   WARN — a greetings-card lab will have genuinely one-sided products on
   duplex stock.) Multi-page PDFs beyond 2 pages: reject in v1 — each page
   pair as a separate card is guessable but shouldn't be guessed.

   **Decision (2026-08-19):** confirmed all three parts. 2-page PDF =
   front/back. 1-page PDF hitting a duplex template = blank backs, with a
   WARN so the operator can catch a genuinely-simplex-on-duplex-stock case
   from a mis-tagged product. Multi-page beyond 2 pages = reject in v1.

3. **Multiple PDFs in one job** (the manifest allows it): impose each
   independently into one output? Sequentially? Reject? Needs a real-world
   answer from how grad-card jobs actually arrive.

   **Decision (2026-08-19):** each design imposed SEPARATELY, sequentially
   in the one output PDF, NEVER mixed on a sheet. So design A is
   step-and-repeated to its own quantity across as many sheets as it
   needs; design B is step-and-repeated to its own quantity across as
   many sheets as it needs; both design runs concatenate into one
   multi-page output PDF handed to the press hot folder. Ganging designs
   onto a shared sheet is the excluded case (§7.1 keeps that out of
   scope for v1); this decision covers the case where a job's manifest
   has multiple `pdf_copy` artwork files. See §7.5 for the multi-design
   filename rule this decision unlocks.

4. **No-template-found behaviour** on an imposition-enabled controller: fail
   loudly (recommended) or pass through?

   **Decision (2026-08-19):** overruled — NOT fail-loudly. Instead, a
   per-controller configurable pass-through: (a) write the un-imposed PDF
   to `outputPath` root — the pre-imposition `pdf_copy` behaviour, so a
   lab adopting imposition gradually keeps its hot folder working for
   uncovered product codes; or (b) write it un-imposed into a
   product-code subfolder so the lab can impose it by hand and knows
   which press it belongs to. A template MAY additionally specify its
   own output subfolder for its imposed output so imposed sheets and
   pass-through singletons never collide in the same directory.

   The reasoning: an un-imposed one-off PDF sitting in the sheets root
   cannot be mistaken for a press-ready sheet the way a wrongly-imposed
   PDF could, so the failure mode fail-loudly was guarding against does
   not actually apply — location disambiguates instead. §4's earlier
   fail-loudly paragraph has been rewritten to match.

5. **Output naming/location**: same `{orderNumber}_{jobId}` folder as today,
   one `imposed.pdf`? Or one file per sheet? Press hot folders usually take
   one multi-page file; confirm with the target press.

   **Decision (2026-08-19):** one multi-page PDF per job, named
   `{orderNumber}_{jobId}_QTY{qty}_IMPQTY{sheets}.pdf`.
   - `QTY` is the per-image manifest quantity — the true print count
     (see §3.4; `job.quantity` is unreliable).
   - `IMPQTY` is the SHEET count the press operator runs. For duplex the
     output PDF has `2 × sheets` pages, but IMPQTY still counts sheets,
     because the operator loads sheets, not pages.
   - The `{orderNumber}_{jobId}` prefix matches the folder shape today's
     dispatch already uses, so operators recognise the filename family;
     the `QTY / IMPQTY` suffix makes the workload visible at a glance in
     the hot folder.

   **Multi-design case (2026-08-19, unlocked by decision 3):** a job
   with multiple `pdf_copy` designs still produces ONE output file per
   §7.5. Naming rule:
   - `QTY` = TOTAL copies across all designs (sum of the per-design
     manifest quantities). It is the number the press operator is
     paying to produce.
   - `IMPQTY` = TOTAL sheets in the file. It is the run length the
     operator sets on the press — designs may need different sheets-per-
     design counts because designs may have different quantities, but
     the operator only cares about the total run length. The per-design
     split is visible when the PDF is opened.
   - The filename shape is identical to the single-design case:
     `{orderNumber}_{jobId}_QTY{qty}_IMPQTY{sheets}.pdf`. Two designs
     of 40 copies each at 4-up = one file `..._QTY80_IMPQTY20.pdf`
     containing 10 sheets of design A then 10 sheets of design B.

6. **Artwork preview rendering** in the template editor (showing the actual
   card PDF in the grid, not just rectangles) needs PDF rasterising in the
   renderer — pdf.js or similar, a new dependency. v1 preview with labelled
   rectangles avoids that entirely; recommend rectangles first.

   **Decision (2026-08-19):** confirmed — rectangles first. A rasterised
   artwork preview is a nice-to-have deferred to a later milestone; it is
   the sort of polish that always looks small until it introduces pdf.js
   as a renderer dependency.

7. **Units** — labs quoted inches; mm labs exist. Store internally in PDF
   points, display per paper-size unit.

   **Decision (2026-08-19):** confirmed — inches for USA labs, mm for
   most others; unit is stored per paper size, and all internal geometry
   is in PDF points. The M1 `imposition-layout` module exports
   `inchesToPoints` and `mmToPoints` conversion helpers; the module
   itself accepts only points.

## 8. Explicitly out of scope for v1 (recorded so they're chosen, not missed)

- Ganging/nesting multiple jobs per sheet (§7.1)
- Mixed orientations on one sheet
- Work-and-turn / work-and-tumble styles (litho economics, not digital)
- Fill-last-sheet quantity rounding
- Barcode/slug lines per sheet for cut tracking (natural follow-on; the
  order-identifier pipeline step already draws text and could be extended)
- Imposing raster images (JPEG) — pdf_copy is PDF-only today; keep it so

## 9. Suggested build order (each its own reviewed milestone)

- **M1 — layout engine.** Pure geometry module: grid fit, auto-rotate,
  gutters, margins, duplex mirror mapping (front index → back position).
  Exhaustive tests including the mirror correctness for both flip edges —
  this is where a wrong sign puts every back on the wrong card.
- **M2 — composition.** pdf-lib: read boxes, derive trim, embed + place per
  M1's layout, crop marks, duplex page interleave. Golden-file tests
  (fixture PDFs with/without TrimBox, with/without bleed).
- **M3 — config + validation.** Stores, IPC, save-time rules (§5).
- **M4 — screens.** Paper Sizes, Template editor with live preview running
  the real M1 engine.
- **M5 — dispatch wiring.** Controller toggle, product-code resolution,
  fail-loudly posture, manifest quantity, ordering vs pipeline steps.
- **M6 — docs + operator note.**

M1 and M2 are pure and fully testable before any UI exists — same shape as
the folder-copy build, which worked.

## Sources

- [Kodak Preps — Work styles for press sheets and webs](https://workflowhelp.kodak.com/display/PREPS115/Work+styles+for+press+sheets+and+webs)
  (sheetwise / work-and-turn / work-and-tumble definitions)
- [Graphic Design and Print Production Fundamentals — 5.6 Imposition](https://opentextbc.ca/graphicdesign/chapter/5-6-imposition/)
  (imposition, gutters, work styles overview)
