# Darkroom Pro — media translations lock the controller

**Status:** analysis + plan, 2026-08-13. Nothing built.
**Trigger:** a newly onboarded lab uses a Darkroom Pro controller and does **not**
use Finish Options. Their controller now rejects every save — Settings edits
(including the auto-print tick) and `Save & Assign` on jobs both fail with:

> *Paper Type Option Key is required when Media Translations are defined.
> Either set the option key on the controller or clear the translations.*

---

## 1. The state the controller is stuck in

A guard added on 2026-04-30 says: a `darkroompro` controller with
`mediaTranslations.length > 0` and a blank `mediaOptionKey` is misconfigured by
construction, because `resolveMedia` short-circuits on the empty key
(`darkroom-pro-output.js:139`) before it ever consults the translations array.
The reasoning is sound — the rows are unreachable, and the customer-visible
failure is a dispatched `.txt` with `Media=` blank.

The guard is enforced in two places:

| Layer | Location |
|---|---|
| Renderer, controller modal save | `renderer.js:5670-5680` |
| IPC, defence-in-depth mirror | `ipc-handlers.js:1057-1073` |

**But a third write path creates exactly that state and runs neither check.**

`controllers:updateDarkroomTranslations` (`ipc-handlers.js:1553-1605`) is the
back door the Assign modal uses for the *"Save media translation for future
orders"* tick. It pushes onto `controller.mediaTranslations` and calls
`routingService.saveController(controller)` directly at `:1591`. No key check.

So the app can write a state it will subsequently refuse to accept. Once a
controller is in it, it is **frozen** — nothing about it can be changed until
the translation rows are deleted by hand.

## 2. Why the job assignment also fails

This is the part that makes it look unrelated to configuration.

The Darkroom Pro branch of `Save & Assign` does this, in order
(`renderer.js:1959-2000`):

1. `_collectAssignModalIgnore()` → `reconcileControllerIgnore(...)`
   — persists the per-option **Ignore** ticks by re-saving the **whole
   controller** through `saveOrderController` (`renderer.js:1578`).
2. Optionally save size/media translations.
3. `assignDarkroomSizeMedia(jobId, size, media)` — the actual assignment.

Step 1 re-sends the entire controller object, so it hits the guard, so it
returns `{success:false}`, so `reconcileControllerIgnore` throws
(`renderer.js:1579`), so steps 2 and 3 **never run**. The operator sees a
controller-configuration error while performing a per-job action, and the
assignment is silently abandoned.

`reconcileControllerIgnore` returns early when nothing changed
(`renderer.js:1573`), which is why the failure is intermittent: `Save & Assign`
works fine until the operator touches an Ignore checkbox.

## 3. How a lab with no Finish Options got media translations at all

The Assign modal resolves the media value for display like this
(`renderer.js:1696-1715`):

```js
if (mediaOptionKey) {
  mediaOptionEntry = jobOptions.find(o => o.name?.toLowerCase() === mediaOptionKey.toLowerCase());
}
// Fall back to first option when key not configured or not found on job
if (!mediaOptionEntry && jobOptions.length > 0) {
  mediaOptionEntry = jobOptions[0];
}
```

**The fallback to `jobOptions[0]` is the defect.** For a lab that does not use
Finish Options there is no paper-type option at all, so `jobOptions[0]` is
whatever happens to be first — on the reported jobs, `layout-options: full bleed`.

`modal.dataset.dpMediaFrom` is then set from that option's *value*
(`renderer.js:1750`), and if the operator types a media value and ticks *"Save
media translation for future orders"*, the app persists:

```
{ from: "full bleed", to: "Luster" }
```

into the paper-type table — keyed on a layout option, with `mediaOptionKey`
still blank. The controller is now frozen, and on the next job the same
fallback matches that row and the modal cheerfully reports **"Media: Luster"**
for a product whose media was never specified.

Three separate wrongs compound here: a guessed option, a translation saved
against it, and a lock created as a side effect.

## 4. What the correct configuration looks like

For this customer: **no Paper Type Option Key, no Media Translation rows.**

`mediaConfigured` is derived from `!!controller.mediaOptionKey` in both the
routing gate (`routing-service.js:394`) and the dispatch-time writer
(`darkroom-pro-output.js:206`). With it blank, media validation is skipped
end to end and `Media=` is written empty — the documented, intended setup for a
lab with no media variation (`darkroom-pro-output.js:201-205`). Jobs then route
on size translations alone.

