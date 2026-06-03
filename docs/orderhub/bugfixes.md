# OHD Bug-Fix Maintenance Log

A flat chronological record of operator-facing bug fixes. Each entry captures
the customer report, the fix, and the test case used to verify. Newer entries
go at the top.

This is **separate from** `docs/ai-quality-gate/conversion-audit.md`. That
document is the engineering record of the MUSIQ-SPAQ ONNX conversion + the AI
Quality Gate work. This file is for routine bug fixes touching unrelated
parts of the codebase.

---

## 2026-05-12 — Darkroom Pro reprints actually dispatched + silent-failure fix

### Background

Reprints sent from Job Review against a Darkroom Pro-routed parent job
appeared to succeed — the bottom action bar flipped to `JOB-r1 sent ✓`,
the parent's reprint flags cleared, the REPRINTS stat in the top bar
dropped to zero — but no `.txt` job ticket ever landed in the Darkroom
Pro controller's output folder. The reprint job folder was correctly
built on disk under `{order}/...-r1/` with `originals/`, `working/`,
`cache/`, and a sidecar, but nothing was sent to the printer.

### Root cause

Two stacked issues:

  1. **Pipeline gap.** The reprint IPC handler called
     `printService._sendReprintViaDPOF`. That method had an explicit
     early return when the parent's controller was Darkroom Pro:
     `return { success: false, error: 'Darkroom Pro reprints are not
     yet supported.' };`. No Darkroom Pro reprint path existed.
  2. **Silent-failure surface.** The IPC handler at `ohd:reprint:create`
     received `printResult.success === false`, called `logger.logWarning`,
     and then returned `{ success: true, ...result, printResult }` —
     i.e. it told the renderer the operation succeeded even when
     dispatch had failed. The renderer's `sendReprints` only checks
     the top-level `result.success`, so it cleared the parent's reprint
     flags and surfaced the "sent ✓" pill. There was no operator-visible
     signal that the print step had been skipped.

### Fix

Three changes in `src/main/services/print-service.js` plus IPC handler
and ActionBar updates.

**1. New orchestrator `sendReprint(parentJob, reprintJobPath, reprintSuffix, reprintImages)`.**
Resolves the parent's route via `routing-service.resolveRoute` and
dispatches to the appropriate controller-type method. Unsupported route
shapes (unrouted, process-folder, default-folder) return a structured
error rather than reaching into a controller-specific method that can't
service them.

**2. New `_sendReprintViaDarkroomPro(parentJob, route, reprintJobPath, reprintSuffix, reprintImages)`.**
Modeled after `_sendViaDarkroomProRouted` but with three reprint-shaped
differences:

  - Image sourcePaths come from `{reprintJobPath}/originals/` — the
    clean copies that `reprintManager` produced. No manifest is read;
    the reprint sidecar's `images` array is the source of truth for
    which files print and at what qty.
  - CMY corrections come from the reprint sidecar (carried over by
    `reprintManager` from the parent) and are re-applied to
    `{reprintJobPath}/working/`. Enhanced images are NOT propagated —
    the `reprintManager.js` header makes the design intent explicit:
    reprints always start from `/originals/` for a predictable result.
  - The output `.txt` is named `{job_name}-r{n}.txt` via
    `outputFilenameStem` so the reprint ticket doesn't collide with
    the parent's `{job_name}.txt` in the controller's hot folder.

Parent-job status (`_markInProduction` / `_markCompleted`) is
deliberately left untouched — a reprint is a sibling concept that lives
only in OHD's local files and on the printer queue, not in the OH-side
job lifecycle.

**3. IPC handler `ohd:reprint:create` surfaces dispatch failures.**
When `printResult.success === false`, the handler now returns
`{ success: false, error, reprintJobId, reprintJobPath }` instead of
returning `success: true` with a swallowed warning. The parent's
reprint flags are only cleared when dispatch succeeded — failed
dispatches leave the parent in its flagged state so the operator can
fix the routing config and click Send again. The reprint folder stays
on disk; the next attempt will scan for existing `-r*` siblings and
land on `-r2` / `-r3` rather than re-using a possibly-corrupt
`-r1` folder. (Future work: surface "retry dispatch" against an
existing reprint folder so retries don't accumulate orphans.)

**4. ActionBar surfaces the error inline.**
Pre-fix the renderer's `sendReprints` threw on `!result.success` into
an unhandled promise rejection — the action bar's `finally` clause
just reset the button to idle, making it look like nothing had
happened. The bar now catches, stashes the error in component state,
and shows `⚠ {error}` + a `Retry Send` button. Hovering the message
reveals the full text via `title` for long error strings.

### Behaviour change to flag for operators

Darkroom Pro reprints now actually produce a `.txt` file in the
controller's output folder, named `{job_name}-r{n}.txt`. Multiple
reprints of the same job produce `-r1`, `-r2`, … with no overwrite
risk.

If dispatch fails (route misconfigured, output path unreachable, etc.)
the operator now sees a red error in the action bar instead of a
"sent ✓" pill. The parent's reprint flags remain set so the operator
can retry after fixing the underlying issue.

### Verification

Walked three scenarios by hand:

  1. **DPOF parent reprint** (regression check). `sendReprint` resolves
     a DPOF route, falls through to `_sendReprintViaDPOF`, which builds
     a DPOF hot-folder envelope exactly as before. IPC handler sees
     `method: 'dpof-reprint'` and restarts status polling. Flags
     cleared on parent.
  2. **Darkroom Pro parent reprint** (the original bug). `sendReprint`
     resolves a Darkroom Pro route, dispatches to
     `_sendReprintViaDarkroomPro`. `generateDarkroomProFile` writes
     `{job_name}-r1.txt` to `controller.outputPath` with line-item
     blocks grouped by reprint-time qty and image source paths pointing
     at the reprint folder's `/originals/` (or `/working/` if any image
     had CMY corrections). Parent's `_darkroomProSize` /
     `_darkroomProMedia` Assign-modal overrides carry through so a
     manually-assigned parent doesn't fall back to translation tables
     on the reprint.
  3. **Route fails to resolve.** Folder builds successfully, then
     `sendReprint` returns `{ success: false, error: 'Parent job has
     no usable route…' }`. IPC handler returns top-level
     `success: false` with a composed error message. Renderer's
     ActionBar shows `⚠ Reprint folder JOB-r1 created but dispatch
     failed: Parent job has no usable route…` and a `Retry Send`
     button. Parent's reprint flags are still set in the sidecar.

---

## 2026-05-12 — Bulk reprint flagging + inline per-card toggle + honest print-count in Job Review

### Background

Job Review's reprint flow already had the plumbing for partial reprints —
every image carries a `reprint: boolean` flag in its sidecar entry, the
`reprintManager.createReprint` step copies only flagged images from the
parent's `/originals/`, and the `-r1` / `-r2` naming pipeline was wired
up end-to-end. What was missing was operator-facing affordance:

  - No bulk "flag all" / "clear all" — on a 36-print job that's 36
    clicks to reprint the whole set.
  - The per-image Reprint toggle lived in the right sidebar, reachable
    only after first clicking a thumbnail to load it into the main
    preview. The two natural partial-reprint workflows — "reprint all
    except these 3" and "reprint just these 3 or 4" — both required a
    full preview round-trip per image instead of a single click on
    each card.
  - The bottom Send button said "Send 5 Reprints → JOB-r1" — but "5"
    was the image count, not the print count. When any flagged image
    carried qty > 1 the actual reprint job produced more sheets than
    the button suggested.
  - The top "REPRINTS" stat box showed an image count with no hint of
    how many sheets the reprint job would actually print.

### Fix

Three changes, all renderer-side; the `reprintManager` pipeline is
untouched.

**Inline per-card toggle (`ThumbnailCard.jsx`).** The previously
conditional "REPRINT" badge in the top-left of each card is now a
permanent `<button>` whose state tracks the image's reprint flag:

  - unflagged → faint translucent dark background, text `FLAG`
  - flagged   → solid red background, text `REPRINT`

Click on the button toggles `image.reprint`; `stopPropagation` prevents
the card's own "click to select for main preview" handler from firing,
so flagging doesn't disturb which image is open in the centre pane.
Keyboard activation (Enter / Space) is handled the same way and the
button is its own tab stop. The card's red border (`.is-reprint`) and
the canvas reprint tint stay as reinforcing visual signals. The MOD
badge is no longer hidden when an image is flagged — both states are
independent and worth surfacing together.

**Bulk toggle on the thumbnail grid header (`ThumbnailGrid.jsx`).**
Single button whose label tracks state:

  - 0 flagged → `Flag all for reprint`
  - mixed     → `Flag remaining (N)` plus a secondary `Clear` link
  - all flagged → `Clear all reprint flags` (red styling)

Wired through to `useJobReview` via two new actions, `flagAllReprints`
and `clearAllReprints`, both idempotent. The per-image `toggleReprint`
is now reachable from both surfaces — the per-card FLAG button (fast
path) and the right-sidebar toggle (kept for parity, useful when the
operator is already in the preview reviewing the image).

