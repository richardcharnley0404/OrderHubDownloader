# Missing print size — analysis and recovery plan

**Status:** plan, 2026-08-10. Nothing built.
**Trigger:** a lab upgraded to v1.8.0; every pre-existing Noritsu channel
mapping lacked a print size, so all their jobs failed with *"No print size
configured…"* and there was no in-app way to recover.

---

## 1. What actually happened

v1.7.22 made channel-mapping print size mandatory **at save time** and added a
**hard gate at dispatch** (`print-service.js:253`). Existing mappings were never
required to satisfy it. Three things then lined up:

1. **The backfill couldn't help, and said so silently.**
   `backfillLegacyPrintSizeCode` derives `printSizeCode` from the legacy
   `mapping.size` field. When `size` is empty it returns early with **no log and
   no counter** (`routing-service.js:1323`). The completion summary reports
   `{backfilled: 0, skippedNonWxH: 0, totalMappings: 40}` — indistinguishable
   from "nothing needed doing". A lab with 40 unfixable mappings sees a clean log.

2. **Nothing warned before the jobs failed.** The only signal is an amber badge
   rendered per-row inside Settings → Routing (`renderer.js:5812`). No count, no
   roll-up, no sort, no startup check. With ~40 mappings you have to scroll and
   eyeball every row, and only if you already suspected a problem.

3. **The failed job is a dead end.** `_status:'error'` matches none of the
   action-cell branches, so the Actions column renders a grey `--`
   (`renderer.js:889-890`). No Assign, no Process, no Retry, no Review. And
   `runAutoPrint` skips anything not `received`/`pending`
   (`ipc-handlers.js:2836`), so the job is permanently excluded from future
   cycles. **Nothing resets it.**

Point 3 is the part not in the original proposal, and it matters:
**fixing the mapping does not unstick the jobs that already failed.** Any lab
that hits this ends up with a permanently errored backlog even after the config
is corrected.

---

## 2. The trap in the "Re-assign" proposal

The proposal is to show a *Re-assign* button that opens the assign flow so the
operator can supply the missing size. The instinct is right — the mechanism
would not work.

**The Assign modal is create-only by construction.** Both branches build their
payload with `id: crypto.randomUUID()` (`renderer.js:1658`, `:1819`), and
`saveChannelMapping` is an upsert keyed on `id`
(`routing-service.js:903-912`) — an unknown id **appends to the tail** of the
array.

**`resolveRoute` is first-match-wins over stored array order**
(`routing-service.js:571-575`, and the three sibling lookups). So a Re-assign
built on the Assign modal would:

1. leave the broken sizeless mapping in place at its original index,
2. append a second, correct mapping at the end,
3. and `find()` would still return **the broken one**.

The operator fills in the size, gets a success toast, and the job fails exactly
as before. Worse than doing nothing, because it looks like it worked.

**The right primitive already exists.**
`openChannelMappingModal(mapping, controllers)` (`renderer.js:5871-5919`) is
self-contained, pre-fills every field including `cmPrintSizeCode` (`:5890`), and
crucially sets `modal.dataset.editingId = mapping.id` (`:5913`) so `cmSaveBtn`
updates in place (`:6063`, `:6104`). It is currently reachable **only** from the
Settings → Routing list. The fix is to make it reachable from the job row.

---

## 3. Blast radius — narrower than it looks, but with silent edges

`route.printSizeCode` is required by **exactly one controller family**: DPOF
(noritsu / epson / untyped). Darkroom Pro, Frontline, folder_copy and pdf_copy
never read it. Fuji JobMaker fails earlier and more usefully — a blank
`printCode`/`surface` yields `unrouted/no-channel`, which *does* surface the
Assign button.

Two edges are silent and worth fixing in the same release:

**Reprints have no guard.** `_sendReprintViaDPOF` goes straight from
`resolveRoute` to `dpofGenerator.generate` (`print-service.js:630-637`) with no
print-size check, and `dpof-generator.js:62` unconditionally emits
`PRT PSL=` — a malformed line. OHD reports the reprint as successful. A first
send of the same job fails loudly; a reprint produces a broken file quietly.

**Fuji PIC Pro degrades to square.** A blank `printSize` on PIC Pro logs a
warning and dispatches (`print-service.js:2465-2469`); Manual Crop then falls
back to 1:1. Wrong output, no error.

---

## 4. Two more silent bugs found in the same code

**CSV channel-mapping import reports success for saves that were rejected.**
`renderer.js:6305-6311` always sends `printSizeCode: ''`. Since v1.7.22 the IPC
validator rejects that for DPOF-family controllers
(`ipc-handlers.js:1301-1311`), returning `{success:false}` — but the import loop
only catches *thrown* exceptions and increments `imported++` unconditionally
(`:6312`). **A CSV import of Noritsu mappings reports "N imported, 0 skipped"
while persisting nothing.** Every other save path checks `result.success`.

