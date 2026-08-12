# Claude Code brief — missing print size: recovery + three silent bugs

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, after v1.10.0 has been committed.
> Background and full analysis: `docs/missing-print-size-recovery-plan.md`.

---

Read `CLAUDE.md`, then `docs/missing-print-size-recovery-plan.md` in full —
especially §2 (the trap) and §4 (the two extra bugs). That document is the
analysis; this is the build order.

**Context.** v1.7.22 made channel-mapping print size mandatory at save time and
added a hard gate at dispatch. Pre-existing mappings were never required to
satisfy it. A lab upgraded to v1.8.0 with ~40 sizeless Noritsu mappings, every
job failed, nothing had warned them, and there was no in-app way to recover —
neither to fix the mappings from the job row, nor to revive the failed jobs.

**Decisions already made — do not revisit:**
- Recovery is an **explicit Retry button** on errored jobs, not an auto-reset
  when a mapping is saved.
- The health warning appears in **Settings → Routing AND as a dismissible
  startup banner**.
- All three silent bug fixes ship in **this same release**.

Work in **nine commits, in order**. The three independent bug fixes come first
so they are landed even if the UI work stalls. Do not start a milestone until
the previous one's tests pass. Stop and tell me if you hit something this brief
did not anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## THE TRAP — read this before designing anything

The obvious implementation of "let the operator fix the mapping from the job
row" is to reuse the Assign modal. **That would silently do nothing.**

- Both Assign branches hardcode `id: crypto.randomUUID()`
  (`renderer.js:1658`, `:1819`) — they always INSERT.
- `saveChannelMapping` is an upsert keyed on `id`
  (`routing-service.js:903-912`); an unknown id **appends to the tail**.
- `resolveRoute` uses `Array.prototype.find` over stored order
  (`routing-service.js:571-575` and three siblings) — **first match wins**.

So the broken sizeless mapping keeps winning, the new correct one is dead
weight, and the operator gets a success toast followed by an identical failure.

**Use `openChannelMappingModal(mapping, controllers)`**
(`renderer.js:5871-5919`) instead. It pre-fills every field including
`cmPrintSizeCode` (`:5890`) and sets `modal.dataset.editingId = mapping.id`
(`:5913`), so `cmSaveBtn` updates in place (`:6063`, `:6104`). It is currently
reachable only from the Settings → Routing list.

---

## M1 — Reprint print-size guard

`_sendReprintViaDPOF` (`print-service.js:569`) goes straight from `resolveRoute`
to `dpofGenerator.generate` (`:630-637`) with **no print-size check**, and
`dpof-generator.js:62` unconditionally emits `PRT PSL=${printSizeCode}`. With a
blank code that writes the literal line `PRT PSL=` and OHD reports the reprint
as successful.

- Add the same guard as first send (`print-service.js:253-258`), with the same
  operator-facing message shape, so a reprint fails loudly.
- Return the existing `{success:false, error}` reprint contract — do **not**
  throw past the IPC handler. Check how `ohd:reprint:create` surfaces errors and
  match it.
- Consider a defensive check in `dpof-generator.js` too, but **do not** make the
  generator silently substitute a default — it must stay a pure formatter.

**Tests** → extend `print-service-reprint-dpof-route.test.js`:
1. Blank `printSizeCode` → `{success:false}`, message names the product, no file
   written.
2. Valid code → unchanged behaviour.

---

## M2 — CSV import must check `result.success`

`renderer.js:6305-6311` always sends `printSizeCode: ''`. Since v1.7.22 the IPC
validator rejects that for DPOF-family controllers
(`ipc-handlers.js:1301-1311`), returning `{success:false, error}` — but the loop
at `:6303-6316` only catches *thrown* exceptions and increments `imported++`
unconditionally (`:6312`). **An import of Noritsu mappings reports "N imported,
0 skipped" while persisting nothing.**

- Check `result && result.success === false` and count it as skipped, matching
  the pattern already used in `cmSaveBtn` (`renderer.js:6128-6132`) and both
  Assign branches (`:1678-1680`, `:1826-1828`).
- Report accurate imported / skipped counts and **name the rejected rows** (row
  number + product code + reason) so the operator can fix the CSV.
- Separately: decide whether the CSV format should carry a print-size column at
  all. If it should, that is a format change — **tell me before doing it**, do
  not add it unilaterally.

**Tests:** `renderer.js` is untested, so cover what you can at the boundary —
the IPC validator's rejection shape — and describe the manual check in the
commit message.

---

## M3 — Badge and validator must agree on legacy `size`

`validateDPOFPrintSizeCode` accepts `printSizeCode || size`
(`routing-service.js:1240-1243`), but `resolvePrintSizeCode` reads only
`printSizeCode` (`:80`). A mapping carrying only the legacy field saves cleanly,
shows the amber badge, and still throws at dispatch.

**Resolve it by tightening the validator, not by adding a read-time fallback.**
v1.7.22 deliberately retired the legacy field and removed exactly that kind of
silent fallback — reintroducing one would undo the release's intent.

- `validateDPOFPrintSizeCode` requires a non-blank `printSizeCode`.
- Verify no existing save path depended on the `|| size` leniency; if one does,
  stop and tell me.

**Tests** → extend `validateDPOFPrintSizeCode.test.js`: legacy-`size`-only is
now rejected; `printSizeCode` present passes; non-DPOF types unaffected.

---

## M4 — Make the backfill's silence audible

`backfillLegacyPrintSizeCode` returns early with **no log and no counter** when
`mapping.size` is empty (`routing-service.js:1323`). The completion summary
(`:1346-1350`) reports `{backfilled, skippedNonWxH, totalMappings}` — so 40
unfixable mappings look identical to a healthy install.

