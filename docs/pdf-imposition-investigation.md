# PDF Copy — imposition templates & paper sizes

**Status:** code-complete, unreleased (2026-08-20). Six build milestones
plus three operator-feedback passes (M7, M8, M9) landed as separate
reviewed commits; the feature is off by default on every existing
pdf_copy controller and awaits release. See §10 for the build record.

**Operator-facing doc:** [`imposition-operator-guide.md`](imposition-operator-guide.md)
— setup path with the 12×18 / 5×7 grad-card worked example, filename
decoder, duplex flip-edge check, troubleshooting table. Written for
lab managers; the file you're reading is for developers.

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
paperSizes:        [{ id, name, width, height, unit: 'in'|'mm' }]
                                   // width/height stored in POINTS,
                                   // converted from the operator's unit
                                   // via M1's inchesToPoints / mmToPoints
                                   // at IPC boundary. Store speaks points
                                   // so downstream never guesses.

impositionTemplates: [{
  id, name, paperSizeId,
  gutter, margins { top, bottom, left, right, gripEdge? },  // points
  expectedArtwork { width, height },                        // points
  autoRotate: bool,
  artworkBleed: number,          // points; 0 = trust TrimBox
  cropMarks: bool,
  mode: 'simplex' | 'duplex',
  duplexFlipEdge: 'long' | 'short',
  productCodes: string[],        // the assignment
  outputSubfolder: string        // §7.4 — optional; empty = write to
                                 // outputPath root
}]
```

### 5.1 expectedArtwork — required at save time (M3 decision, 2026-08-19)

Every template carries a REQUIRED `expectedArtwork { width, height }` in
points (entered in the paper size's unit). Rationale:

- **Fit validation needs a cell size.** The real cell dimensions used at
  dispatch come from the artwork's TrimBox (per §3.1) — unknown until
  dispatch. Without a declared expected size, the template has nothing to
  validate against at save time, so an operator could persist a template
  whose configured cell doesn't fit its paper AT ALL, and only find out
  when the first job runs and fails loudly at dispatch.
- **The M4 preview needs a grid to draw.** A live layout preview
  (§6.2 — the "highest-value control") is empty without an expected cell
  size. Speculative sizes chosen by the preview code would drift from the
  real engine's answer — same failure mode as duplicated buildDestFolder.
- **M5 can warn on artwork/template divergence.** With expectedArtwork
  declared, dispatch can compare the real artwork trim to the template's
  design assumption and log a WARN when they differ (a template designed
  for 5×7 receiving 5.1×7 artwork still runs, but the operator should
  know something drifted upstream).

`expectedArtwork` is **design-time only**. Dispatch always uses the
REAL artwork trim (per §3.1 rules). If the two diverge, dispatch does
NOT reject — the template's fit was validated at save time on the
declared size; the drift is a signal, not a failure.

### 5.2 Validation at save (renderer + IPC mirror, the established pattern)

- a product code may belong to **one** template (the same
  one-inbound-name-one-target rule as shipping methods);
- cell must fit the sheet at all — the save-time check runs the REAL
  M1 `computeLayout` on `expectedArtwork` (see §5.1). ONE engine, no
  reimplementation, same rule as `buildDestFolder`. A 13×19 product on a
  12×18 sheet is a save-time error, not a dispatch surprise;
- gutter ≥ 2× artworkBleed when bleed is stated (neighbouring bleeds
  would overlap otherwise);
- deleting a paper size in use by a template is BLOCKED — the error names
  the templates so the operator knows what to fix first (M3 chose block
  over cascade: a paper size deletion cascading through templates would
  destroy hours of setup work and is not a common operation);
- `outputSubfolder` is a SINGLE FOLDER NAME, never a path — path
  separators are rejected at save time and unsafe characters are
  stripped via `printUtils.UNSAFE_CHARS` (the shared safety net that
  folder naming and the filename planner both use).

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

   **M8 amendment (2026-08-20, press-side feedback):** the OUTPUT
   NAMING is unchanged; the OUTPUT LOCATION got three new
   per-template fields.
   - `outputPath` — optional absolute-path override for the base
     destination. When set, replaces `route.outputPath` at dispatch;
     press hot folders can live anywhere on the network, not just
     under the controller root. Blank = today's behaviour (controller
     outputPath). Save-time validation: `path.isAbsolute`; existence
     NOT checked at save (a press share can be offline during setup
     and dispatch already fails loudly on write).
   - `jobSubfolder` — boolean, **DEFAULT FALSE** (changed from
     always-on). Off: the imposed PDF lands directly in the
     destination — press hot folders typically don't scan
     subdirectories. On: wraps in `{orderNumber}_{jobId}/` (the
     pre-M8 shape). §7.4's pass-through paths and §7.5's filename
     shape are unchanged.
   - `filenameTemplate` — optional; blank = the default convention
     above, byte-identical. When set, resolves via the shared
     `template-tokens.js` resolver (job-level tokens); the two
     imposition-specific tokens `{qty}` and `{impQty}` are
     substituted AFTER the shared resolver runs so they stay out
     of back-print / photo-line / folder-copy callers. Save-time
     rule: must contain at least one of `{orderNumber}`, `{jobName}`,
     `{jobId}` — flat output means files from different jobs share
     one folder, and `{qty}`/`{impQty}` alone are NOT sufficient
     (two jobs with the same totals would collide). Sanitisation
     borrows the folder-copy rules verbatim (`UNSAFE_CHARS`,
     whitespace collapse, Win32 reserved-name guard, `.pdf`
     appended once). Empty resolution at dispatch → default
     convention fallback + `logWarning` (same posture folder-copy
     uses for empty stems).

   Full resolution order at dispatch, one place in the code, one
   place here:

   ```
   {template.outputPath || route.outputPath}
     / {outputSubfolder?}          (template field, optional)
     / {jobFolderName?}            (only when jobSubfolder true)
     / {filename}.pdf              (default convention or custom template)
   ```

   **M9 amendment (2026-08-20, master-sheet mode):** the OUTPUT
   naming and destination are unchanged; a new per-template
   `outputSheets` enum selects between two OUTPUT SHAPES.
   - `'all'` (default) — the pre-M9 behaviour: one file with every
     printed sheet. Locked byte-identical by a dedicated test.
   - `'master'` — one file per design containing ONE fully-imposed
     sheet (1 page simplex, 2 pages duplex — that sheet's front +
     mirrored back). The filename QTY/IMPQTY report the REAL
     per-design ordered qty and sheet count (`ceil(qty/perSheet)`);
     the operator sets the press's own copy count to IMPQTY and
     gets QTY copies (plus overs from the always-filled sheet).
     Multi-design jobs get a `_D{i}` suffix before `.pdf` (only
     when >1 design; single-design gets no suffix). Master mode
     IGNORES `fillLastSheet` — a master can't represent a partial
     sheet; the compose call uses `quantity: layout.perSheet` which
     forces one full sheet regardless. The `{qty}`/`{impQty}`
     custom-template tokens resolve to per-design values in
     multi-design master (not cross-design sums like 'all' mode).

   Save-time validation: enum on `outputSheets`; absent → 'all'.
   Anything other than `'all'` / `'master'` rejects with the exact
   enum message so a hand-edited JSON typo can't silently coerce.

   The all-sheets default exists because operators get the
   multiplication wrong; master is the opt-in for those who don't
   (per Richard's press-side testing).

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
- ~~Fill-last-sheet quantity rounding~~ — **shipped in M7 (2026-08-20)**
  after first-hands-on operator feedback. Richard's call reversed the
  original parking: a partial last sheet is filled with extra copies by
  default because the sheet prints anyway and overs cost nothing. A
  per-template `fillLastSheet` boolean (default true) toggles it. QTY
  stays the ordered quantity, IMPQTY stays the sheet count — filling
  removes blanks, never adds sheets. See the operator guide's §4
  worked-example paragraph.
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

## 10. Build record (2026-08-19)

All six milestones landed on `main` as separate reviewed commits over
one session. §8's out-of-scope list has been reconfirmed as still
accurate — nothing landed that expanded scope, and nothing in v1
required an §8 item.

| Milestone | Commit    | What landed                                                                |
|-----------|-----------|----------------------------------------------------------------------------|
| M1        | `230589a` | Pure layout engine (`src/pdf-pipeline/imposition-layout.js`); 39 tests    |
| M1a       | `0bc004e` | Asymmetric-margin mirror tests — catch usable-area-mirror regression      |
| M2        | `9d06440` | pdf-lib composition (`imposition-compose.js`) — deriveTrim, planPlacements, composeImposition; 33 tests |
| M3        | `26a7e37` | Org-level stores + IPC + save-time validation (`imposition-service.js`); 38 tests |
| M4        | `fee4c90` | Settings screens + live preview IPC (`imposition-preview.js`); 11 tests   |
| M5        | `7beaf67` | Dispatch wiring in `_sendViaPdfCopyRouted` + pdf_copy controller fields; 17 tests |
| M6        | `c12338c` | CHANGELOG entry, operator guide, this build record, landmines, BACKLOG entry |
| M7        | `dabce3e` | Operator-feedback pass: template editor wording (Finished Size, help text refresh), live printable-area readout, fill-last-sheet (default TRUE — Richard's call reversing §8); 9 tests |
| M8        | `f6af57c` | Press-side feedback: per-template outputPath (absolute override), jobSubfolder toggle (DEFAULT FALSE — flat output), filenameTemplate ({token} + {qty}/{impQty} with distinguishing-token save rule); 16 new tests. Amends §7.5. |
| M9        | (this commit) | Master-sheet mode: per-template outputSheets 'all' \| 'master' (default 'all'); master produces one full sheet per design, filename IMPQTY reads as the press copy count, multi-design gets `_D{i}` suffix; 9 new tests. Amends §7.5. |

Also in the sequence: `4b2b595` fixed the known `perfectlyClientClient.test.js`
stability-polling flake that had been noise-swamping M3's preflight
runs (RESOLVED in `docs/BACKLOG.md`).

Suite growth: 2246 tests before M1 → 2347 after M5 (M6 adds no tests) →
2356 after M7 → 2372 after M8 → 2381 after M9. No CHANGELOG entry
until M6 — every prior milestone deliberately shipped code with no
operator-visible change until dispatch wired up. M7, M8, and M9 amend
the M6 entry rather than adding new ones; the feature is still
unreleased.

## Sources

- [Kodak Preps — Work styles for press sheets and webs](https://workflowhelp.kodak.com/display/PREPS115/Work+styles+for+press+sheets+and+webs)
  (sheetwise / work-and-turn / work-and-tumble definitions)
- [Graphic Design and Print Production Fundamentals — 5.6 Imposition](https://opentextbc.ca/graphicdesign/chapter/5-6-imposition/)
  (imposition, gutters, work styles overview)
