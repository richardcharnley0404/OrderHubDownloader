# CLAUDE.md — working in the OrderHub Downloader repo

Read `README.md` first for what the app does. This file is the stuff that will
bite you if you don't know it.

## Ground rules

- **Windows Electron app.** It is developed and run on Windows. Tests that
  assert on Windows paths and modules with native bindings (sharp, onnxruntime)
  will fail if you try to run the suite on Linux — that is the environment, not
  a regression. Ask the human to run `npm test` if you can't run it natively.
- **Verify before you claim.** "Production ready" means manually tested by the
  human on real jobs, not "tests pass".
- **One command at a time** when walking the human through a multi-step process.
  Wait for the output before giving the next one — bundling causes drift.

## The build trap you will fall into

`src/renderer/job-review.bundle.js` and `film-review.bundle.js` are **committed
esbuild output**. Any change to a `.jsx` file under `src/renderer/views/` is
invisible in the running app until you:

```bash
npm run build:renderer
```

and commit the regenerated bundle, conventionally as a separate
`chore(build): rebuild <x> bundle for <reason>` commit.

`renderer.js`, `index.html` and `styles.css` are loaded directly — no build.
Main-process changes take effect on next launch.

When running the full `npm run build`, **never** tee or redirect output into a
file inside the repo. electron-builder packs the asar in two passes; a file
growing between them corrupts the offsets and the installer crashes natively
(`0xc000041d`) with no logs. This bit v1.7.0.

See `docs/RELEASE.md` for the full release process — pre-flight, version
bump, CHANGELOG, build, artifact verification, upload (single `.exe`
to S3 by hand; paste the link into OrderHub), the unsigned-installer /
SmartScreen caveat to pass to operators, and the code-vs-practice gap
on auto-updates (wired but never activated in production).

See `docs/BACKLOG.md` for open threads after v1.8.0 — Fuji PIC Pro lab-test
wait, known non-blocking defects (Crop-to-Size labels, CSV channel-mapping
import, PIC Pro rehydrate window, a flaky test), unverified paths (Manual
Crop Approve gate), and parked decisions (auto-update activation, the
legacy `folder_copy` Fuji controller). Read before starting new work so
those threads don't get lost.

## Layout

- `src/main/services/` — ingestion, routing, dispatch, film scans, AI, stores
- `src/main/jobs/` — Job Review main-side logic (sidecar, crops, reprints)
- `src/main/enhancement/` — Perfectly Clear + local/Topaz AI upscaling
- `src/main/ipc-handlers.js` — ~125 handlers plus the auto-print orchestrator
- `src/shared/` — logic imported by **both** main and renderer. Must stay
  Electron-free so `node --test` and esbuild can both load it.
- `src/renderer/views/` — React sources for Job Review and Film Review

## Conventions

**IPC.** Two eras coexist. New work uses `ohd:<area>:<kebab-action>`
(`ohd:job:*`, `ohd:routing:*`, `ohd:filmReview:*`, `ohd:enhancement:*`,
`ohd:backup:*`). Older flat `domain:action` channels (`config:get`,
`jobs:getAll`) are still live — don't rename them. Every channel must be added
to `src/preload/preload.js`; the renderer never touches `ipcRenderer` directly.

**Logging.** Winston singleton in `services/logger.js`. Dominant form is
`logger.logError(message, error, meta)` with the error object second. Tag
messages by subsystem: `[auto-print]`, `[backup]`, `[orientation]`,
`filmScans:`. The Activity Log tab reads these files.

**Tests.** `node:test` + `node:assert/strict`, no framework. The dominant
mocking pattern is `require.cache` injection so Electron-dependent modules load
headless; many services also accept injected deps (fs, sharp, shell, clock, api
client) for the same reason. Keep new tests inside one of the five globs in
`package.json` or they will never run. **Direct `node --test` invocations
need `--test-force-exit`** — several tests transitively pull in electron-store
and other modules with live timers that keep the event loop alive after the
assertions complete; the `npm test` script already passes the flag, but a
`node --test path/to/foo.test.js` call without it will hang. Match the
package.json script:
`node --test --test-force-exit --test-concurrency=1 <files>`.

**Assertions come from the invariant, never from observed output.** A test's
expected value must be derived from the invariant its title states — write the
expected value first, then run it; if it fails, decide which of the two is
wrong rather than editing the assertion to match. The M7 regression is the
worked example: `src/shared/__tests__/printUtils.test.js:454` was titled *"only
`-`/`_` are separators — a configured PXDEMO must NOT strip PXDEMOX"* and
asserted `'PXDEMOX091YEC'` → `'X091YEC'`, which is the bug. The suite was
green and the area read as covered, so the bug survived review and was
committed as M7. Fix landed in M7a; the corrected assertion is `'PXDEMOX091YEC'`
→ `'PXDEMOX091YEC'`. A test written from observed output turns an untested area
into a *falsely-confident* one, which is strictly worse than leaving it
untested — reviewers see the title and move on.