- Add an `unfixable` counter for DPOF-family mappings with blank
  `printSizeCode` **and** blank `size`, include it in the summary, and log at
  **warn** when it is greater than zero.
- Same treatment for `backfillFujiPrintSize` (`:1421`).
- Do not change eligibility or the `_backfill_*` flag semantics — this is
  observability only.

**Tests** → extend `routing-backfill-print-size.test.js`: a store of sizeless
DPOF mappings yields `unfixable: N` and a warn log; healthy store yields 0.

---

## M5 — Config health check (pure function)

New `src/shared/configHealth.js`. Electron-free.

```js
/** @returns {Array<{mappingId, controllerId, controllerName, productCode, reason}>} */
function findUnroutableMappings(mappings, controllers) { … }
```

- Flag a mapping when the controller type is **DPOF-family** (mirror
  `NON_DPOF_CONTROLLER_TYPES` at `routing-service.js:1205-1207` — import it,
  don't re-declare; the renderer already keeps a duplicate copy at
  `renderer.js:5780` and a third would be worse) **and** `printSizeCode` is
  blank.
- Tolerate malformed input: null mappings, unknown controllerId, missing type.
- Return `[]` — never throw.

**Tests** → `src/shared/__tests__/configHealth.test.js`: DPOF blank → flagged;
DPOF populated → not; every non-DPOF type → never flagged regardless;
unknown controllerId; empty/garbage input; result is sorted deterministically.

---

## M6 — Surface the health check

Two surfaces, one source of truth (M5).

**Settings → Routing:** a summary line above the channel-mappings list —
*"N mappings will fail at dispatch — no print size set"* — with the affected
rows made easy to find. The per-row amber badge already exists
(`renderer.js:5809-5813`); do not duplicate it, just add the roll-up and a way
to jump to the first offender.

**Startup banner:** dismissible, in the same slot as `#updateBanner`
(`index.html:36-46`). Shows only when the count is greater than zero. Clicking
it opens Settings → Routing. Dismissal is per-app-run — do **not** persist it;
a config this broken should reassert itself on the next launch.

`renderer.js` / `index.html` only — **no bundle rebuild**. If you find yourself
editing anything under `src/renderer/views/*.jsx`, stop and tell me.

---

## M7 — "Fix mapping" on the errored job row

Today an errored job renders a grey `--` in the Actions cell
(`renderer.js:889-890`) — no Assign, no Process, no Retry.

- Carry `channelMappingId` on the resolved route so the renderer can find the
  offending mapping. The darkroompro branch already sets it
  (`routing-service.js:322-387`); add it to the DPOF Layer-3 literal and to
  `resolveRouteForController`'s DPOF literal. **Only those** — this is not the
  moment to touch all 19 route literals.
- In the Actions cell, when `_status === 'error'` **and** the route is a
  DPOF-family controller **and** its mapping has a blank print size, render a
  **"Fix mapping"** button that calls
  `openChannelMappingModal(mapping, controllers)`.
- Label it **"Fix mapping"**, not "Re-assign" — it edits an existing mapping and
  the label must not imply creating a new one.
- After a successful save, re-resolve routes and re-render, as `cmSaveBtn`
  already does (`renderer.js:6135`).

---

## M8 — Retry on errored jobs

`runAutoPrint` skips anything not `received`/`pending`
(`ipc-handlers.js:2836`), and nothing ever resets `_status` from `'error'`. Any
dispatch error is currently terminal with no operator recovery — this milestone
fixes that generally, not just for print size.

- New IPC `ohd:job:retry` that clears `_status` back to `'received'` and clears
  `_errorMessage`. Register in `preload.js`.
- **Retry** button in the Actions cell for `_status === 'error'`, alongside
  "Fix mapping" when both apply.
- Do **not** dispatch directly from Retry — reset and let the normal auto-print
  cycle pick it up, so the job goes through every existing gate (AI quality
  hold, routing hold, hold-for-review). Bypassing those would be a new hole.
- Preserve the sticky-error rationale at `ipc-handlers.js:3038-3044`: the point
  was to stop an automatic retry loop. An **operator-initiated** reset is
  exactly the escape hatch that was missing — note that in the code comment so
  nobody "fixes" it back.

**Tests:** IPC-level — errored job → retry → `_status === 'received'`,
`_errorMessage` cleared; a non-errored job is untouched.

---

## M9 — Docs + changelog

- `CHANGELOG.md` under a new `## Unreleased`: the recovery flow, the health
  check, and all four fixes. Say plainly that mappings created before v1.7.22
  may lack a print size and how to find and fix them.
- `docs/BACKLOG.md`: Fuji PIC Pro's blank `printSize` still degrades Manual Crop
  to a 1:1 square silently (`print-service.js:2465-2469`) — same class, different
  controller, deliberately out of scope here.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **Never reintroduce a read-time fallback for a missing print size.** Failing
  loudly is the v1.7.22 design intent.
- **Do not touch the Assign modal's create semantics** — see THE TRAP.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`.
- The `perfectlyClearClient` test file is flaky as a *file* — rerun once; not
  release-blocking.

## Verification checklist (I will run these)

1. A store with sizeless DPOF mappings shows a startup banner with the right
   count, and the Settings roll-up matches.
2. "Fix mapping" opens the **existing** mapping pre-filled — and after saving,
   `getChannelMappings()` shows the same number of mappings as before, with the
   size added. **No duplicate created.**
3. The job then dispatches successfully after Retry.
4. Retry on an errored job returns it to Awaiting Processing and auto-print
   picks it up.
5. A reprint against a sizeless mapping now fails loudly instead of writing
   `PRT PSL=`.
6. A CSV import containing DPOF rows without a print size reports the correct
   skipped count and names the rows.
7. A healthy config shows no banner and no roll-up.

Start with M1. Show me the diff before committing.
