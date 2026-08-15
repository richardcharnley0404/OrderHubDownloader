# Claude Code brief — Darkroom Pro auto-send batches + UI tidy

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, working tree clean, after 1.12.2
> has shipped.

---

Read `CLAUDE.md` first.

Three small changes from lab feedback, plus docs. Work in **four commits, in
order**. Do not start a milestone until the previous one's tests pass. Stop and
tell me if you hit something this brief did not anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## M1 — Fix modal checkbox layout (root cause, not a patch)

Every checkbox in the controller modal renders with the tick **above** its
label instead of beside it. The cause is a CSS specificity collision, and the
codebase has hit this exact shape before:

- `.modal-checkbox` (`styles.css:2435`) correctly sets `display:flex` —
  specificity **(0,1,0)**.
- `.pm-modal .form-group label` (`styles.css:2377`) sets `display:block` —
  specificity **(0,2,1)**, so it wins inside the modal and the flex row
  collapses to stacked blocks.

There is already a comment at `styles.css:2467-2472` documenting the identical
trap being hit and fixed for `.rh-option`. Follow that precedent:

- Raise the selector to something specific enough to win cleanly (e.g.
  `.pm-modal .form-group label.modal-checkbox`). **Do not** use `!important`,
  and **do not** fix it with inline styles on individual fields.
- Add a short comment naming the colliding rule and its specificity, matching
  the style of the existing `.rh-option` note, so the next person doesn't
  re-derive it.
- Audit every checkbox in the controller modal (`index.html:1296, 1310, 1389,
  1396, 1403, 1410, 1425`) and make them all use `class="modal-checkbox"`.
  `ocMergeOrderJobs` at `:1424` currently uses an inline `style="display:flex…"`
  instead — that's a workaround for this same bug. Remove the inline style and
  use the class.
- Check the other modals that use `.modal-checkbox` before changing shared CSS;
  if any relied on the broken stacked layout, tell me rather than fixing them
  silently.

**Tests:** CSS is untestable here. Describe the manual check in the commit
message: open a Darkroom Pro controller, a Fuji PIC Pro controller and a DPOF
controller and confirm every tick sits left of its text, vertically aligned to
the first line, with long labels wrapping under the text and not under the tick.

---

## M2 — Auto-send batched jobs (Darkroom Pro)

Today a job over `maxPrintsPerJob` is held for operator review via the
`over-batch-threshold` reason (`src/shared/holdForReview.js:50, :167`) and only
splits into `{job_name}_1.txt`, `_2.txt`… when the operator presses Process.
The lab doesn't want to watch OHD, so they want the split to happen
automatically.

- New `darkroompro` controller field **`autoSendBatches`**, boolean, **default
  false**. Existing controllers must behave exactly as they do now.
- UI: a tick **to the right of** the "Maximum prints per job" input
  (`index.html:1416-1420`), inside the same `#ocMaxPrintsPerJobGroup`, using the
  M1 `.modal-checkbox` pattern. Label: **"Send batches automatically"**, with
  help text saying the job is split and dispatched without operator action.
  Only meaningful when a cap is set — if the cap is blank, disable the tick and
  say why.
- Behaviour: when `autoSendBatches` is on for the resolving controller, the
  `over-batch-threshold` hold reason is **not** raised, so auto-print dispatches
  the job and the existing splitter writes the multiple files unchanged. **Do
  not touch the splitter.** This milestone only decides whether the job waits.
- Every other hold reason still applies. A job held for manual review, AI
  quality or a routing hold must still be held — this suppresses one reason
  only, never the whole gate.
- Carry the field on the `darkroompro` route the same way `maxPrintsPerJob` is
  carried today, and mirror it in the `_channelMappingOverride` branch —
  the two must stay in parity (see the existing comments there; drift on that
  branch has caused a live bug before). **Only the darkroompro literals.**
- Defence-in-depth validation at the IPC boundary in
  `ohd:routing:save-controller`, alongside the existing `maxPrintsPerJob`
  check: strict boolean, scoped to `darkroompro`.
- Renderer save handler: assign the field **inside the `if (type ===
  'darkroompro')` block**. A field assigned in the wrong type block silently
  never persists — that exact bug shipped in 1.12.0 and cost a release.

**Tests:**
- `holdForReview.test.js`: cap exceeded + `autoSendBatches` off → reason
  raised; cap exceeded + on → reason absent; cap exceeded + on + a manual-review
  reason → still held; no cap set + on → no reason either way.
- Routing tests: field on the route, both literals, defaults false, non-boolean
  coerces to false, non-darkroompro routes don't carry it.
- IPC save-controller tests: persists, rejects non-boolean, scoped to
  darkroompro.

---

## M3 — Hide the Order XML tab when the feature is off

When `orderXmlEnabled` is false (`renderer.js:2525-2526, :2670`), hide the
**main-window** Order XML tab (`index.html:31`, `data-tab="orderxml"`).

- **Keep the Settings sub-tab visible at all times** (`index.html:208`,
  `data-subtab="orderxml"`). That's where the enable checkbox lives — hiding it
  would make the feature impossible to switch back on.
- Follow the existing show/hide precedent for the Jobs and Film tabs
  (`renderer.js:233-244`), including the "active tab was just hidden → activate
  the first visible tab" behaviour already implemented there. Do not write a
  second mechanism.
- Re-evaluate visibility when the setting is saved, not only at startup, so the
  tab appears and disappears without a restart.

**Tests:** renderer is in no test glob. Describe the manual check in the commit
message: off → no Order XML tab, Settings sub-tab still present; tick it and
save → tab appears; untick while standing on that tab → tab disappears and the
UI lands on a sensible tab rather than a blank panel.

---

## M4 — Docs + changelog

- `CHANGELOG.md` under `## Unreleased`: all three, in operator language.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **`autoSendBatches` defaults to false.** With it off, behaviour must be
  identical to today.
- **Do not modify the batch splitter** (`src/shared/batchSplit.js` or the
  Darkroom Pro dispatch loop). M2 is a gating change only.
- **Never suppress more than the one hold reason.**
- **New controller fields go in the matching `if (type === …)` block** in the
  renderer save handler.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`. Direct `node --test` runs need `--test-force-exit`.
- The `perfectlyClearClient` test file is flaky as a *file* — rerun once; not
  release-blocking.

## Verification checklist (I will run these)

1. Every tick in the controller modal sits left of its label, on all controller
   types, with long labels wrapping correctly.
2. Darkroom Pro with a cap and auto-send **off** → large job still held, as now.
3. Same with auto-send **on** → job dispatches unattended and lands as multiple
   `_1.txt` / `_2.txt` files.
4. Auto-send on + a job also held for manual review → still held.
5. Cap blank → the tick is disabled and explains why.
6. Order XML disabled → no main-window tab; Settings sub-tab still reachable;
   re-enabling brings the tab back without a restart.

Start with M1. Show me the diff before committing.