**Never document unrun tests as fact.** Assertions in docs, changelogs and
operator notes about outside-world behaviour (what PIC Pro does, what
OrderGateway does, what happened at a lab) must be observed, not expected.
The 1.15.3 CHANGELOG was drafted asserting that the lab tests documented in
`docs/picpro-cross-volume-investigation.md` had been run and had confirmed
both cross-volume safety hypotheses — the tests had not been sent, let alone
run. Caught in review before release, but only just. Rule: if it has not
been observed by us or reported by the lab, it is not a fact yet. Anything
expected but unverified is named as an expectation, with a pointer to where
the test that would settle it is defined (design doc, backlog entry,
whatever). Same discipline as the invariant-derived-assertions rule above,
one turn later in the pipeline — that rule guards tests against false
confidence at write time, this one guards docs at ship time. If you catch
yourself writing "confirmed at the lab", "verified in production",
"observed to work" in a docstring / changelog / operator note, first grep
the repo for the report or the test result you are citing. If you cannot
cite one, the wording is wrong.

**Singletons.** Most services export a live instance (`module.exports = new
Foo()`); some export `{ instance, Class }` so tests can construct their own.
Services hold mutable in-process state, so tests must stub or reset rather than
re-require. Several modules use lazy `require()` inside functions specifically
to break load-order cycles — don't hoist those to the top.

**Line endings.** `.gitattributes` forces `eol=lf`. If files show as modified
with no visible change, check `git diff --ignore-cr-at-eol` before believing it.

## Landmines

- **Reprints must source from `{job}/originals/`, never `/working/`.**
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 artwork downloader, or `markReceived`. There are guards at four layers;
  keep them.
- **`require('sharp').cache(false)`** is set in both `src/main/index.js` and
  `ai-inference-host.js`. They are separate OS processes with separate libvips
  state — removing either causes EPERM on SMB shares.
- **`routing.json` is the live routing store.** `print-controllers.json` is
  legacy, migrated on startup and kept only as a fallback. Routing keys found in
  `config.json` are stale leftovers that get stripped on startup.
- **Print size comes from the channel mapping**, never from the manifest's
  `img.size` (S3 jobs set it to null by design). The old `'KG'` fallback is gone
  — a mapping with no print size fails loudly and correctly.
- **`config-service` strips a UTF-8 BOM on read.** Editing `config.json` with
  PowerShell `Set-Content -Encoding UTF8` would otherwise brick the app.
- **`artwork_files[].production_ready` only means anything when
  `artworkSource === 'manual'`.** On Pixfizz-sourced files it is default-state
  noise. Any branch on it must check both.
- **The Folder Copy destination-folder rule lives ONLY in
  `folder-copy-filename.buildDestFolder`.** Dispatch
  (`_sendViaFolderCopyRouted`) and the Settings live preview both call it.
  Re-deriving the rule anywhere else — an inline
  `path.join(outputPath, ${orderNumber}_${jobId})`, a "helper for clarity",
  a copy-paste at a new caller — makes the preview lie about where files
  will land, which is the one thing the preview exists to be right about.
  If you need to touch the layout / strip-prefix / blank-outputPath
  behaviour, change the helper.
- **`path.extname` must NEVER be applied to resolved template output** —
  only to a real source path (`img.sourcePath`). `path.extname` returns
  everything after the last dot in the last segment; a resolved template
  is not a filename. It truncated `"8.5x11 Canvas"` (a Wide Format product
  name) to `"8"` and silently dropped the `_2` from `"photo.jpg_2"`,
  losing an image count. Locked by the audit meta-test in
  `folder-copy-filename.test.js` (`M2-fix audit: exactly one path.extname
  call is on img.sourcePath`) which reads the module source and counts
  the calls — do NOT delete that test as noise; it is the tripwire.
- **Duplex back positions mirror about the SHEET centreline, never the
  usable-area centre.** The two formulas produce identical positions when
  margins are symmetric, so a regression from `sheetW - front.x - cellW`
  to `2 * usableCentre - front.x - cellW` sails through every symmetric-
  margin test and prints every back on the wrong front at any lab with
  a grip-edge (asymmetric) margin. The tripwire is the M1a
  asymmetric-margin mirror tests in `src/pdf-pipeline/__tests__/imposition-layout.test.js`
  (`M1a: mirror invariant, long-edge, asymmetric horizontal margins` and
  its short-edge sibling) — do NOT delete them as duplicates of the
  symmetric-margin tests above; the symmetric ones cannot catch this
  class. Sign errors here need reprints, not repairs.
- **`deriveTrim` exists ONCE in `imposition-compose.js` and the Settings
  live preview runs the real M1 engine over IPC (`imposition-preview.js`).**
  Both are the same class of tripwire as `buildDestFolder`: a preview or
  save-time check that computes a different grid than dispatch is worse
  than no preview — it lulls the operator into believing a template is
  right exactly when it isn't. The equality-with-engine test in
  `imposition-preview.test.js` (`preview.layout` deep-equals `computeLayout()`
  for the same inputs) makes the discipline mechanical: a lookalike
  reimplementation of trim derivation or layout computation in the
  renderer, in a helper "for clarity," or as a copy-paste at a new
  caller fails that test before the operator sees a preview grid that
  disagrees with dispatch. If you need to touch the trim rule or the
  layout math, change the ONE implementation. This is the M5a class of
  bug the folder-copy `buildDestFolder` landmine also names.