**Immediate recovery, no code change:** Settings → Routing → the Darkroom Pro
controller → delete every Media Translation row with the red `×`
(`renderer.js` `addMediaTranslationRow`) → leave Paper Type Option Key blank →
Save. Clearing the key alone is not enough; the guard fires on the rows.

## 5. Plan

Four fixes. M1 and M2 stop it recurring; M3 stops an unrelated failure from
eating a job assignment; M4 makes the existing stuck state recoverable without
hand-deleting rows.

### M1 — Close the back door

`controllers:updateDarkroomTranslations` must refuse a `mediaTranslation` when
the controller's `mediaOptionKey` is blank, returning
`{success:false, error}` with a message that names the real remedy (set the
option key on the controller first). A `sizeTranslation` in the same call is
unaffected and should still be applied — size and media are independent.

Rationale: a rule enforced by two of three write paths is not a rule. This is
the same class of defect as the CSV import that reported success without
saving.

### M2 — Stop inventing a media option

Remove the `jobOptions[0]` fallback from the **save** path. Options:

- **(a) Recommended.** Keep the fallback for the *hint text only*, and set
  `modal.dataset.dpMediaFrom` to `''` when the entry did not come from a real
  `mediaOptionKey` match. With no `from`, `updateDarkroomTranslations` already
  skips the media translation (`ipc-handlers.js:1579` requires
  `mediaTranslation.from`), so the tick becomes a no-op instead of a
  data-corrupting write — but the tick must then be **hidden or disabled**, not
  silently ignored.
- **(b)** Remove the fallback entirely. Simpler, but loses a genuinely useful
  hint when the key is set and merely mismatched by name.

Either way: when `mediaOptionKey` is blank, the modal should not offer to save a
media translation at all. The existing hint copy for that case already reads
*"No media option key configured on this controller"* (`renderer.js:1739`) —
the tick sitting underneath it contradicts the hint.

### M3 — An Ignore tick must not abort a job assignment

Two changes, independent:

- **Narrow the write.** `reconcileControllerIgnore` re-saves the entire
  controller (`renderer.js:1577`) purely to update `ignoredOptionNames`. A
  dedicated IPC that patches only that field keeps whole-controller validation
  out of a per-job action. Recommended.
- **Reorder and downgrade.** Do the assignment first, reconcile Ignore after,
  and report an Ignore-persistence failure as a warning toast rather than
  throwing — the assignment is the thing the operator asked for. Applies to all
  three call sites (`renderer.js:1870`, `:1961`, `:2039`), but check each: the
  Fuji and DPOF branches create a mapping whose matching *depends* on the
  ignore set, so for those, order matters and this may not be safe. **Decide per
  branch, do not blanket-apply.**

If the failure is still surfaced, the message must say which half failed —
"Job assigned, but the Ignore settings could not be saved: …" is a different
sentence from the current bare controller error.

### M4 — Make the locked state recoverable in-app

A **"Clear media translations"** button beside the Paper Type Option Key field
in the controller modal, shown only when rows exist and the key is blank —
one click, then Save. Do **not** auto-clear on load: silently deleting operator
data to satisfy a validator is how the original problem got made.

### M5 — Docs + changelog

Note in `CHANGELOG.md` that a Darkroom Pro controller for a lab without paper
type options should have both fields empty, and how to unstick one that is
already locked.

## 6. Decisions needed

1. **M2: (a) or (b)?** — hint-only fallback, or remove it entirely.
2. **M3: narrow IPC, reorder, or both?** And is reordering safe for the Fuji and
   DPOF branches, where the ignore set affects mapping match?
3. **M4: worth building, or is the manual row-delete good enough** given how few
   controllers can be in this state?
4. Should the guard message itself name the fix ("delete the Media Translation
   rows in Settings → Routing") rather than the abstract "clear the
   translations"?

## 7. Not in scope

- The routing-time and dispatch-time media gates are correct and unchanged.
- `shipping`/size translation handling is untouched.
- Whether Darkroom Pro tolerates `Media=` blank is the customer's call; the app
  has always supported emitting it.