**The badge and the validator disagree about legacy `size`.**
`validateDPOFPrintSizeCode` accepts `printSizeCode || size`
(`routing-service.js:1240-1243`), but `resolvePrintSizeCode` reads only
`printSizeCode` (`:80`). So a mapping carrying only the legacy field saves
cleanly, shows the amber badge, and still throws at dispatch.

---

## 5. Plan

Three layers plus the bug fixes. Layers 1 and 2 are independently useful; layer
3 is what actually rescues a lab in this state.

### Layer 1 — see it before it bites (proactive)

**M1. Config health check.** A pure function over the mappings that returns the
list which will fail dispatch: DPOF-family **and** blank `printSizeCode`. Put it
in `src/shared/` so it is testable and shared.

**M2. Surface it.** A count and a "Fix them" affordance in Settings → Routing,
plus a startup check that logs a real warning with the count (the current
backfill summary cannot distinguish 0-needed from 40-unfixable). Consider a
dismissible banner — this is the thing that would have caught the lab on
upgrade rather than on first failed job.

**M3. Fix the backfill's silence.** Count and log the "no source data" skip so
`{backfilled: 0, unfixable: 40}` appears in the log. One line, high value.

### Layer 2 — fix it where the operator hits it (reactive)

**M4. "Fix mapping" on the errored job row.** When a job is `_status:'error'`
and its route resolves to a DPOF-family mapping with a blank print size, render
a button in the Actions cell that calls `openChannelMappingModal(mapping,
controllers)` — the **existing, id-preserving** Settings modal, not the Assign
modal. Requires a way to get from job → resolved mapping id; `resolveRoute`
already knows the mapping, so the cleanest route is to carry
`channelMappingId` on the route (the darkroompro branch already does) and expose
it to the renderer.

Naming: **"Fix mapping"** rather than "Re-assign" — it edits an existing
mapping, and the label should not imply creating a new one.

### Layer 3 — unstick the jobs (recovery)

**M5. Retry on errored jobs.** A `Retry` button in the Actions cell for
`_status:'error'` that resets the job to `received` so auto-print picks it up
(or dispatches directly). This is generally useful well beyond this bug — today
*any* dispatch error is terminal with no operator recovery.

Optional refinement, decide before building: when a mapping is saved, also
auto-reset jobs that errored against that mapping. Nicer, but it acts on jobs
the operator didn't select — an explicit Retry is more predictable.

### Bug fixes (same release)

**M6.** Guard `_sendReprintViaDPOF` with the same print-size check as first
send, so a reprint fails loudly rather than emitting `PRT PSL=`.

**M7.** CSV import must check `result.success` and report accurate
imported/skipped counts, naming the rejected rows.

**M8.** Reconcile badge and validator on legacy `size` — either
`resolvePrintSizeCode` falls back to `size`, or `validateDPOFPrintSizeCode`
stops accepting it. **Recommend the latter**: the v1.7.22 direction was to
retire the legacy field, and a silent read-time fallback is what the release
deliberately removed.

**M9.** Docs + changelog.

---

## 5.1 M9 changelog TODOs

Cross-milestone notes to fold into the CHANGELOG when M9 lands. Each entry
here describes an operator-visible behaviour change that they need telling
about, even when the fix itself is technical / server-side.

- **M3 (validator tightening):** DPOF-family channel mappings whose only
  print-size source is the legacy `mapping.size` field can no longer be
  saved unchanged. If `size` is a bare WxH (e.g. `4x6`, `8x10`), the
  startup backfill (`backfillLegacyPrintSizeCode`) copies it into
  `printSizeCode` before the operator touches the mapping — so those
  installs are unaffected. The case that WAS silently allowed and now
  fires an error at save: `size` is a non-bare-WxH string (e.g. `KG`,
  `A4`, `NML -PSIZE "8x4"`) AND `printSizeCode` is blank. Pre-M3 that
  saved cleanly and then threw at dispatch; post-M3 the save is
  rejected with *"Print Size Code is required — it sets the print size
  for this product code."* and the operator must type the code into the
  Print Size Code field on the mapping. Intentional — the whole point
  of M3 is that validator, badge, and dispatch resolver agree — but
  it's the kind of thing labs open a ticket about, so call it out.

## 6. Decisions needed

1. **Retry: explicit button, or auto-reset on mapping save, or both?**
2. **Health check: Settings-only, or a startup banner too?** The banner is what
   would have prevented this; it is also the most intrusive.
3. **Is Fuji PIC Pro's silent square-crop fallback in scope**, or a separate
   ticket? It is the same class of bug but a different controller.
4. **Should M6–M8 ship with this, or as a fast patch first?** They are
   independent of the UI work and all three are live silent-failure paths.