ActionBar (`index.jsx`) and the REPRINTS StatBox now surface print
count alongside image count, but only when the two numbers differ
(so the common "N photos, 1 print each" case isn't cluttered):

  - ActionBar count line: `↺ 11 images flagged · 15 prints total`
  - Send button: `Send 11 images (15 prints) → JOB-r1`
  - StatBox subline (mono, faint): `15 prints` under the big "11"

For jobs where every flagged image is qty 1 the labels stay clean:
`Send 11 images → JOB-r1` and the StatBox subline is hidden.

### Behaviour change to flag for operators

The Send button no longer says "Send N Reprints" — it now says "Send N
images" with the print count in parens when it differs. The Send action
itself is unchanged: `reprintCreate` still filters on `img.reprint ===
true` and `createReprint` still copies from `/originals/`, builds the
new sidecar carrying per-image `qtyCurrent` and corrections, and names
the reprint job `{parentJobId}-r{n}`.

The bulk toggle does not auto-save — `isDirty` becomes true and the
existing Save / auto-save-on-close path handles persistence.

### Verification

Walked seven scenarios by hand:

  1. **12 photos, qty 1 each, flag all → send.** Button reads `Send 12
     images → JOB-r1`, REPRINTS stat shows `12` with no subline.
     `createReprint` receives all 12 images.
  2. **12 photos, #3 has qty 5, flag all then deselect #7.** Header
     shows `Flag remaining (1)` + `Clear`, count `11 / 12 flagged`.
     ActionBar reads `↺ 11 images flagged · 15 prints total`, button
     reads `Send 11 images (15 prints) → JOB-r1`, REPRINTS stat shows
     `11` with subline `15 prints`. `createReprint` receives 11 images;
     #3's reprint entry carries qty 5 via the existing per-image
     `qtyCurrent` carry-over in `reprintManager.js`.
  3. **Empty job (no images on disk).** Header hidden via the existing
     `images.length === 0` branch in `ThumbnailGrid`. ActionBar not
     rendered (existing `reprintImages.length === 0 && !lastSent`
     short-circuit).
  4. **Send a reprint, return to Review for a second round.** Parent
     flags cleared by existing `sendReprints` logic; `reprintCount`
     increments to 1. Header re-reads `Flag all for reprint`; next
     Send produces `JOB-r2`.
  5. **Mid-state qty change.** Operator flags all, then dials image
     #5 qty up from 1 to 3 in the right panel. ActionBar and StatBox
     subline recompute live to reflect the new print total.
  6. **"Reprint all except the first 3" workflow.** Click bulk
     `Flag all for reprint` (1 click). Click the red `REPRINT` badge
     on cards #1, #2, #3 in turn (3 clicks). Each click toggles the
     per-image flag and leaves the centre preview untouched. Total: 4
     clicks. Pre-fix this needed 12 thumb-clicks + 12 sidebar-toggles.
  7. **"Reprint just 3 manually" workflow.** Click the faint `FLAG`
     badge on cards #5, #8, #11. Total: 3 clicks, no preview switching.
     Pre-fix this was 6 actions (3 selects + 3 sidebar toggles).

---

## 2026-05-12 — "AI scoring…" indicator firing on pre-artwork jobs

### Background

Some products that arrive on the Jobs grid have no artwork to dispatch —
gift vouchers and other non-fulfillment items get sent through the same
pipeline by mistake from the storefront. When that happens the operator's
only correct action is **Dismiss**.

Pre-fix, the Jobs grid showed an "AI scoring…" caption on every such
row and rendered the Process / Assign buttons in the `pending` style with
a "Pending AI Quality check" tooltip. The caption was misleading (nothing
is actually being scored when there are zero images on disk) and made
operators reluctant to clear rows that should be cleared.

### Root cause

`isPendingAIQuality(job)` in `src/renderer/renderer.js` treated "no entry
in `aiQualityScoringStatusByJobId`" as **pending**, on the conservative
assumption that scoring might be about to start. But the IPC handler
`aiQuality:listHeldJobs` only publishes an entry once a job folder
exists on disk **with at least one image** (`total === 0 → continue` at
`ipc-handlers.js:2822`). So "no entry" actually means "no artwork to
score" — which is the case for non-fulfillment products and for any
'pending'-status job whose artwork hasn't downloaded yet.

### Fix

Flipped the "no entry" branch in `isPendingAIQuality` to return `false`
instead of `true` (`renderer.js:135`):

```diff
- if (!status) return true;
+ if (!status) return false;
```

The function body now matches `isAiQualityScoringInProgress`; both are
kept as separate named functions for call-site readability so a future
divergence in Process vs Dismiss gating policy can't accidentally
re-block dismissal of empty-artwork jobs. Doc comments on both functions
and the Dismiss-button block were rewritten to reflect the new semantic.

### Behaviour change to flag for operators

The "AI scoring…" caption no longer appears on rows where artwork has
not yet arrived. Process / Assign stay enabled per their normal routing
state (they were already disabled on these rows for unrelated reasons —
no route, no files — and that remains). The most visible change is that
gift voucher and abandoned-POS rows now look like ordinary actionable
rows and can be dismissed without confusion.

The gate still kicks in correctly once artwork is on disk and the
orchestrator starts scoring: the IPC pushes an entry with
`phase: 'scoring'` from the first sidecar write, both functions return
true, and Process / Dismiss disable as before until `phase: 'scored'`.

### Verification

Walked the predicate by hand against three representative job states:

  1. **Gift voucher, status 'received', no folder on disk** — IPC skips
     at `!fs.existsSync(jobPath)`, no entry in map, `isPendingAIQuality`
     now returns false. Indicator gone, Dismiss enabled.
  2. **POS print job, status 'received', folder exists, scoring in
     flight** — IPC returns `phase: 'scoring'`, both predicates true,
     Process and Dismiss disabled. Unchanged.
  3. **POS print job, status 'received', scoring complete** — IPC
     returns `phase: 'scored'`, both predicates false, all buttons
     enabled per routing/held state. Unchanged.

---

## 2026-04-30 — OHD check-in suppressed for upload-only installs

### Background

Multi-PC site deployments commonly split OHD work across two boxes:

  - **PC #1** runs the OrderHub polling loop, downloads artwork, and dispatches to print controllers.
  - **PC #2** runs only the Film Scan / File Upload watch folders (pushes scans to S3, doesn't touch orders).

Pre-fix, the `_checkIn()` function in `src/main/updater.js` was gated only on
`apiKey && organizationId` — both of which PC #2 has set (the same credentials
block holds S3 settings as well). So PC #2 would `POST {baseUrl}/checkin` once
on startup and again every 4 hours, registering itself as an online OHD
instance with its own `instance_id` and `machine_name`. The OrderHub admin
console then listed two OHDs for the site even though only one was actually
fulfilling order work.

### Fix

Added an early return at the top of `_checkIn()` (`updater.js:90`) that
checks `configService.get('pollingEnabled')` and returns immediately if it's
false. Upload-only deployments stop registering with OrderHub. Active
order-handling installs (the common case — single-PC site, polling on)
continue to check in unchanged.

```js
if (!configService.get('pollingEnabled')) {
  return;
}
```

### Behaviour change to flag for operators

Sites that intentionally run with `pollingEnabled: false` (whether
single-PC or split-PC) will see their OHD entry **disappear** from the
OrderHub admin console at the next 4-hour check-in cycle. This is
deliberate but worth communicating in release notes — "OHD has stopped
showing up in the admin list" reads like a regression otherwise.

Re-enabling polling restores the check-in on the next 4-hour cycle (or
immediately on app restart). No data loss, no orphan state.

### Related architecture note

