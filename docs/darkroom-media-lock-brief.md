# Claude Code brief — Darkroom Pro media-translation lock

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, working tree clean.
> Background and full analysis: `docs/darkroom-media-lock-plan.md`.

---

Read `CLAUDE.md`, then `docs/darkroom-media-lock-plan.md` in full — especially
§1 (the state), §2 (why the job assignment fails) and §3 (how the bad data gets
written). That document is the analysis; this is the build order.

**Context.** A lab that does not use Finish Options has a `darkroompro`
controller with `mediaTranslations` rows but a blank `mediaOptionKey`. That
combination is rejected by the controller-save guard, so the controller is
frozen: Settings edits (including the auto-print tick) and `Save & Assign` on
jobs both fail with *"Paper Type Option Key is required when Media Translations
are defined."* The app created the state itself, through a write path that does
not run the guard.

**Decisions already made — do not revisit:**
- The guard stays. Translations without an option key really are unreachable.
- The fix is to stop the state being created, not to relax the rule.
- `resolveMedia`, the routing-time gate and the dispatch-time gate are correct
  and must not change.
- Do **not** auto-delete translation rows on load or on save.

Work in **five commits, in order**. Do not start a milestone until the previous
one's tests pass. Stop and tell me if you hit something this brief did not
anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## M1 — Close the back door in `updateDarkroomTranslations`

`controllers:updateDarkroomTranslations` (`ipc-handlers.js:1553-1605`) pushes
onto `controller.mediaTranslations` and calls `routingService.saveController`
directly at `:1591`, bypassing both copies of the guard
(`renderer.js:5670-5680`, `ipc-handlers.js:1057-1073`). This is the path the
Assign modal's *"Save media translation for future orders"* tick uses, and it is
how the locked state gets created.

- Reject a `mediaTranslation` when `controller.mediaOptionKey` is blank or
  whitespace. Return `{success:false, error}` naming the real remedy: set the
  Paper Type Option Key on the controller first.
- A `sizeTranslation` in the same call **must still be applied** — size and
  media are independent, and a size translation is often the only reason the
  operator is in the modal.
- Decide and state in the commit message what happens when both are present and
  only media is rejected. Preferred: apply the size translation, return
  `{success:false, error}` so the caller surfaces the media problem, and make
  the error text say the size translation was saved. Silently discarding the
  size translation would be a new instance of the same bug class.
- Log at **warn** with `controllerId`, `name`, and the rejected `from`/`to`.

**Tests** → new `src/main/services/__tests__/ipc-darkroom-translations-guard.test.js`,
following the shape of `ipc-handlers-retry-job.test.js`:
1. Blank `mediaOptionKey` + `mediaTranslation` → `{success:false}`, controller's
   `mediaTranslations` unchanged on disk.
2. Same call with a `sizeTranslation` too → size persisted, media rejected.
3. `mediaOptionKey` set → media translation persisted as today (no regression).
4. Whitespace-only `mediaOptionKey` is treated as blank.

---

## M2 — Stop the Assign modal inventing a media option

`renderer.js:1706-1709` falls back to `jobOptions[0]` when `mediaOptionKey` is
blank or not found on the job. For a lab with no paper-type option that is
whatever option happens to be first — `layout-options: full bleed` on the
reported jobs — and `modal.dataset.dpMediaFrom` is then set from its value
(`:1750`). Ticking "Save media translation" writes `{from:"full bleed",
to:"Luster"}` into the paper-type table.

Keep the fallback for the **hint text only**. Change the save path:

- Set `modal.dataset.dpMediaFrom` to `''` unless `mediaOptionEntry` came from a
  real `mediaOptionKey` name match. Track that explicitly — do not infer it
  later by re-comparing strings.
- When `mediaOptionKey` is blank, **hide the "Save media translation for future
  orders" checkbox entirely** (and ensure it reads unchecked). It currently sits
  directly under hint text that says *"No media option key configured on this
  controller"* (`renderer.js:1739`) and contradicts it. Leaving it visible but
  inert is not acceptable — that is the failure mode this whole release is about.
- The manual media **input** stays. A per-job override is still legitimate; it
  is only the *persist as a rule* affordance that must go.
- Do not change `dpMediaResolvedValue` / `dpMediaAutoResolved` semantics beyond
  what the above requires.

`renderer.js` / `index.html` only — **no bundle rebuild**. If you find yourself
editing anything under `src/renderer/views/*.jsx`, stop and tell me.

### M2a — consequence of M1: a rejected media translation must not eat the job

M1 made `updateDarkroomTranslations` return `{success:false}` when the key is
blank. The Darkroom Pro branch reacts to that by **throwing**
(`renderer.js` ~:1973), which skips `assignDarkroomSizeMedia` — so the operator
loses the assignment they actually asked for. Before M1 the same click at least
assigned the job (while quietly corrupting the translation table). Hiding the
tick in M2 makes the path unreachable in normal use, but it must be made safe
regardless — a hidden control is not a guarantee.

Two changes in the same commit as M2:

- **Move the `cachedOrderControllers` / `renderOrderControllers` sync above the
  `success:false` throw.** Today it sits after it, so when media is rejected and
  a size translation *was* persisted, the write lands on disk while the renderer
  cache and the Settings cards still show the old state. That is the
  reporting-doesn't-match-doing failure this project keeps hitting; M1's
  returned `controller` is currently dead weight because of it.
- **Do not throw on a translation-save failure.** Surface it as a warning toast,
  then continue to `assignDarkroomSizeMedia`. Same principle as M3: an
  ancillary "remember this for next time" write must never abandon the per-job
  action. The toast must say which part failed and which part succeeded.

**Tests:** `renderer.js` is in no test glob. Cover the boundary instead — M1's
tests already prove a blank `from` is skipped (`ipc-handlers.js:1579`). Describe
the manual check in the commit message.

---

## M3 — An Ignore tick must not abort a job assignment

`reconcileControllerIgnore` (`renderer.js:1557-1581`) re-saves the **entire
controller** through `saveOrderController` purely to update
`ignoredOptionNames`, so it drags whole-controller validation into a per-job
action. It throws on failure (`:1579`), and the Darkroom Pro branch calls it
**first** (`renderer.js:1961`), so steps 2 and 3 — the translation save and
`assignDarkroomSizeMedia` — never run.

- Add a narrow IPC `ohd:routing:set-ignored-options` taking
  `{controllerId, ignoredOptionNames}` that patches only that field on the
  stored controller and saves. Register it in `src/preload/preload.js`. Point
  `reconcileControllerIgnore` at it.
- Validate the payload at the IPC boundary: array of non-empty strings,
  de-duplicated case-insensitively, controller must exist and be found by id.
  Do **not** run the media guard here — that is the entire point.
- **Scope: the darkroompro branch only** (`renderer.js:1961`). Leave the Fuji
  (`:1870`) and DPOF (`:2039`) call sites calling the same function — they get
  the narrower write for free, but do **not** reorder those branches. Their
  channel mapping's `optionsMatchWithIgnore` behaviour depends on the ignore set
  being current, and reordering there needs its own analysis.
- In the darkroompro branch, if the ignore write still fails, do **not** abandon
  the assignment. Complete the assignment and surface a distinct warning:
  *"Job assigned, but the Ignore settings could not be saved: …"*. The current
  bare controller error tells the operator nothing about what did or did not
  happen.

**Tests** → new `src/main/services/__tests__/ipc-set-ignored-options.test.js`:
ignore list persisted; other controller fields untouched (assert a full key-set
comparison, not just spot checks); unknown controllerId → `{success:false}`;
malformed payload rejected; a controller in the locked media state (translations
+ blank key) still accepts an ignore-only write.

---

## M4 — Make the locked state recoverable in-app

Existing controllers in the field are already stuck and can only be fixed by
deleting the rows by hand.

- In the controller modal, beside the Paper Type Option Key field, show a
  **"Clear media translations"** button **only** when there are translation rows
  and the key is blank.
- It clears the rendered rows in the modal (so the operator still has to press
  Save, and can still cancel). It must **not** write to disk by itself.
- Do not auto-clear on load or on save under any circumstances.

---

## M5 — Docs + changelog

- `CHANGELOG.md` under `## Unreleased`: all four fixes. State plainly that a
  Darkroom Pro controller for a lab with no paper-type options should have
  **both** the Paper Type Option Key and the Media Translations empty, and
  describe how to unstick a controller that is already locked.
- Update the guard's error text in both places (`renderer.js:5672`,
  `ipc-handlers.js:1064`) to name the concrete remedy — *"delete the Media
  Translation rows in Settings → Routing"* — rather than "clear the
  translations".
- `docs/BACKLOG.md`: note that `reconcileControllerIgnore` still performs a
  whole-controller save for the Fuji and DPOF branches, and that reordering
  those against `optionsMatchWithIgnore` is unanalysed.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **The guard stays.** Never make `resolveMedia` fall back to the raw option
  value, and never let a controller save with translations but no key.
- **Never silently delete operator data** to satisfy a validator.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`. Direct `node --test` runs need `--test-force-exit`.
- The `perfectlyClearClient` test file is flaky as a *file* — rerun once; not
  release-blocking.

## Verification checklist (I will run these)

1. A controller with a blank Paper Type Option Key: the Assign modal shows no
   "Save media translation" tick, and the manual media input still works.
2. With the key blank, `updateDarkroomTranslations` refuses a media translation
   and says why — and a size translation in the same action is still saved.
3. A controller already locked (rows + blank key) can be unstuck from the UI:
   Clear media translations → Save succeeds.
4. Once unstuck, the auto-print tick saves.
5. `Save & Assign` with an Ignore checkbox toggled completes the assignment even
   if the ignore write fails, and says which part failed.
6. Ignore ticks still persist and still affect mapping match on the next job.
7. A healthy Darkroom Pro controller with a real Paper Type Option Key and
   translations behaves exactly as before.

Start with M1. Show me the diff before committing.