- **Files or folders OHD creates inside a folder a third-party system
  watches must carry names that cannot be mistaken for real work.**
  The `.ohdtmp` phantom-order defect (1.14.x, fixed in 1.15.0) happened
  because the temp folder OHD wrote inside DIGIN was named
  `{orderId}.ohdtmp` — the order code was a substring, PIC Pro's DIGIN
  watcher matched on it, and every cross-volume order arrived as a real
  order plus a blank duplicate. The 1.15.3 cross-volume path is only
  safe because its `.ohd-inbox-{controller}-{instance}-{ts}-{rand}`
  name deliberately does NOT match any order or container id, and a
  defensive assertion in `_buildInboxName`
  (`src/main/services/fuji-pic-pro-file-writer.js`) throws if the
  generated name would ever contain the orderId as a substring. Locked
  by the "substring-trap" test in
  `src/main/services/__tests__/fuji-pic-pro-file-writer.test.js`
  (`1.15.3 deliverToDigin: substring-trap — controllerId containing
  orderId triggers hard throw`) — do NOT delete that test as
  paranoid; the safety property of the whole cross-volume design
  depends on it. Same rule applies to the two same-class latent
  risks documented in `docs/BACKLOG.md` ("Tmp-in-watched-folder
  writers") — `writeOrderFile`'s `.txt.tmp` inside Order Data and
  JobMaker's `.txt.tmp` inside the hot folder are only presumed safe
  today; if either becomes a real defect, the fix is a different
  name, not a different location. Do not "tidy" the `.ohd-inbox-`
  prefix out into something shorter or more order-like — the whole
  point is that it does not look like an order.
- **A failure that happens after the dispatch entry point returns
  must set the job to error with an actionable message, never
  log-and-continue.** The 1.15.3 silent-stall fix existed because
  the PIC Pro delivery path did the latter: EXDEV, EACCES, DIGIN
  mount going missing mid-order, gateway timeout, build timeout —
  every one of them logged to Winston and quietly resolved the
  monitor entry as `failed`, while the Jobs grid kept showing the
  job at "in production" indefinitely because dispatch had already
  called `_markInProduction` synchronously. A lab's orders stalled
  this way for days; nobody found out until they emailed us. Fix
  pattern (see `src/main/services/fuji-pic-pro-monitor.js`
  `_resolveEntry` / `_emit` and
  `src/main/services/print-controller-service.js` `onPicProStatus`):
  thread `jobIds` from dispatch through the monitor's terminal-
  failure callback, and have the callback call
  `jobService.updateJobLocally(jobId, { _status: 'error',
  _errorMessage })` with the specific error text from the failure
  site. Every terminal-failure site in the monitor builds its own
  specific Error so the operator sees what actually broke, not a
  generic "delivery failed" — locked one test per site in
  `fuji-pic-pro-monitor.test.js` under the `1.15.3 silent-stall:`
  prefix. **Known exception: PIC Pro reprints** — reprints have no
  JobStore entity to stamp; the async failure gap is documented in
  `docs/BACKLOG.md` under "PIC Pro reprint async delivery failure
  is not surfaced anywhere". **Not audited: JobMaker, Darkroom Pro,
  DPOF.** Each of those has its own async delivery paths that were
  not part of the 1.15.3 audit; when touching any of them next,
  check whether the async terminal-failure path calls
  `updateJobLocally({_status:'error'})` with a specific message, or
  whether it just logs and drops.

## Misnamed / dead code — don't be misled

- `job-download-service.js` **downloads nothing**. Its only real method is
  `checkLocalFiles(job)`, which deliberately returns `found === hasFiles` (not
  `hasFiles && hasManifest`) so AI scoring can start before the manifest lands.
  Changing that equality breaks auto-print. Downloading is `ftp-service.js` and
  `s3-artwork-downloader.js`.
- `controller-types.js` is **not** the controller registry — it is only the DPOF
  classifier (`noritsu`/`epson`/`dpof`). The full type list lives in the
  renderer's `<option>` markup and the branches in `print-service.js`.
- `src/main/jobs/imageProcessor.js` — `applyCorrections()` is a stub. The CMY
  sliders persist values to the sidecar; nothing applies them to pixels.
- Unreferenced: `upload-tracker.js`, `encryption-service.js` (credentials are
  still plaintext in config.json — `safeStorage` was never wired up).
- `job-store.js` / `jobs.json` are effectively dead in production; only the
  dev-only `test-print-controller.js` harness writes to them.
- `OHD_OrderReview.jsx` at the repo root is a design prototype, imported by
  nothing.
- `PROJECT-STATE.json` and `QUICKSTART.md` are stale (v1.0 era). Trust
  `CHANGELOG.md` and `docs/RELEASE-NOTES-*.md` instead.

## Working with accumulated WIP

When new work has to touch files that are already dirty with unrelated
work-in-progress, don't mix them: snapshot a foundation-only commit first, then
put the surgical change on top. Keep release-worthy work on its own commits so
the CHANGELOG entry can be written from `git log`.
