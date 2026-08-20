# Imposition v2 research — ganging, and everything else worth doing

**Status:** research, 2026-08-20. Nothing decided, nothing built. v1 (M1–M9)
is step-and-repeat + master-sheet, code-complete and unreleased.

---

## 1. Where v1 sits on the industry ladder

Commercial imposition has three rungs:

1. **Step-and-repeat** — one job, one artwork repeated across a uniform
   grid. This is v1, and Richard's naming of it is exactly right.
2. **Uniform-cell ganging** — *different jobs sharing sheets*, but every
   placed item is the same trim size, so the grid — and crucially the
   cutting — is unchanged. This is what "gang run" printing shops sell:
   batches of same-size cards from many customers on shared stock.
3. **Free-form nesting** — mixed sizes and shapes packed algorithmically
   (Tilia Phoenix's territory: AI planning, irregular nesting, cut-path
   optimisation). A research-grade packing problem plus CNC-cutter
   integration.

**The recommendation of this document: build rung 2 and explicitly refuse
rung 3.** Rung 2 captures most of the commercial value — small orders
sharing sheets — while keeping every hard-won v1 invariant intact: the grid
is still `computeLayout`'s grid, the duplex mirror is untouched, the cutter
still makes straight uniform cuts. Rung 3 invalidates all of that and
competes with dedicated products (Phoenix, Impostrip, Metrix) on their home
turf.

## 2. Why ganging pays: the arithmetic

Fill-last-sheet already absorbs the waste *within* a job. Ganging absorbs it
*across* jobs. Photo-lab reality is many small orders of the same product:

| Scenario: five qty-3 jobs of the same 4-up card | Sheets |
|---|---|
| v1, separate jobs (fill-on) | 5 sheets, 20 cards, 5 overs |
| Ganged | 4 sheets (15 cards + 1 spare cell) |

The win grows with smaller quantities and bigger sheets: qty-1 and qty-2
orders on an 8-up or 12-up sheet are mostly waste as step-and-repeat and
mostly efficiency ganged. Labs running holiday-card season with hundreds of
tiny orders are the target case.

## 3. The design — uniform-cell ganging on the existing template

### 3.1 The gang key is the template

Jobs are gangable when they resolve to the **same imposition template** —
which by construction means same sheet, same finished size, same gutter,
same duplex mode, same stock intent. "Same specification" falls out of the
existing data model for free; no new spec-matching machinery. Different
*product codes* on one template (already supported — that's the
portrait/landscape pair) gang naturally: auto-rotate normalises them to one
cell orientation.

### 3.2 The window — this is order-merge again, and we already built that

Ganging needs jobs to wait for companions. OHD has solved this exact shape
once already: PIC Pro order-level merging — `mergeOrderJobs`, a
wait-with-cap (`orderMergeWaitMinutes`), the `ORDER_MERGE_WAITING` hold
reason, a pre-pass that owns dispatch, and ledger-tracked completion. The
gang window borrows all of it:

- A job routed to a gang-enabled template holds in a **gang queue** instead
  of dispatching.
- The gang **closes and dispatches** when EITHER: enough copies queue to
  fill N sheets exactly (sheet-full trigger), OR the oldest job's wait
  exceeds the template's window (time cap — nobody's grad cards wait a day
  for company), OR the operator clicks **Release now** (the batch-review
  precedent).
- Queue visibility in the Jobs grid, same as batch-held jobs today.

The window settings are per-template: `gangWindow` minutes + optional
`gangMaxSheets` per release.

### 3.3 Placement: contiguous cells, because of the guillotine

The subtle-but-critical rule, and the reason Ultimate ships a tracking
sheet: after cutting, each cell position across the run's sheets is a
**stack** of cards. Placement strategy decides whether stacks are sorted or
scrambled:

- **Interleaved filling** (job A and B alternating cells): every stack is a
  mix — someone hand-sorts hundreds of cards.
- **Contiguous filling** (fill cell-position-by-cell-position, one job at a
  time, in stable order): each stack is one job's cards, except at most one
  boundary stack per job. Cutting produces essentially sorted output.

v2 fills contiguously by cell position, and the cut map (§3.4) marks the
boundary stacks. This single decision is most of the difference between a
gang feature labs love and one they turn off.

### 3.4 Traceability — the tracking-sheet lesson

Two mechanisms, both cheap against v1's machinery:

1. **Cut map**: a separate one-page PDF per gang release (`..._CUTMAP.pdf`,
   never fed to the press hot folder) drawing the grid with each cell
   position labelled: order number, job id, quantity, which sheets. This is
   the industry-standard tracking sheet. Rendering it is the preview SVG's
   job done in pdf-lib.
2. **Optional per-cell slug**: order number in tiny type in the gutter
   beside each cell (only when gutter ≥ some threshold; never inside trim
   or bleed). The order-identifier pipeline step already draws text on
   PDFs — same toolbox.

### 3.5 What happens to the pieces we have

- `computeLayout` — **unchanged**. The grid is the grid.
- `planPlacements` — generalises: instead of (one design × qty), the gang
  planner assigns an ordered list of (job, design, copies) to cell slots
  across sheets. Same output shape, one new pure module
  (`gang-planner.js`), exhaustively testable like everything else.