For the split-PC deployment to work cleanly, PC #2's settings should be:

  - `pollingEnabled: false` (no order downloads, no check-in)
  - `filmScansEnabled: true` + `filmScansWatchFolder` set
  - `fileUploadsEnabled: true` + `fileUploadsWatchFolder` set if used
  - S3 credentials (shared with PC #1)
  - No print controllers configured

Both PCs have their own `userData` folder, their own `routing.json`, their
own AI Quality sidecars. Nothing is shared at the file-system level —
which is the right model: nothing to coordinate, nothing to corrupt. The
only operator discipline required is "don't flip `pollingEnabled` on
PC #2", which would put both boxes into an undefined-coordination state
where they'd both poll the same orders independently.

---

## 2026-04-30 — Darkroom Pro: blank `Media=` reaching customers + Assign not surfacing

### Symptom

Customer .txt files dispatched to Darkroom Pro hot folders showed `Media=`
blank (or sometimes the raw lowercase OHD option value, e.g. `Media=lustre`)
instead of the operator's translated paper-type string (e.g. `Media=Luster`).
Operators reported that the **Assign** button — which should surface when a
job's media can't be resolved — was failing to appear, so jobs auto-routed
silently with the wrong (or missing) Media value.

### Root cause

`resolveMedia()` in `src/main/services/darkroom-pro-output.js` had a raw-value
fallback at line 140:

```js
return translation ? translation.to : entry.value;  // raw fallback
```

When no entry in `mediaTranslations` matched the job's option value,
`resolveMedia` returned the option's raw value (e.g. `lustre`) rather than the
empty string. This had two compounding effects:

1. **Routing-time:** the routing-service unrouted-gate at
   `routing-service.js:218-231` is `mediaConfigured && !resolvedMedia` —
   the raw fallback returned a truthy value, so the gate never tripped.
   Operators never saw Assign for jobs whose media couldn't really be
   resolved (option-name mismatch, missing translation entry, etc.).

2. **Dispatch-time:** the pre-flight `if (!media) throw` validation at
   `darkroom-pro-output.js:215` was decorative — same fallback meant `media`
   was almost never empty when the option name *did* match. The throw fired
   only on the narrow case where the option name on the job didn't match
   `mediaOptionKey` AND the option carried an empty value. Other failure
   modes silently wrote `Media=lustre` (raw) to the customer file.

A secondary contributor: a controller could be saved with `mediaOptionKey`
empty *and* `mediaTranslations` populated. In that state the translations
were dead weight — `resolveMedia` short-circuits at line 129 (`if
(!mediaOptionKey ...) return ''`) before consulting the array — and dispatch
wrote `Media=` blank because the pre-flight is gated on `mediaConfigured`.

### Fix

Three coordinated changes, all backwards-compatible for properly-configured
controllers (`mediaOptionKey` set + matching translations defined):

| File | Change |
|---|---|
| `src/main/services/darkroom-pro-output.js:140` | `resolveMedia` strict — `return translation ? translation.to : '';` (was `: entry.value`). JSDoc rewritten to document the contract (empty-string return cases enumerated; rationale for *why* we don't fall back to the raw value). |
| `src/main/services/darkroom-pro-output.js:215-227` | Pre-flight error message expanded — now lists the job's option names and explicitly tells the operator the three remediation paths (add translation, fix Paper Type Option Key, or use Assign). |
| `src/renderer/renderer.js` (ocSaveBtn handler ~line 3853) | Save-time guard: refuses to save a darkroompro controller with `mediaTranslations.length > 0 && !mediaOptionKey`. Uses `setCustomValidity` on the option-key input so the operator sees a native browser validation message and the field gets focus. |
| `src/main/ipc-handlers.js` (`ohd:routing:save-controller` handler) | Server-side mirror of the same guard so a malformed IPC payload can't bypass the renderer. Returns `{success:false, error:msg}` and logs a warning at `[routing] save-controller rejected`. |
| `tools/onnx-export/_diagnostics/routing_logic_probe.js` | Scenario C flipped (raw fallback removed → must unroute). New Scenario D added covering the option-name mismatch case explicitly. |

### Verification

Logic probe extended (`tools/onnx-export/_diagnostics/routing_logic_probe.js`)
covering 4 scenarios across the strict media path: all assertions pass.

| Scenario | Pre-fix outcome | Post-fix outcome |
|---|---|---|
| A — translation matches | routes, `Media=Luster` | routes, `Media=Luster` |
| B — `mediaOptionKey` empty (size-alone) | routes, `Media=` blank | routes, `Media=` blank (unchanged — fixed-size product path) |
| C — `mediaOptionKey` set, no translations | routes, `Media=lustre` (raw fallback) | **unrouted → Assign surfaces** |
| D — option-name mismatch (underscore vs hyphen) | unrouted (option not found) | unrouted (unchanged — was already correct) |

### Operator-visible impact

Any controller currently relying on the raw fallback (mediaOptionKey set, no
translations defined, dispatch working) will start showing **Assign** on jobs
that previously auto-routed silently. The remediation is to add translation
entries via the Settings modal (or via Assign with the "save translation"
tickbox on). This is the *intended* operator workflow — silent dispatch with
guessed values was the bug.

The save-time guard prevents the secondary footgun: an operator can no
longer end up with translations defined but no Paper Type Option Key. The
combination produced silent `Media=` blank dispatches and was discoverable
only by reading the .txt file the customer received.

### Investigation note

Hours of debugging were spent looking at `config.json` instead of
`routing.json`. The routing system migrated to its own electron-store file
(`routing.json`, see `_store_migrated_v1` flag) — `config.json`'s legacy
`orderControllers` keys are dead bytes nobody reads but they mislead anyone
who opens the file thinking it's authoritative. Worth a future cleanup pass
to either zero those keys out or stamp them with a `_DEPRECATED_SEE_ROUTING_JSON`
marker.

---

## 2026-04-29 — v1.3.2 ship (integrity-quarantine pivot + size-handling fixes + auto-print gate + BOM defensive)

Six fixes shipped in v1.3.2, ordered roughly by impact: an architectural
pivot from the v1.3.0–v1.3.1 quarantine model to flag-and-allow; three
interlocking fixes around the wide-format size-handling + auto-print
retry-spam; an auto-print latent-gate bug surfaced by yesterday's pivot
that nearly blocked ship; and a UTF-8 BOM defensive read that surfaced
during dev when a `Set-Content -Encoding UTF8` bricked the app.

The integrity-quarantine pivot is the load-bearing change for customer
trust. The other five are quality-of-implementation fixes that compose
around it, several of which surfaced because of the investigation
discipline applied to a single ambiguous customer report.

> **Operating-model note:** Two patterns kept paying off this ship cycle.
> First, "investigate first, propose later" — the ambiguous wide-format
> report was a customer's wrong hypothesis (per-channel `printSizeCode`
> simplification) that, taken at face value, would have shipped a
> different fix that didn't address the actual problem. Phase 0
> investigation surfaced three unrelated bugs that explained the
> behavior; the customer's hypothesis was wrong but their report was
> still actionable. Second, "small reproducible empirical verification"
> — the integrity-quarantine pivot had a verification pass on 11
> on-disk fixture files that produced an unexpected finding (all 11
> scored cleanly, no graceful-fail invoked), strengthening the pivot's
> rationale beyond what we'd planned for. Worth recording both as the
> default approach for ambiguous-report and architectural-change work.

### Integrity-Quarantine Pivot to Flag-and-Allow

#### Customer impact

A real customer order with 8 magic-byte-flagged images: customer paid
for 133 prints, received 125. The 8 affected files lived as
`<filename>.quarantine` artifacts on disk with no operator-facing path
to surface them. **Real money lost; trust eroded.** The customer's
print operators had no way to know the missing prints were OHD-side
decisions rather than upstream order issues, so they couldn't even
triage. Each subsequent re-poll skipped the corrupt slots via the
sibling-quarantine guard, ensuring the lost prints stayed lost
permanently absent manual operator intervention.

#### Root cause: a model that was correct in isolation but wrong at the
system level

The v1.3.0 quarantine model was built defensively. The reasoning at the
time (see `docs/ai-quality-gate/conversion-audit.md` § "Production
Observation: Download-Side Corruption with Cached Size-Match"): real
files arriving from FTP have leading-zero corruption ~3% of the time;
they're unscoreable by MUSIQ; the print pipeline shouldn't process them
because they'd ship as garbage to the printer. Conclusion: rename them
to `.quarantine` so they're invisible to the print pipeline. Add a
manifest so an operator could in theory investigate.

That conclusion embedded a decision ("this file can't print") inside
the FTP layer, which had no operator-facing surface. The renderer's
Jobs grid never saw `.quarantine` artifacts because the renderer's
`IMAGE_EXTENSIONS` filter excluded them by accident. The per-order
manifest was a JSON file in the order folder that no operator ever
opened. The Activity Log saw the `[quarantine] Corrupt file
quarantined` line at error level once per file, then never again.
**Detection happened at the right time. Decision happened at the right
time. Surfacing didn't happen at all.**

The architectural failure: detection and decision were collapsed into a
single operation. OHD's job is to detect and surface; the decision
about whether to print belongs downstream — to the printer, to the
operator inspecting output, or to the customer reviewing what they
received. Pulling the decision into OHD made customers wait without a
remediation path.

#### Fix: flag-and-allow

Replaced the rename-and-hide model with a sidecar-flag model. New
`integritySuspect` block on the per-image sidecar entry carries
`{ detected, detectedAt, firstBytesHex, expectedMagic, ftpRemotePath }`.
File keeps its original `.jpg`/`.png` extension. Print pipeline attempts
the file normally. AI Quality scoring's existing graceful-fail path
handles unscoreable files (`score: 100, error: '...'`) cleanly. Whether
the file ultimately prints is decided downstream of OHD.

The migration is a one-shot startup sweep gated by a config flag
(`_integrityQuarantineMigratedAt`). For each `<filename>.quarantine` on
disk: rename back to original, copy any matching manifest entry's
diagnostic data into the per-image sidecar's new `integritySuspect`
block. Each `_ohd-quarantine.json` is renamed to
`_ohd-quarantine.archived.json` so the historical record survives but
no active code path matches the legacy filename. Crash-safe via
per-file atomic operations; the flag is set only after the walk
completes end-to-end.

| File | Change | LoC |
|------|--------|-----|
| `src/main/services/ftp-service.js` | `markIntegritySuspect()` replaces `moveToQuarantine()`; sibling-quarantine guard removed; `summary.quarantined` field dropped from toast | rewritten |
| `src/main/services/integrity-quarantine-migration.js` | New — `runIntegrityQuarantineMigration()` + pure `_migrate(dir, log)` worker | new |
| `src/main/index.js` | `await runIntegrityQuarantineMigration()` in `app.whenReady` before polling starts | +12 |
| `src/main/services/config-service.js` | `_integrityQuarantineMigratedAt` schema entry, `null \| string` | +5 |
| `src/shared/jobSchema.js` | `integritySuspect: null` field added to image entry as peer of `aiQuality` | +18 |
| `src/main/services/__tests__/integrity-quarantine-migration.test.js` | New — 3 tests covering with-manifest, idempotent re-run, no-manifest edge case | new |
| `src/main/services/__tests__/ftp-service.test.js` | Rewritten — drops rename-behavior tests, adds 6 `markIntegritySuspect` tests | rewritten |
| `src/main/services/__tests__/ai-job-quality-orchestrator.test.js` | Two tests reframed: `_scanJobImages` exclusion test refocused from `.quarantine` to general non-image; "quarantined files don't block phase=scored" → "graceful-fail entries don't block phase=scored" | edited |

#### Empirical verification — the surprise finding

Eleven `.quarantine` files existed on the dev machine pre-pivot (8 in
PXDEMO-06XZYZ_38412786, 3 in PXDEMO-4H4E9J_38412221) — direct on-disk
fixtures of the customer-impact scenario. Migration sweep restored all
11 in 73ms, populated their `integritySuspect` blocks from the legacy
manifests, archived both manifests.

Then the next polling cycle scored them. **All 11 scored cleanly via
real MUSIQ inference with values 59–67 — no graceful-fail path even
invoked.** Specifically: `score: 59.39, scoredAt: 2026-04-29T06:51:02,
error: null` for the first one, similar shape across all 11. The
"corrupt" files weren't unscoreable; they had partially-recoverable
JPEG payloads that sharp's `failOn: 'none'` decoded fine.

This was unexpected. The Phase-0 plan accounted for the graceful-fail
path being available; in practice the heuristic was over-rejecting at
a rate that, multiplied across the customer's job volume, represented
real money lost on files that would have printed normally if OHD
hadn't hidden them. The empirical result validates the pivot more
strongly than the plan anticipated.

#### Architectural lesson

**Magic-byte checks are signals, not ground truth.** Many files that
fail them are still valid downstream. The check is best treated as
"flag for operator awareness" rather than "exclude from processing."

The deeper pattern: **whenever a heuristic gates "process this further"
decisions, the cost of false-positives is paid by the operator/customer
at scale, while the cost of false-negatives is paid once at the layer
that exists to handle them.** Heuristics should inform decisions, not
make them. The flag-and-allow pattern lets the heuristic still inform
without letting it veto.

#### References

- Conversion-audit doc: `docs/ai-quality-gate/conversion-audit.md` §
  "Status: Pivot to Flag-and-Allow (v1.7)" — frames the legacy Phase-2
  quarantine narrative as historical-rejected-design and captures the
  same architectural lesson at the audit-doc level.
- Migration source: `src/main/services/integrity-quarantine-migration.js`.
- Sidecar shape change: `src/shared/jobSchema.js:62-78` — peer of
  `aiQuality`, default `null`.

### Bug A — `_mergeJobs` strips `_warningMessage` / `_errorMessage` on every poll

#### Customer report

Wide-format job showed "Unknown warning — check Activity Log" rather than the
specific message `polling-service.js` had set when the warning fired. The
generic fallback was the symptom; the actual message was being lost.

#### Root cause

`src/main/services/job-service.js:159-191` — `_mergeJobs()` runs on every
60-second API poll. It preserves a select few `_`-prefixed fields from
existing local job state when an API job arrives over the top:

```js
if (existing._status && existing._status !== 'pending') preserved._status = existing._status;
if (existing._dpofNotified)     preserved._dpofNotified     = existing._dpofNotified;
if (existing._darkroomProSize)  preserved._darkroomProSize  = existing._darkroomProSize;
if (existing._darkroomProMedia) preserved._darkroomProMedia = existing._darkroomProMedia;
```

`_warningMessage` and `_errorMessage` were not in the preserved list, so
they got spread away by the API job (which never carries those fields) on
poll 2. From poll 2 onward, the renderer's fallback at `renderer.js:694`
took over: `job._warningMessage || 'Unknown warning — check Activity Log'`.

Verified empirically against `jobs-cache.json` before fix: 11 jobs in
`_status: 'warning'`, all 11 with `_warningMessage: undefined`.

#### Fix

Coupled the message preservation to the existing status preservation
condition — if status survives the merge, the explanatory message goes
with it.

| File | Change |
|------|--------|
| `src/main/services/job-service.js:166-180` | `_warningMessage` and `_errorMessage` now preserved alongside `_status` when status is non-pending |

### Bug B-prep — Auto-print catch handler retry-spam (manifest-only special case)

#### Customer report

Not customer-reported. Surfaced during investigation when reading the live
log on the dev machine: `[auto-print] Folder copy failed for job
1641fbd0-75a1-4e11-aaff-f22bc3c0b479` was logging once per minute for the
entire app lifetime (`POS-FUN9N5`, missing order manifest). The job was
neither completing nor erroring out — silent retry loop.

#### Root cause

The DPOF dispatch catch at `src/main/ipc-handlers.js:1796` had a hardcoded
special case that only set `_status: 'error'` + `_errorMessage` for errors
whose message contained the literal substring "Order manifest not found".
Every other error class (and the entire folder-copy / process-folder catch
at lines 1757-1772) was logged-and-skipped, leaving the job in
`_status: 'received'`. The eligibility filter at line 1704
(`if (job._status !== 'received' && job._status !== 'pending') continue;`)
re-admitted those jobs on every subsequent auto-print cycle, throwing the
same error every time.

The special case was added in commit `10a6796` ("Fix: mark jobs as error
when manifest not found to prevent retry loop") — correct in isolation,
never generalised. Every error class outside that one string still
retry-looped silently.

POS-FUN9N5 is a folder-copy job whose manifest had been deleted (or
never written) on the dev machine. It hit the folder-copy catch (which
never had any special case at all), throwing the same manifest-not-found
once per minute since the dev session started. The folder-copy retry
loop confirmed the bug isn't DPOF-specific — it's an entire pattern of
"catch handler in a dispatch loop that doesn't propagate error to job
state" repeated at four sites.

#### Fix

Generalized all four sites to set `_status: 'error'` + `_errorMessage` from
the thrown / returned error message, no special-casing. The eligibility
filter then correctly excludes these jobs from future cycles, breaking the
retry loop for ALL error classes consistently.

| File | Change |
|------|--------|
| `src/main/ipc-handlers.js:1804-1820` | DPOF dispatch catch — generalized; carries the load-bearing rationale comment for future readers |
| `src/main/ipc-handlers.js:1822-1834` | DPOF `result.success === false` path — error propagated to job |
| `src/main/ipc-handlers.js:1761-1769` | Folder-copy / process-folder dispatch catch — same generalization |
| `src/main/ipc-handlers.js:1782-1789` | Folder-copy / process-folder `result.success === false` — same |

The rationale comment lives only at the DPOF dispatch catch (the most
prominent site, the one being de-special-cased). The other three sites
get the change without the long comment since they apply the same pattern.

### Bug B — Polling-service `hasMissingSize` check was over-broad

#### Customer report

The wide-format job's warning state. Customer's presenting hypothesis was
about per-channel `printSizeCode`; investigation showed the actual cause
was an empty per-image `size` field in the order manifest tripping a
receive-time check that was scoped wrong.

#### Root cause

`src/main/services/polling-service.js:177-208` rejected any job whose
manifest contained an image with empty `size`, regardless of where the
job would eventually route. But of the five controller types
(`folder_copy`, `pdf_copy`, `darkroompro`, `frontline`, DPOF
Noritsu/Epson), only DPOF actually reads per-image `size` in its output
generation. Wide-format folder-copy jobs (the customer's case) just
`fs.copyFileSync` the image bytes to the output folder — `img.size` is
never consulted.

So the receive-time check was rejecting jobs that would have completed
fine if they reached print. The DPOF case is correctly handled by a
second, scoped check at `src/main/services/print-service.js:236` — that
one is the canonical "missing size" guard, throws an operator-friendly
message, and now (via B-prep) propagates that message to the job's
`_errorMessage` cleanly.

#### Fix

Removed the receive-time check entirely. With B-prep in place, missing-size
DPOF jobs receive normally, fail at dispatch with a clear operator message,
and don't retry-spam. Non-DPOF jobs receive normally and complete normally.

| File | Change |
|------|--------|
| `src/main/services/polling-service.js:176-184` | `hasMissingSize` block (~25 lines) removed; replaced with a 7-line explanatory comment pointing future readers to the canonical check at `print-service.js:236` |
| `src/main/services/polling-service.js:1-2` | `fs` and `path` imports removed (no longer used after the block deletion) |

### Architectural lesson

**Catch handlers in dispatch loops must propagate error messages to job
state and flip status to `'error'` — uniformly, not selectively per error
type.** The eligibility filter does the right thing when status is
consistent; selective propagation is what creates retry loops.

The pre-fix shape was structurally fragile in two ways: (1) it required
adding a new special case every time a new error class needed retry
prevention, and (2) any error class that wasn't anticipated retried
silently forever. Generalization removes both gaps in one change.

The compose-effect across the three fixes is also worth recording. Fix A
preserves the message; B-prep produces the message; Fix B opens the
code path that emits the message in the first place. Each fix is
independently correct and has standalone value (A fixes "Unknown
warning" everywhere; B-prep fixes the retry-spam pattern across all
error classes; Fix B simplifies receive-time logic by deferring to a
later, properly-scoped check). Stacking them gives the operator the
full story: a missing-size DPOF job now produces, end-to-end, a
specific message that survives polls, displays in the UI, and doesn't
loop. Without any one of the three, the stack would be incomplete.

#### Verification

**Unit tests** — `npm test` baseline 48/48 → 56/56 (+8 new tests). Eight
new tests in `src/main/services/__tests__/ipc-handlers-auto-print.test.js`
exercise the generalized catch handler:

- Generic dispatch throw → `_status: 'error'` + `_errorMessage` from `err.message`
- Print-service:236 missing-size message propagates verbatim
- Manifest-not-found is no longer special-cased — same general path
- DPOF `result.success === false` propagates `result.error`
- Folder-copy catch propagates the error (POS-FUN9N5 regression case)
- Folder-copy `result.success === false` propagates
- Successful dispatch does NOT mark the job as error (negative case)
- Job already in `_status: 'error'` is excluded by eligibility filter

The auto-print test file requires extensive stubbing of ipc-handlers'
dependencies (electron + ~15 service modules); pattern follows existing
`stubModule` helper from the orchestrator + ftp-service tests, plus a
`Module.prototype.require` override for `electron` and `electron-store`.
The exposed `_runAutoPrint` test hook is documented inline at the
ipc-handlers `module.exports` site so future readers know why it's there.

`npm test` script also gained `--test-force-exit` because requiring
ipc-handlers transitively opens long-lived handles (winston log files,
electron-store fs watchers) that hold the event loop open after tests
complete; tests pass in ~250ms total but Node won't exit cleanly without
the flag.

**Live verification** on the dev session — restarted OHD with all three
fixes active and observed two full polling cycles:

- POS-FUN9N5 retry-spam: zero `[auto-print] Folder copy failed` lines
  since the restart. Pre-fix the same line repeated every 60s. The job's
  cache state shows `_status: 'error'` + `_errorMessage:
  "Order manifest not found: C:\\...\\POS-FUN9N5.json"` — full path
  preserved verbatim, no longer collapsed to the hardcoded
  "Manifest not found" string.
- Wide-format `PXDEMO-15VR66` no longer appears in the active polling
  output (filtered out by the warning-status eligibility gate, same as
  before). The receive-time check is gone, so future runs of the same
  scenario will receive cleanly and process via folder-copy.
- General error messages now persist across polls: `PXDEMO-AARTFH`
  shows `_errorMessage: "No product mapping found for product code
  '0808-cut-print'..."` after 10+ poll cycles (was being stripped
  pre-Fix-A).

#### Migration note

Existing jobs in `_status: 'warning'` from before Fix A landed remain in
that state — Fix A preserves what's there, doesn't heal stale state. On
the dev machine, 11 such ghost jobs exist (including the customer's
PXDEMO-15VR66-1) with `_warningMessage: undefined`. They're not actively
broken — operator can dismiss them via the existing Dismiss button — but
they won't transition out automatically since no code writes
`_status: 'warning'` anymore (the only writer was the receive-time check
removed in Fix B).

If field reports indicate the residual warning-state count is large
enough to warrant active migration, a future hotfix can add a one-shot
sweep at startup that resets `_status: 'warning'` jobs back to
`'pending'`. Not included in v1.3.2 — the dismiss button is sufficient
mitigation for the count we've seen.

The hardcoded "Manifest not found" message stamped on pre-fix error jobs
(13 on the dev machine) is also residual; Fix A preserves it, B-prep
generates the verbatim path-bearing message for any NEW such error, but
existing entries keep their truncated message. Same migration option
applies if needed.

### Auto-Print Latent Gate Bug (Surfaced by Yesterday's Pivot)

#### Customer report

Reported as a v1.3.2-candidate regression after B-prep + B2 landed and
the running build was tested in customer staging: fresh jobs arriving
via polling were sitting in `received` / `pending` without dispatching,
even when the destination controller had `autoprint: true`. Reported as
blocking the v1.3.2 ship.

#### Bisection narrative

User flagged three suspects: B-prep, B2, or yesterday's autoprint pivot
(the renderer `sendToPrint` removal that routed Darkroom Pro through the
auto-print loop for the first time). Static analysis ruled the first two
out:

- **B-prep ruled out.** The generalized catch handlers fire AFTER
  `printService.sendViaDPOFRouted` or `_sendViaFolderCopyRouted` is
  called. The regression manifested as silent skips BEFORE dispatch was
  attempted; B-prep's catches can't fire if dispatch is never reached.
  Verified by inspecting the live error-state jobs on the dev machine —
  all 13 had legitimate failure messages (manifest missing, no product
  mapping). No spurious "transient marked permanent" canaries.
- **B2 ruled out.** The change touched only `polling-service.js`'s
  receive-time logic. Cannot affect `runAutoPrint`'s controller-type
  gate.
- **Yesterday's pivot was the exposure vector**, but the actual bug was
  in `ipc-handlers.js:1789-1791` — pre-existing, latent, hidden behind
  the renderer's direct `sendToPrint` call until the pivot routed
  Darkroom Pro through the loop for the first time.

#### Root cause

The auto-print loop's controller-type gate at `ipc-handlers.js:1789-1791`
classified controllers as DPOF-or-not via negation:

```js
const isDpof = (ctrl.type || 'dpof') !== 'folder_copy';
if (isDpof && !route.channelNumber) continue;
```

This mis-classified every non-`folder_copy` controller as DPOF. But
`routing-service.js` returns `channelNumber: null` for THREE non-DPOF
types — `pdf_copy` (line 165), `darkroompro` (line 247), and `frontline`
(line 277). The gate silently skipped them.

| `controller.type` | `route.channelNumber` source | Pre-fix gate | Pre-fix outcome |
|---|---|---|---|
| `noritsu` (DPOF) / `epson` (DPOF) | real channel mapping | passes if mapping set | dispatch — correct |
| `folder_copy` | `null` (line 181) | `isDpof=false` | dispatch — correct |
| `pdf_copy` | `null` (line 165) | `isDpof=true`, channel null | **silently skipped** |
| `darkroompro` | `null` (line 247) | `isDpof=true`, channel null | **silently skipped** |
| `frontline` | `null` (line 277) | `isDpof=true`, channel null | **silently skipped** |

Pre-yesterday-pivot, Darkroom Pro auto-printed via a renderer-side
direct `sendToPrint` call in `openAssignModal`'s "Assign and Save"
handler — bypassing the auto-print loop entirely. The latent gate-bug
existed for years but was hidden by that bypass. Yesterday's pivot
correctly routed Darkroom Pro through the auto-print loop (so the
controller's `autoprint` flag becomes the single source of truth for
whether dispatch happens) — and the latent gate-bug was the price of
admission.

The dev machine didn't reproduce the regression because Darkroom is
`autoprint: false` there (the prior gate at line 1787 silently skips
first). Customer staging has Darkroom `autoprint: true`, exposing the
channelNumber gate.

#### Fix

Inverted the gate to enumerate DPOF types explicitly rather than enumerate
the one type to exclude:

```js
const DPOF_TYPES = new Set(['noritsu', 'epson', 'dpof']);
const isDpofCtrl = DPOF_TYPES.has(ctrl.type) || !ctrl.type;
if (isDpofCtrl && !route.channelNumber) continue;
```

`!ctrl.type` covers the legacy unset-type case (the original
`(ctrl.type || 'dpof')` fallback meant unset = DPOF; preserved for
backwards compatibility with any operator config from before the type
field existed). All five controller types are now classified explicitly.

| File | Change |
|------|--------|
| `src/main/ipc-handlers.js:1789-1804` | Gate inverted to enumerate DPOF types; carries the latent-regression note for future readers |

#### Verification

**Unit tests** — `npm test` 56 → 64 passing (+8). Eight new tests in
`src/main/services/__tests__/ipc-handlers-auto-print.test.js` exercise
the full truth table of the gate via a `dispatchReached(controllerType,
channelNumber)` helper: noritsu+42 dispatches, noritsu+null skipped,
epson+42 dispatches, untyped-legacy+null skipped, folder_copy+null
dispatches, pdf_copy+null dispatches, darkroompro+null dispatches (the
regression), frontline+null dispatches.

**Live verification on dev** — temporarily flipped Darkroom controller's
`autoprint` to `true` in `config.json` (BOM-safe via Node's
`JSON.stringify`, not PowerShell — see the v1.3.2 BOM-handling notes),
restarted OHD, watched the first auto-print cycle. Observed:

- `[auto-print] Dispatching job {"jobId":"38388942","controller":"Darkroom"}`
  followed by `[DarkroomPro] Order file written ...PXDEMO-DKERK1-1.txt`
  followed by `[auto-print] Job dispatched successfully {"jobId":"38388942","method":"darkroompro-routed"}`.
- Same pattern for jobs 38388943 and 38405717. Three Darkroom Pro jobs
  auto-printed within seconds of restart, with `.txt` files landing at
  the controller's output path.
- After verification, restored Darkroom to `autoprint: false` to keep
  the dev baseline aligned with the customer's pre-pivot expectation.

#### Architectural lesson

**Negation-based classification accumulates latent bugs as new types
are added.** The original gate `(ctrl.type || 'dpof') !== 'folder_copy'`
worked when there were two types (`folder_copy` and DPOF). Each
subsequent type added (`pdf_copy`, `darkroompro`, `frontline`) silently
inherited "is DPOF" semantics it didn't actually have. The bug stayed
hidden because each new type had its own separate dispatch path (the
renderer's direct `sendToPrint`) until yesterday's pivot consolidated
on the auto-print loop.

**Explicit enumeration is the correct pattern** for these gates.
`DPOF_TYPES = new Set(['noritsu', 'epson', 'dpof'])` makes the set
membership explicit and forces a deliberate decision when a sixth
controller type is added. The compile-time-ish review burden ("does the
new type belong in DPOF_TYPES?") replaces the runtime correctness burden
("did the negation accidentally include the new type?").

Same lesson applies to the `INTEGRITY_CHECK_EXTENSIONS` set at
`ftp-service.js:20` (introduced in v1.3.0 to fix the JSON-as-image
regression — see entries below) and the `IMAGE_EXTENSIONS` set in
`sidecarManager.js:34` and `originalsManager.js:65`. Codebase-wide
pattern when controller / file-type classification is involved: prefer
explicit allow-lists over negation-based exclusions.

#### Migration note

No data migration needed. Existing jobs in `_status: 'received'` that
were silently skipped by the pre-fix gate become eligible for auto-print
on the next polling cycle after the customer runs v1.3.2. If a job's
controller has `autoprint: false`, it stays `received` (correct — needs
manual operator action). If `autoprint: true`, it dispatches on the next
auto-print pass.

### UTF-8 BOM Defensive Read (config-service)

#### How it surfaced

During v1.3.2 development, a Phase-2 fix-up step set the
`_integrityQuarantineMigratedAt` flag in `config.json` via PowerShell
`Set-Content -Encoding UTF8`. PowerShell's UTF-8 encoder writes a
leading BOM by default. On the next app launch, electron-store's
underlying `conf` library called `JSON.parse` on the raw file contents
— which throws `SyntaxError: Unexpected token '﻿'` on a BOM. The app
crashed at `new ConfigService()` before `app.whenReady()` could fire,
leaving the operator with an Electron error dialog and no way to start
OHD until the BOM was manually removed.

PowerShell isn't unique here — Notepad, many Windows IDEs, and the
default `iconv` settings on some systems all emit UTF-8 with BOM. Any
customer who hand-edits `config.json` with a default Windows tool can
hit the same crash. This wasn't a hypothetical risk — it bit during
dev, and the dev fix was to manually rewrite the file via Node's
`UTF8Encoding(false)`. Customers don't have that workaround.

#### Fix

Pass a custom `deserialize` to electron-store's `Store` constructor
that strips a leading `﻿` if present, then defers to `JSON.parse`:

```js
deserialize: (raw) => {
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  return JSON.parse(raw);
},
```

Defensive only — invalid JSON still throws (the BOM strip doesn't
swallow real parse errors), and only the exact U+FEFF code point is
stripped, not arbitrary leading whitespace. The contract is "tolerate
the one specific Windows-editor footgun, fail loudly on everything
else."

| File | Change |
|------|--------|
| `src/main/services/config-service.js:305-321` | `deserialize` option added to `new Store({ schema, deserialize })` |
| `src/main/services/__tests__/config-service-bom.test.js` | New — 5 tests pin down: deserialize is passed; BOM-prefixed JSON parses; non-BOM JSON unchanged; invalid JSON still throws; leading whitespace ≠ BOM |

#### Architectural lesson

Defensive reads at integration boundaries (config files, network
payloads, FTP downloads) should tolerate the documented set of
real-world inputs the boundary actually sees, not the idealised set
the spec assumes. The BOM strip is the same pattern as the magic-byte
check in the integrity-quarantine pivot above — different layer,
different boundary, same lesson: be flexible about what you accept,
strict about what you reject.

---

## 2026-04-28 — Filename collision + translation sort + button gating

Three customer-reported bugs against v1.3.0, batched into one fix session.
The customer reported them as separate items in the same feedback message;
they touch independent subsystems and were fixed in chronological order
(highest-impact first). This entry covers all three under one heading
because they shared a single ship cycle.

> **Operating-model note:** This is the second batch of fixes against v1.3.0
> filed on 2026-04-28 (the first being the [modal UX + size-alone routing]
> entry below). The pattern is recurring — ship a release, hear field
> reports back from the customer site within hours/days, batch-fix and
> re-ship. Worth recording as the working cadence for OHD: feature releases
> run through the AI-Quality-Gate-style multi-phase brief, but bug-fix
> batches like this one move faster (single brief, three fixes, one doc
> entry, one re-ship) because the scope per bug is tightly defined.

### Bug 3 — Darkroom Pro filename collision (silent data loss)

#### Customer report

When multiple jobs from the same OrderHub order are dispatched to the same
Darkroom Pro controller, only the *last* job's `.txt` lands in the output
folder — the earlier jobs' files are overwritten. Customer noticed prints
were missing from multi-job orders but didn't connect it back to OHD;
diagnosis surfaced when an operator inspected the Darkroom output folder
and saw a single file where multiple were expected.

This had been silently destructive in the wild. Any customer running
multi-job orders against a Darkroom Pro controller had been losing all
but the last job's output. Single-job orders weren't affected (only one
file ever gets written, no collision).

#### Root cause

`src/main/services/print-service.js:807` constructed `dpJob.orderRef =
job.order_number`. The downstream writer at `src/main/services/darkroom-pro-output.js:250`
built the filename as `${job.orderRef}.txt`. Because every job in an order
shares the same `order_number`, the filename was identical across jobs,
and `fs.promises.writeFile` happily overwrote.

#### Fix

Added an explicit `outputFilenameStem` field to the `dpJob` object,
preferring `job.job_name` (matches the JOB NO column in the Jobs grid,
e.g. `PXDEMO-9V0L91-1`) and falling back to a stable composite
`${order_number}_${id}` when `job_name` isn't set. The writer reads
`outputFilenameStem` with `orderRef` as a back-compat fallback for any
caller that hasn't migrated.

`orderRef` itself is **unchanged** — it's still used inside the .txt body
for `ExtOrderNum=` and `Orderid=` fields, which correctly identify the
customer's *order*, not the per-job file. Conceptually: order-level vs
job-level identity were conflated in a single field; the fix splits them.

| File | Change |
|------|--------|
| `src/main/services/print-service.js:807-815` | New `outputFilenameStem` field on `dpJob`; comment explains rationale |
| `src/main/services/darkroom-pro-output.js:248-258` | Filename built from `outputFilenameStem ?? orderRef`; `logger.info` extended to log `filename` for debugging |

#### Verification

`tools/onnx-export/_diagnostics/filename_collision_probe.js` (gitignored,
retained for regression testing) — synthesizes two jobs from the same
`order_number` with distinct `outputFilenameStem` values plus a third
legacy-shaped job without the stem, calls `generateDarkroomProFile`
directly against a temp output folder, asserts:

- Two distinct files are written: `PXDEMO-9V0L91-1.txt`, `PXDEMO-9V0L91-2.txt`
- File 1 contents include `img1.jpg`, do **not** include `img2.jpg` (no overwrite)
- File 2 contents include `img2.jpg`, do **not** include `img1.jpg` (no overwrite)
- Both files contain `ExtOrderNum=PXDEMO-9V0L91` (order-level field correctly stays at order_number)
- Legacy job without `outputFilenameStem` falls back to `${orderRef}.txt`

All assertions pass. `npm test` 36/36 unchanged.

#### Migration note

No upgrade migration needed. Existing single-job orders continue to behave
identically post-fix because `outputFilenameStem` (which equals `job_name`
for typical orders) happens to equal the previous `${orderRef}` value
plus a `-1` suffix on the rare jobs that already carried a sequence label.
For customers with multi-job orders, the fix is retroactive: their next
multi-job order writes correctly. Earlier orders that already lost data
are not recoverable through this fix — the data was overwritten at write
time, not lost on read.

### Bug 1 — Size/Media translations display in insertion order

#### Customer report

The Size Translations list in the Darkroom Pro controller settings modal
shows entries in the order they were added (`0808-cut-print` before
`0406-cut-print` if `0808` was added first). Operators want predictable
alphanumeric scanning; insertion order is meaningless to them.

#### Root cause

`src/renderer/renderer.js:3019-3033`'s `renderSizeTranslations` and
`renderMediaTranslations` iterated their input arrays as-passed. The
arrays come from `controller.sizeTranslations` / `controller.mediaTranslations`
which are persisted by `controllers:updateDarkroomTranslations`
(`src/main/services/ipc-handlers.js:1014-1025`) using `Array.prototype.push` —
strict insertion order. No bug; it was the un-considered default.

#### Fix

Sort on **display only**. The persisted arrays stay in insertion order —
no writes on render, no migration. Customer's existing on-disk data
renders sorted automatically the next time they open the modal.

```js
const sorted = [...(translations || [])].sort((a, b) =>
  (a.productCodePrefix || '').localeCompare(
    b.productCodePrefix || '',
    undefined,
    { numeric: true, sensitivity: 'base' },
  ),
);
```

Two defensive details in the comparator that matter:

1. **Spread before sort.** `[...arr].sort()` works on a fresh array; `arr.sort()` mutates in place. The persisted controller cache shouldn't see render-time ordering side-effects, so spread first.
2. **`numeric: true` is load-bearing.** Without it `localeCompare` runs lexicographically and `"10"` sorts before `"2"`. With it, the comparator handles embedded digit runs as numbers — `0406-cut-print` < `0808-cut-print` < `1212-cut-print` as operators expect. Pure-alpha values (`lustre`, `matte`) still sort correctly because the flag is a no-op when no digit runs are present.

`renderMediaTranslations` mirrors the same shape, sorting on `from`.

| File | Change |
|------|--------|
| `src/renderer/renderer.js:3019-3050` | Spread-then-sort with `localeCompare` + `numeric: true` flag for both translation lists; inline comments flag display-only-sort intent |

#### Verification

Comparator behaviour confirmed programmatically against the customer's
exact case plus typical adjacent patterns:

| Input | Sorted output |
|-------|---------------|
| `["0808-cut-print", "0406-cut-print"]` | `["0406-cut-print", "0808-cut-print"]` ✓ customer's case |
| `["1212-cut-print", "0406-cut-print"]` | `["0406-cut-print", "1212-cut-print"]` ✓ |
| `["lustre", "matte"]` | `["lustre", "matte"]` ✓ alpha media |
| `["8x10", "4x6"]` | `["4x6", "8x10"]` ✓ size-string fallback |

`npm test` 36/36 unchanged (pure renderer change).

### Bug 2 — Action buttons should disable while AI Quality is scoring

#### Customer report

When the AI Quality Gate is enabled, jobs in the grid that haven't yet
been scored show clickable Process / Assign / Dismiss buttons. Operators
can act on a job before the gate has evaluated it, bypassing the held-job
review the gate is supposed to provide. Buttons should be disabled while
scoring is in progress and re-enable only when all the job's images have
a verdict (regardless of pass/fail — the gate's verdict drives the
held-state badge separately, not button availability).

#### Root cause

The renderer had no signal at all for "scoring is in progress for this
job." The existing `aiQualityHeldByJobId` map (populated from
`aiQuality:listHeldJobs`) only carried jobs with `failedImages > 0` — fully
scored AND held. A job mid-scoring was indistinguishable in renderer
state from a job fully scored and passing (both absent from the map),
which was indistinguishable from a job whose feature flag is off (also
absent).

The orchestrator scores synchronously inside `runAutoPrint` at the top of
the loop (`src/main/services/ipc-handlers.js:1704-1736`). For a fresh
job, scoring takes ~700ms per image × N images, so the scoring phase is
short but real — and operators on a fresh test order could absolutely
click Process during it.

#### Fix

Backend: extended `aiQuality:listHeldJobs` to emit per-job scoring status
for **every** received/pending job (not just held ones), with new fields
`scoredCount` and `phase: 'scoring' | 'scored'`. The handler already walked
the same job list and called `getJobQuality` per job; the change just
removes the `failedImages > 0` pre-filter and adds two derived fields.
One IPC roundtrip serves two consumers.

Renderer:

- New `aiQualityScoringStatusByJobId` Map alongside the existing
  `aiQualityHeldByJobId`. Both populated from the same IPC response.
- `aiQualityEnabledCached` boolean refreshed at the same trigger; allows
  `isPendingAIQuality(job)` to short-circuit cheaply per row.
- `refreshAiQualityHeldJobs` renamed to `refreshAiQualityJobState` (with
  a back-compat alias since multiple call sites use the old name).
- New `isPendingAIQuality(job)` helper:

```js
function isPendingAIQuality(job) {
  if (!aiQualityEnabledCached) return false;
  if (job._status !== 'received' && job._status !== 'pending') return false;
  const status = aiQualityScoringStatusByJobId.get(String(job.id));
  if (!status) return true;          // no sidecar yet — pending
  return status.phase === 'scoring';
}
```

Applied to button branches at `renderer.js:548-654`:

| Button | Gate? | Reason |
|--------|------:|--------|
| Process | ✓ | dispatch action — must wait for verdict |
| Assign | ✓ | establishes a route which auto-print may immediately consume |
| **Dismiss** | ✓ | **Design intent worth recording: a mid-scoring dismiss could orphan a sidecar update mid-write, leaving operators unsure whether a flagged image was caught before the dismiss took effect. Future engineers seeing a Dismiss-disabled UI should not assume it's accidental — the gate is intentional.** |
| DPOF status actions (Resend, Retry, Mark Printed) | ✓ | post-dispatch but still order-affecting |
| Restore (dismissed-tab) | ✗ | dismissed jobs are by definition past scoring |
| Processed (completed) | ✗ | already disabled, post-scoring |
| In-production status | ✗ | already dispatched |
| **Review** | ✗ | **always enabled** — operators can inspect a mid-scoring job to see partial state |

Disabled state: native `disabled` attribute + `pending` CSS class
(`#c2c9d1` background, `cursor: not-allowed`, `opacity: 0.85`) + tooltip
`title="Pending AI Quality check"`.

| File | Change |
|------|--------|
| `src/main/services/ipc-handlers.js:2399-2473` | `aiQuality:listHeldJobs` IPC contract extended; doc-comment expanded to document the dual-purpose return shape |
| `src/renderer/renderer.js:40-105` | Two new state Maps + cached flag + `refreshAiQualityJobState` + `isPendingAIQuality` + back-compat alias for the old refresh name |
| `src/renderer/renderer.js:548-654` | `maybeDisable(btnHtml)` helper applied to every gate-able button branch; row template flow unchanged |
| `src/renderer/styles.css` | `.btn-action.pending` and `.btn-dismiss.pending` selectors with disabled-button visual treatment |

#### Verification

`isPendingAIQuality` exercised against 9 documented edge cases —
all 9 produce the expected true/false:

```
✓ feature off, any state              → false
✓ feature off, has scoring            → false
✓ completed, ignore feature           → false
✓ in_production, ignore               → false
✓ received, no entry                  → true   (files-not-local case)
✓ received, partial scoring           → true
✓ received, fully scored              → false
✓ pending, no entry                   → true
✓ pending, scored                     → false
```

`npm test` 36/36 unchanged (renderer + IPC changes; no new tests added,
existing orchestrator/store test fixtures untouched).

### Combined customer impact

Pre-fix:
- Multi-job orders silently lost the second-and-onward jobs' Darkroom output (Bug 3)
- Operators couldn't predict where a translation entry would appear after editing (Bug 1)
- Fast-fingered operators could bypass the AI Quality Gate on fresh jobs (Bug 2)

Post-fix all three are resolved with no upgrade-time migration cost. Bugs 1 and 2 are renderer-only fixes — visible immediately on next OHD launch. Bug 3 is in print-service / darkroom-pro-output and starts working on the next dispatched job.

---

## 2026-04-28 — Darkroom Pro assign-and-save bypassed Auto Print flag

> Documented retrospectively. The fix shipped earlier today as the third
> phase of the modal-UX-and-routing session below; its Phase-3 doc-update
> step was skipped when the conversation pivoted to the v1.3.0 release
> build immediately after Phase-2 verification. Recording it here now so
> the architectural lesson isn't only visible in source-comments and the
> conversation transcript. Chronologically this entry sits between the
> modal-UX/size-alone-routing fix below and the
> filename/translation/button-gating batch above.

### Customer report

Operator reported: an unrouted job comes in (no existing channel mapping
for its product code/options). Operator clicks Assign, fills in the size
translation (e.g. `0406-cut-print → 4x6`), hits Save. The job dispatches
to print **immediately** — even when the destination Darkroom Pro
controller has Auto Print = off.

Expected behaviour: after Save the job should become *routable* (channel
mapping established / per-job override stored) but only dispatch when the
controller's `autoprint` flag is true. With `autoprint=false`, the job
should sit in the grid waiting for a manual Process click. The operator's
Auto-Print preference was being silently ignored on this code path —
real consequences for sites that print without manual review at the
controller's default settings.

The customer's framing was specific and correct: the auto-print loop's
gate works correctly for DPOF jobs that auto-route via existing channel
mappings; the bypass is in the assign-and-save handler path.

### Root cause

The Assign-modal Save handler (`src/renderer/renderer.js`, around line
1140-1240 in the Darkroom Pro branch) ran three IPCs in sequence:

1. `updateDarkroomTranslations` — persists the translation table on the
   controller.
2. `assignDarkroomSizeMedia` — stores per-job `_darkroomProSize` /
   `_darkroomProMedia` overrides.
3. **`sendToPrint(jobId)` — direct dispatch.**

Step 3 was the bypass. The `jobs:sendToPrint` IPC handler at
`src/main/services/ipc-handlers.js:386-460` has no `ctrl.autoprint`
gate — it's the manual-Process-button code path, where unconditional
dispatch is correct (operator's explicit click should always dispatch).
The Assign-modal handler was reusing it for the post-Save dispatch,
which incorrectly inherited the unconditional semantics.

The DPOF flow on the same modal handler does NOT have this bug. Its
Save IPC `saveChannelMapping` (at `ipc-handlers.js:948-957`) already
fires `runAutoPrint().catch(...)` as a fire-and-forget tail action.
The auto-print loop then iterates received/pending jobs, applies the
gate at `ipc-handlers.js:1779`:

```js
const ctrl = controllers.find(c => c.id === route.controllerId);
if (!ctrl || !ctrl.autoprint) continue;
```

…and dispatches only when the flag is on. The Darkroom Pro path was
short-circuiting this whole flow.

### Fix (Option A — mirror the DPOF flow's architecture)

Two small changes that together restore the gate:

1. **Renderer: drop the direct dispatch.** Remove the
   `await window.electronAPI.sendToPrint(jobId)` call from the Darkroom
   Pro Save handler. The handler now does step 1 + step 2 + UI cleanup;
   no step 3.
2. **Backend: tail-fire `runAutoPrint` after persistence.** Add
   `runAutoPrint().catch(...)` to the tail of the
   `jobs:assignDarkroomSizeMedia` IPC handler. Mirrors the DPOF
   `saveChannelMapping`'s pattern exactly.

Result: after Save, the auto-print loop runs once. If `ctrl.autoprint`
is true, the loop dispatches within ~one tick (effectively immediate,
indistinguishable from the previous direct-dispatch behaviour). If
false, the job sits routable-but-undispatched until a manual Process
click — matching the operator's preference.

| File | Change |
|------|--------|
| `src/renderer/renderer.js` (Darkroom Pro branch of the Save handler) | Removed the `sendToPrint(jobId)` step; updated the success toast from "Darkroom Pro job sent to output folder" to "Darkroom Pro assignment saved" (honest about what just happened — persistence, not necessarily dispatch); inline comment explains the new contract |
| `src/main/services/ipc-handlers.js:983-1006` (`jobs:assignDarkroomSizeMedia`) | New `runAutoPrint().catch(...)` at the handler tail with comment cross-referencing the autoprint gate at `ipc-handlers.js:1779` |

The renderer `Cancel` / Save button click handlers and the existing
`onJobsUpdated` / route refresh all kept working unchanged. The
`_autoPrintRunning` re-entrancy guard in `runAutoPrint` already handles
back-to-back invocations safely.

### Architectural lesson

> The auto-print loop's `if (!ctrl.autoprint) continue` check at
> `ipc-handlers.js:1779` is the **single source of truth** for whether
> the autoprint flag is honored. Direct dispatch from the renderer
> (calling `sendToPrint` or any equivalent dispatch IPC) bypasses it.
>
> Future code that introduces dispatch behaviour should
> **hook `runAutoPrint()`** rather than calling dispatch IPCs directly,
> unless the use case is explicitly *"operator clicked Process — dispatch
> unconditionally"* (the manual-Process button is the only such case
> today).

This lesson is also recorded as a comment on the new
`runAutoPrint().catch(...)` call in `assignDarkroomSizeMedia` so anyone
removing or refactoring that line trips over the rationale.

### Verification

- **`npm test`: 36/36 pass** — no regression. Tests don't exercise the
  IPC handler chain directly (the orchestrator tests stub away the
  storage layer), but they do exercise everything around it.
- **OHD launched cleanly** on the fixed code; no startup errors related
  to the modified handlers.
- **Manual workflow verified per the Phase-2 brief of the original
  session** (operator confirmed visually):
    - autoprint=false: unrouted job → Assign → Save → modal closes,
      channel mapping persisted, job becomes routable but does NOT
      dispatch; manual Process click then dispatches normally.
    - autoprint=true: same workflow → modal closes, auto-print loop
      picks up the now-routable job within its next tick, dispatches.
- **DPOF regression check:** the DPOF assign-and-save path (which was
  always correct) confirmed unchanged — same behaviour both before and
  after the fix for both autoprint settings.

---

## 2026-04-28 — Darkroom Pro modal UX + size-alone routing

### Customer report

When a Darkroom Pro controller has a size translation defined (e.g.
`0406-cut-print → 4x6`) and the operator manually assigns it for a new job,
the assignment is saved (visible in the controller settings modal) — but
when ANOTHER job arrives with the same product code, OHD prompts to assign
again instead of auto-routing.

Two distinct issues surfaced during the diagnostic walkthrough:

1. The Darkroom Pro Order Controller settings modal had broken UX — long
   forms (Size Translations + Media Translations + various other fields)
   exceeded the viewport with no internal scroll, no × close button, no
   backdrop dismiss, and no Escape-key dismiss. Operators couldn't reach
   Save / Cancel on a long form, and the only way to dismiss without
   saving was a Cancel click that they couldn't always see.

2. The routing logic at `routing-service.js:224` required BOTH a size
   translation AND a media translation match for a Darkroom Pro job to
   auto-route. For fixed-size products (e.g. cut prints where the product
   code IS the size), customers don't need a media translation at all —
   but the strict-AND check would always declare the job unrouted, prompt
   for assignment, and behave as if the saved size translation didn't
   exist.

### Modal UX fix

Applied across all three `.pm-modal-overlay` instances —
`orderControllerModal`, `channelMappingModal`, `assignChannelModal` — at the
shared CSS class level so the fix can't drift across copies.

| File | Change |
|------|--------|
| `src/renderer/styles.css` | `.pm-modal` gets `max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; position: relative`. New `.pm-modal-close` rule for the × button — top-right of modal, transparent background, `#5d6d7e` text, `#edf2f7` hover, `#4299e1` focus outline. `.pm-modal h3` gets `padding-right: 28px` so the heading text doesn't collide with the × button. |
| `src/renderer/index.html` | `<button type="button" class="pm-modal-close" aria-label="Close">×</button>` added inside three `.pm-modal` containers, immediately above each `<h3>`. Each occurrence comment-flagged: `<!-- × close — wired by wirePmModalDismiss() in renderer.js -->`. |
| `src/renderer/renderer.js` | New `wirePmModalDismiss()` helper above the `DOMContentLoaded` startup block. Wires three behaviours per `.pm-modal-overlay`: backdrop click via `e.target === overlay` guard (clicks inside `.pm-modal` don't dismiss); × close via `querySelector('.pm-modal-close')`; document-level Escape keydown listener that hides any non-`.hidden` `.pm-modal-overlay`. Called once at startup as the first line inside `DOMContentLoaded`. |

Existing `Cancel` / `Save` button click handlers (`ocCancelBtn`, `ocSaveBtn`)
are untouched — they continue to add `.hidden` themselves and work alongside
the new dismiss helper. Conflict check: searched the codebase for other
`Escape` handlers; the only other one is scoped to a specific input element
(`newProcessTypeName` at `renderer.js:3644`), so the global listener doesn't
collide.

The basic-scroll-fix path was chosen over a sticky-header/sticky-footer
restructure: form-groups are direct children of `.pm-modal` with no
`.pm-modal-body` wrapper, so the polished version would require markup
changes in three modals. The minimum-to-unblock approach is sufficient
for the operator's reported workflow.

### Routing logic fix

| File | Change |
|------|--------|
| `src/main/services/routing-service.js:218-231` | Routing-time gate: introduces `mediaConfigured = !!controller.mediaOptionKey`. The unrouted check is now `if (!resolvedSize \|\| (mediaConfigured && !resolvedMedia))`. Inline comment: *"Media translation is only required when the controller has mediaOptionKey configured. For fixed-size products without media variation (e.g., cut prints where the product code IS the size), size-alone routing is sufficient."* |
| `src/main/services/darkroom-pro-output.js:178-198` | Pre-flight validation now wrapped in `if (mediaConfigured) { ... }`. When the controller has no `mediaOptionKey`, the per-line-item media check doesn't fire. Comment cross-references the routing-time gate. |
| `src/main/services/darkroom-pro-output.js:215-220` | Comment block above the line-item Media write explaining that `Media=` will be emitted with an empty value when no `mediaOptionKey` is configured (preserves the line count in the file format; the customer's Darkroom Pro setup is presumed to ignore Media for fixed-size products). |

**Backward compatible.** Controllers with `mediaOptionKey` set retain the
strict size+media requirement. Only the path where `mediaOptionKey` is
empty is newly permissive. Existing setups (the customer's "Darkroom"
controller has `mediaOptionKey: "finish-options"` set) continue to behave
exactly as before until the operator chooses to clear the field.

### Operator's choice — Path A vs Path B

The fix exposes two equivalent ways to handle a fixed-size product mix:

**Path A — single controller, clear `mediaOptionKey`.** Suitable when ALL
products dispatched to this controller are fixed-size (cut prints, etc.).
Operator clears the `mediaOptionKey` field in the controller settings
modal, saves, and every job auto-routes on size translation alone. The
written `.txt` file emits `Media=` with an empty value.

**Path B — separate controllers per product mix.** Suitable when the
controller dispatches a mix of fixed-size and media-variable products.
Operator creates a second Darkroom Pro controller for fixed-size products
(no `mediaOptionKey`) and routes those products to it via the routing
table; the original controller (with `mediaOptionKey` set) keeps handling
media-variable products under the strict check. Each controller's
output-folder configuration is independent.

Path A is simpler if the product mix is uniform. Path B is cleaner if the
two product classes have meaningfully different downstream handling at
the Darkroom Pro side. The fix supports either.

### Verification

| Check | Result |
|-------|--------|
| Modal UX visual sanity (all six tests: scroll, ×, backdrop, Escape, Cancel still works, Save still works) | ✓ pass |
| `npm test` — full unit suite | 36/36 pass, no regressions |
| Logic probe `tools/onnx-export/_diagnostics/routing_logic_probe.js` covering 7 scenarios across `mediaOptionKey` set/unset and various job-options shapes | All assertions pass |
| Customer's reported workflow end-to-end (test order with `0406-cut-print`, observe auto-route on second occurrence) | ✓ verified per Phase 2 sign-off |

### Test fixtures retained

`tools/onnx-export/_diagnostics/routing_logic_probe.js` — read-only logic
probe that exercises the size+media routing decision against synthesized
controller configs. Run before any future change to `routing-service.js`'s
darkroom-pro routing branch or `darkroom-pro-output.js`'s `resolveMedia`
helper. Can also be extended with new scenarios as edge cases surface.