- `composeImposition` — today takes ONE artwork. Gang compose embeds
  several and draws per the plan's source references. Contained change; the
  mirror/crop/trim chains don't move.
- **Filename**: `GANG_{releaseId}_QTY{totalCopies}_IMPQTY{sheets}.pdf` —
  QTY/IMPQTY semantics preserved.
- **Completion**: one dispatch completes MANY OHD jobs. `_markCompleted`
  per member on success; a write failure errors every member with the same
  message. The batch ledger pattern (v1.10's `batchLedger`) is the
  precedent for tracking multi-part dispatch state.
- **Master mode and ganging are mutually exclusive** (a master multiplies
  one sheet; a gang is heterogeneous). Simplex/duplex both fine — a cell
  belongs to one job, so fronts/backs pair per cell as today.

### 3.6 Fill the last sheet of a gang?

Options for the final partial sheet: leave blanks, or over-fill with copies
of the *last* job (arbitrary favouritism), or hold the partial back for the
next window (delays the tail jobs past their cap — no). Recommend: **leave
blanks on a gang's last sheet**, because overs of an arbitrary member help
nobody and the blanks cost exactly what step-and-repeat's fill was saving —
nothing extra. fillLastSheet stays a step-and-repeat concept.

## 4. Beyond ganging — the rest of the "make it better" list

In rough value order:

1. ~~**Duplex back-offset compensation**~~ — **Rejected 2026-08-20:
   press software handles front/back registration compensation.** The
   original argument (real presses drift front-to-back by fractions of
   a millimetre and duplex registration is the #1 quality complaint in
   card work) is true, but the compensation for it lives on the press
   itself — every digital duplex engine surveyed exposes a
   registration-nudge in its RIP/driver, and imposing OHD on top of
   that duplicates a mechanism the operator already tunes. Building
   this in OHD would give the operator TWO places to adjust the same
   thing, which is worse than either alone.
2. **Sheet margin slug** — order/job/date/`sheet n of m` in the grip
   margin of every sheet. Cheap (order-identifier step precedent), makes
   every sheet self-identifying on the press floor. Useful *now*, before
   ganging.
3. **Registration marks** — small crosshairs in opposite margins, printed
   both sides, so the operator can hold a sheet to the light and check
   front/back alignment in seconds. Pairs with (1): measure with the marks,
   correct with the offset.
4. **Best-paper selection** — a product code maps to a template today;
   labs stocking 12x18 AND 13x19 could let OHD pick the sheet that
   minimises sheets-per-job. A "template group tries N papers, picks the
   best fit" mode. Real money at volume; moderate complexity; needs the
   code→template constraint rethought — do after ganging, not before.
5. **Artwork rendered in the Settings preview** (parked in §8) — pdf.js in
   the renderer; cosmetic but sells the feature in demos.
6. **Cutter file export** — some guillotines/cutters accept cut-position
   programs. Niche until a lab asks; the layout data to generate one
   already exists in `computeLayout`'s output.

## 5. Suggested phasing

- **G1 (small, do anytime):** ~~back-offset compensation +~~ sheet
  slug + registration marks. Two genuinely independent quick wins,
  each a fraction of an M-milestone, both valuable to step-and-repeat
  labs today. (Back-offset compensation struck 2026-08-20 — see §4
  item 1.)
- **G2 (the feature):** gang planner + gang compose + window/queue
  (borrowing order-merge semantics) + cut map + completion plumbing.
  Realistically M-sized × 5–6, like v1 was.
- **G3 (judgement call, after G2 field feedback):** per-cell slugs,
  best-paper selection, cutter export.

## 6. Open questions for Richard before any G2 brief

1. Window trigger defaults: what's a sane `gangWindow` for a card lab —
   30 min? 2 h? End-of-day cutoffs (close all gangs at 14:00) instead of
   rolling windows?
2. Should gangs cross ORDERS only, or also gang multiple jobs from the SAME
   order? (Same-order ganging is pure win; the question is whether cross-
   customer sheets are acceptable to every lab — some keep customers'
   work physically separate as policy.)
3. Cut map: separate `_CUTMAP.pdf` beside the sheets file (recommended — it
   must not enter the press hot folder), or into a different folder?
4. Per-cell slugs: acceptable in the gutter at all? Some labs will refuse
   ink between trims (visible if cutting drifts).
5. ~~Is the back-offset (G1) wanted?~~ **Rejected 2026-08-20** — see
   §4 item 1. Press software owns registration compensation; OHD
   would duplicate a mechanism the operator already tunes.

## Sources

- [Ultimate TechnoGraphics — Ganging jobs to optimise print runs](https://ultimate-tech.com/article_support/ganging-print-jobs-quickly/)
- [Ultimate TechnoGraphics — Tracking sheet for gang runs](https://ultimate-tech.com/article_support/tracking-sheet-gang-run-2/)
- [Enfocus — imposition, tiling and ganging automation](https://www.enfocus.com/en/solutions/imposition-tiling-ganging)
- [Ultimate Impostrip — imposition automation](https://ultimate-tech.com/software/impostrip/)
