# Fuji PIC Pro — Claude Code implementation brief

**Target:** M0 → M5 in one working session, on a branch, unpushed until Richard has run a real order.
**Companion doc:** `docs/fuji-pic-pro-investigation-and-plan.md` (the why, the spec extract, the decisions).
**Repo:** `C:\Dev\OrderHubDownloader`, branch off `main`.

> Line numbers below are from a 2026-08-02 read of `main` @ `fa8b8f5`. They will drift as you
> edit. Treat them as starting points and grep to confirm before changing anything.

---

## 0. Before you write any code

Read `CLAUDE.md` in the repo root. The two that will bite hardest on this task:

- **Any `.jsx` change under `src/renderer/views/` is invisible until you run `npm run build:renderer`
  and commit the regenerated bundle.** M0 touches `ManualCropMode.jsx`, so this applies. Use a
  separate `chore(build): rebuild job-review bundle for <reason>` commit, matching the existing
  convention.
- New tests must live inside one of the five globs in `package.json`, or they silently never run.

Run `npm test` first and record the baseline pass count. If anything is already red, stop and
report rather than building on top of it.

Commit per milestone, with the same message style as the v1.7.22 series (`git log ddf1a5b~13..ddf1a5b`
is a good sample). Do not bump the version or touch `CHANGELOG.md` until M8.

---

## M0 — Crop target size for the Fuji family

**Why:** `resolveTargetSize()` has no branch for `fujijobmaker`. A routed Fuji job always returns
`{ok:false, reason:'no-size-translation'}`, and `CropEditor.jsx:298` then silently falls back to
`aspectRatio = 1` — square. PIC Pro must not inherit this, and JobMaker is being fixed at the same
time (Richard's call, 2026-08-02).

### M0.1 — New mapping field `printSize`

A bare `WxH` string (`6x4`, `3.5x5`) on the channel mapping. It is **only** used to drive the crop
aspect — it is never written into a JobMaker `.txt` or a PIC Pro `order.txt`. Applies to both
`fujijobmaker` and the new `fujipicpro`.

- Mandatory at save time for both types, validated server-side in the
  `ohd:routing:save-channel-mapping` IPC handler (`src/main/ipc-handlers.js:1188-1229`) so CSV
  import is covered too, plus a renderer-side check. Mirror exactly how `printSizeCode` was made
  mandatory for DPOF in v1.7.22 (`git show baef230`).
- Reuse `isBareWxH` from `routing-service.js` for the format check — do not write a second regex.

### M0.2 — Backfill migration

`backfillFujiPrintSize()` in `routing-service.js`, one-shot, guarded by `_backfill_fuji_print_size_v1`,
run from the same place as the existing migrations at IPC setup. For every `fujijobmaker` mapping with
a blank `printSize`: if `isBareWxH(mapping.printCode)` copy it across, otherwise leave blank and
`logWarning` naming the mapping. Follow `backfillLegacyPrintSizeCode` (`git show 5686ac8`) — same
shape, same idempotency guard, same equivalence-lock test.

### M0.3 — Carry `channelMappingId` on Fuji routes

The Fuji Layer-3 branch (`routing-service.js:346-387`) and its `_channelMappingOverride` twin
(`:123-154`) both build a route with `channelNumber: null`. Add `channelMappingId: channelMapping.id`
and `printSize: channelMapping.printSize` to both. Do the same in the new PIC Pro branch in M1.

**Do not** loosen Path 1's `route.channelNumber != null` gate in `resolveTargetSize` to make this
work — that gate is what keeps DPOF resolution correct. Add a separate path.

### M0.4 — `getAllSizeOptions()` gains a Fuji source

`routing-service.js:659-706`. Today it has exactly two sources: DPOF channel mappings
(`parseSize(m.size || m.printSizeCode || m.batchCode)`) and Darkroom Pro `sizeTranslations`. Add a
third, for channel mappings whose parent controller type is `fujijobmaker` or `fujipicpro`:

```js
{ id: `cm_${m.id}`, source: 'fuji', w, h, label, channelMappingId: m.id, controllerId: m.controllerId }
```

parsed from `m.printSize`. Skip mappings with a blank or unparseable `printSize` (they'll surface via
the badge in M0.6).

### M0.5 — `resolveTargetSize()` gains a Fuji path

`src/main/jobs/batchCropActions.js:718`. Insert a new path **between** the existing Path 2
(darkroompro) and Path 3 (the `printSizeCode` regex fallback):

```
if route.controllerType is 'fujijobmaker' or 'fujipicpro'
   and route.channelMappingId
   and deps.getAllSizeOptions is available
→ sizes.find(s => s.channelMappingId === route.channelMappingId)
→ { ok: true, sizeOption: match }
```

Leave the existing `folder_copy` / `pdf_copy` early return at `:733` alone — those genuinely carry no
print size. Falls through to `{ok:false, reason:'no-size-translation'}` unchanged when the mapping has
no `printSize`, which is the correct signal.

### M0.6 — Renderer

- `src/renderer/index.html` — add a `#cmPrintSizeGroup` / `#cmPrintSize` input to the Fuji
  channel-mapping block (currently `:1398-1415`, alongside `cmPrintCode` / `cmSurface` /
  `cmSurfaceCode`), and an `#assignPrintSize` to the Assign-Channel Fuji block (`:1533-1554`).
- `src/renderer/renderer.js`:
  - `_updateCmFields()` (`:5640-5655`) — show the new group for both Fuji types.
  - `cmSaveBtn` (`:5726-5808`) — add `payload.printSize` in the Fuji arm; keep
    `channelNumber: null`, `printSizeCode: ''`, `skipAutoPrint: false` exactly as they are.
  - `assignChannelSaveBtn` Fuji arm (`:1528-1599`) — collect and validate `printSize` the same way it
    already validates `printCode` and `surface`, and include it in the `saveChannelMapping` payload.
    This is the primary path operators use; a missing field here is what broke the DPOF assign flow
    in 1.7.22 before step 5 landed.
  - The `⚠ No print size` badge in the channel-mapping list — Fuji types are currently suppressed via
    the `NON_DPOF_TYPES` set at `:5523`. Add an equivalent amber badge for Fuji mappings with a blank
    `printSize`, so the backfill's leftovers are visible.

### M0.7 — Fix the ungated Approve button

`src/renderer/views/JobReview/ManualCropMode.jsx:1010-1013`. `canApprove` is missing
`&& targetSizeReady`, despite the comment at `:546` claiming it's gated. As written an operator can
approve every image one-by-one at a square crop while `⚠ No size translation` is showing, then Send
to Print. Add the guard.

Verify this against a real job before treating it as a shipped bug — Richard has not confirmed it in
the app. If it turns out the button is unreachable for another reason, note that and leave the code
alone rather than adding a redundant guard.

### M0.8 — Tests

- `src/main/services/__tests__/batchCrop.test.js` — the fixtures at `:670-693` are DPOF + Darkroom
  only. Add a `fujijobmaker` controller + mapping with `printSize:'6x4'` and assert
  `{ok:true, sizeOption:{w:6,h:4}}`; add a blank-`printSize` case asserting `no-size-translation`;
  add a `fujipicpro` case once M1 lands.
- New backfill test mirroring `routing-backfill-print-size.test.js` — idempotency, non-WxH
  `printCode` left blank, DPOF/frontline/folder_copy mappings untouched.
- `validateDPOFPrintSizeCode.test.js` — `fujipicpro` must return `{valid:true}` like the other
  non-DPOF types.

**Commit M0 as its own series before starting M1.** It is independently releasable and independently
testable, and if the PIC Pro work stalls the crop fix should still ship.

---

## M1 — Register the `fujipicpro` controller type

Every seam a controller type touches. Grep `'fujijobmaker'` and add an arm at each hit — there are no
others.

| File | What to add |
|---|---|
| `src/main/services/fuji-pic-pro-config.js` *(new)* | `validateControllerConfig` + `validateProductMappingConfig`, modelled 1:1 on `fuji-jobmaker-config.js`. Exports `CONTROLLER_TYPE = 'fujipicpro'`. |
| `src/main/ipc-handlers.js:1072-1083` | `ohd:routing:save-controller` — validation arm |
| `src/main/ipc-handlers.js:1188-1229` | `ohd:routing:save-channel-mapping` — validation arm |
| `src/main/services/routing-service.js:346-387` | New Layer-3 branch (copy the Fuji one; carry `printCode`, `printSize`, `color`, `channelMappingId`) |
| `src/main/services/routing-service.js:123-154` | The `_channelMappingOverride` twin — same fields |
| `src/main/services/routing-service.js:1010-1012` | Add `'fujipicpro'` to `NON_DPOF_CONTROLLER_TYPES` |
| `src/main/services/print-controller-service.js:131-173` | `startMonitoring` arm wiring `FujiPicProMonitor` (M4) |
| `src/renderer/index.html:1148` | `<option value="fujipicpro">Fuji PIC Pro</option>` |
| `src/renderer/index.html` | Controller field groups (see below), channel-mapping groups, Assign-modal group |
| `src/renderer/renderer.js:4435` | `getControllerTypeLabel` → `'Fuji PIC Pro'` |
| `src/renderer/renderer.js:4715-4742` | `updateOcTypeFields()` — show/hide the new groups |
| `src/renderer/renderer.js:4774-4790` | `openOrderControllerModal()` pre-fill + defaults |
| `src/renderer/renderer.js:5252-5279` | `ocSaveBtn` payload |
| `src/renderer/renderer.js:5523` | `NON_DPOF_TYPES` renderer duplicate |
| `src/renderer/renderer.js:5640-5655` | `_updateCmFields()` |
| `src/renderer/renderer.js:5726-5808` | `cmSaveBtn` payload |
| `src/renderer/renderer.js:1339-1499, 1515-1751` | `openAssignModal` visibility + `assignChannelSaveBtn` arm |

**Not** `controller-types.js` — that file is only the DPOF classifier. `isDpofType('fujipicpro')`
must be `false`; assert it in `print-service-reprint-dispatch.test.js` alongside the existing
`fujijobmaker` assertion.

### Controller fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `orderDataPath` | ✅ | — | `<OrderId>.txt` + command files land here |
| `diginPath` | ✅ | — | the `<OrderId>` image folder lands here |
| `mergeDataPath` | — | `''` | only used to confirm the build finished before `[release]` |
| `imageStagingRoot` | ✅ | — | images assembled here, then moved into DIGIN |
| `sendReleaseCommand` | — | `false` | per-controller auto-print toggle |
| `gatewayTimeoutMs` | — | `120000` | bounds 10 000 – 1 800 000 |
| `buildTimeoutMs` | — | `1800000` | bounds 60 000 – 86 400 000 |
| `backprintMode` | — | `'none'` | `'none' \| 'text'`; `'image'` rejected, as in JobMaker v0 |
| `backprintTemplate` | when `text` | `''` | → `Backprint1=` |
| `backprintTemplate2` | — | `''` | → `Backprint2=` |
| `includeCustomerName` | — | `false` | emits `CustomerName=`; off because it back-prints |

Three separate browse-able paths — **not** a single derived root. Richard's call: labs lay these out
differently and the folders can live on different servers.

Set `checkOrderStatus` to `true` for this type, as the renderer already does for Fuji
(`renderer.js:5206`).

### Channel mapping fields

`printCode` (✅ → `Code=`), `printSize` (✅ → crop aspect only), `color` (default `'C'` → `Color=`),
plus `channelNumber: null`, `printSizeCode: ''`, `skipAutoPrint: false` for shape parity.

**Tests:** `fuji-pic-pro-config.test.js` mirroring `fuji-jobmaker-config.test.js` — minimal-valid,
full-valid, wrong type, each required field, whitespace-only rejection, `backprintMode` cases,
timeout bounds and coercion, non-object input, mapping validation incl. `color` defaulting.

---

## M2 — `fuji-pic-pro-generator.js`

Pure function, no I/O, no Electron. Mirrors `fuji-jobmaker-generator.js`.

```js
generateFujiPicProOrderFile(job, controller) → { filename: string, contents: string }
module.exports = { generateFujiPicProOrderFile, _internals: { ... } }
```

`job`: `{ orderId, jobName?, customer:{fullName?,email?,phone?}, images:[{ negNumber, printCode, quantity, color, originalFilename? }] }`
`controller`: `{ backprintMode, backprintTemplate, backprintTemplate2, includeCustomerName }`

**Output** — INI style, **case sensitive**, `filename = \`${orderId}.txt\``:

```
[Order]
OrderId={orderId}
CustomerName={customer.fullName}      ← only when includeCustomerName && set
[Neg]
NegNumber={image.negNumber}
Backprint1={resolved}                 ← omitted when null/empty
Backprint2={resolved}                 ← omitted when null/empty
[Unit]
Code={image.printCode}
Qty={image.quantity ?? 1}
Color={image.color || 'C'}
                                      ← [Neg]/[Unit] pair repeats per image
```

**Omit entirely:** `Crop=`, `UnitCrop=`, `Orient=`, `Retouch=`, `Logo=`, `LogoPos=`, `SlimText*`,
`[Comp]`, `[Node]`, `*Product=`. Pre-cropped digital files need none of them, and `Orient=` is
explicitly not required for digital files (spec p. 351).

**Line endings:** CRLF, trailing CRLF at EOF, same as the JobMaker generator.

**Back-print:** reuse JobMaker's `_resolveBackPrint` / `_sanitiseBackprintText` verbatim — 40-char
cap, `[%(;']` → space, `~` → `-`, `resolveTemplate` from `template-tokens.js` with `{filename}` and
`{originalFilename}`. Note `originalFilename` must be the value from the **manifest**, not the
renamed `0001.jpg`, so `{originalFilename}` still shows the customer's real filename.

Heads-up carried over from JobMaker: `index.html` advertises a `{date}` token that
`template-tokens.js` does not implement. Don't repeat that in the PIC Pro hint text.

**Throw on:** missing `job`, missing `job.orderId`, empty `images`, missing `controller`, an image
with no `negNumber` or no `printCode`, a `negNumber` longer than 15 characters.

**Tests** (`fuji-pic-pro-generator.test.js`): golden-file structural comparison against a
hand-built `docs/Fuji Pic Pro/sample-order.txt`; CRLF assertion; header ordering; `Qty` default 1;
`Color` default C; `CustomerName` present only when the toggle is on; both back-print lines incl.
sanitisation and truncation; every throw case; explicit assertions that `Crop=`, `UnitCrop=` and
`Orient=` never appear.

---

## M3 — `fuji-pic-pro-file-writer.js`

```js
async stageImages({ imageStagingRoot, orderId, imageFiles })
  → { stagingFolder, negNumberMap: Array<{negNumber, sourcePath, originalFilename, stagedName}> }

async writeOrderFile({ orderDataPath, filename, contents })
  → { writtenPath }

async deliverToDigin({ stagingFolder, diginPath, orderId })
  → { destFolder, method: 'rename' | 'copy' }

async writeCommandFile({ orderDataPath, command, orderId })
  → { writtenPath }
```

**Sequence rename (M3's core job).** `imageFiles` arrive in manifest order. Stage each as
`0001.<ext>`, `0002.<ext>` … preserving the source extension, into
`{imageStagingRoot}/{orderId}/`. `negNumber` is the basename without extension — always ≤ 4 chars,
so the 15-char cap can never be hit. Return the full mapping so the dispatch record can answer
"which file is 0007?".

**Atomicity:**
- Order file: write `{path}.tmp` then `fs.promises.rename` — same as the JobMaker writer.
- DIGIN delivery: `fs.promises.rename(stagingFolder, {diginPath}/{orderId})` so DIGIN never sees a
  partial folder. On `EXDEV` (different volume) fall back to a recursive copy into
  `{diginPath}/{orderId}.ohdtmp` then rename, and `logWarning` that staging and DIGIN are on
  different volumes — the operator should co-locate them.
- Command files: plain write, contents `[{command}]{orderId}` with no trailing newline
  requirement. Name them `ohd_{command}_{orderId}_{timestamp}.txt` — the spec says the filename is
  irrelevant, and a timestamp avoids clobbering.

**Do not auto-create** `orderDataPath` or `diginPath`. Throw a named error if either is missing, the
way the JobMaker writer does for the hot folder — a typo'd UNC path silently creating a local folder
is worse than a hard failure.

**Tests** (`fuji-pic-pro-file-writer.test.js`, real `os.tmpdir()` I/O): sequence naming and
zero-padding; extension preservation; mapping correctness; `.tmp` never left behind; DIGIN rename
path; the EXDEV copy fallback (simulate by injecting a throwing `rename`); missing folders throw and
write nothing; command-file contents; re-submit overwrite behaviour; arg validation.

---

## M4 — `fuji-pic-pro-monitor.js` + pending store

The handshake. This is the riskiest milestone — build it last before dispatch and test it hardest.

**Why a queue and not an inline wait:** `runAutoPrint()` dispatches jobs sequentially, so an inline
poll would stall every subsequent job for the full timeout whenever OrderGateway is stopped. And an
app restart mid-wait strands the order — txt consumed, images never delivered.

**State machine**, one entry per submission, persisted in a new electron-store
`fuji-picpro-pending.json` so a restart resumes:

| Phase | Waiting on | → |
|---|---|---|
| `awaiting-gateway` | `{orderDataPath}/{orderId}.txt` to disappear | gone → `delivering`; `gatewayTimeoutMs` → `failed` |
| `delivering` | nothing — perform the DIGIN move | done → `building` |
| `building` | `{diginPath}/{orderId}` to disappear (and, if `mergeDataPath` set, its containers) | cleared → `releasing`; `buildTimeoutMs` → `timed_out` |
| `releasing` | nothing — write `[release]` if `sendReleaseCommand`, else no-op | → `complete` |

Sweep at 1 s while anything is pending, 60 s idle. `.unref()` the interval. Follow
`FujiJobMakerMonitor` for the class shape: `startMonitoring` / `stopMonitoring` / `clearTracked` /
`_scanNow(now)` test hook, `fs.watch` as a debounced accelerator inside try/catch with the interval
sweep as the source of truth, and a callback wrapped so a throw can't kill the monitor.

Callback payload matches the JobMaker contract so `print-controller-service` can reuse its wiring:
`{ orderRef, status: 'accepted' | 'failed' | 'timed_out', phase, timestamp }`.

**Merge Data check.** If `mergeDataPath` is configured, treat the order as built when neither
`{mergeDataPath}/{orderId}.con` nor `{mergeDataPath}/{orderId}/` exists — OrderGateway writes flat or
into a per-order subdirectory depending on whether "Container Path Use Subdirs" is ticked, so check
both. Richard hasn't confirmed which his gateway uses.

**Tests** (`fuji-pic-pro-monitor.test.js`, real tmpdir + `_scanNow`): each phase transition; gateway
timeout; build timeout; a file that vanishes before its timeout; restart recovery from a
pre-populated pending store; `startMonitoring` idempotency with no leaked watchers or timers; a
throwing callback not breaking later scans; release written only when the toggle is on; release
**not** written when the build timed out.

---

## M5 — Dispatch

`print-service._sendViaFujiPicProRouted(job, route)`, wired into `sendViaDPOFRouted` (`:208`,
add the arm next to the `fujijobmaker` one at `:222-224`).

Copy the shape of `_sendViaFujiJobMakerRouted` (`:1821-1994`) exactly for steps 1–4, because that is
what makes the **cropped** file the one that ships:

1. `downloadDirectory` → `orderFolderPath` → `jobFolderPath`; throw if missing.
2. `_readManifest` + `_findJobInManifest`.
3. Guard: no `route.printCode` or no `route.printSize` → set `_status:'error'` with a message
   pointing at Settings → Routing, return `{success:false}`.
4. `_getEnhancedPathMap` → `resolveDispatchImageSource` → `_applyCorrectionsToImageFiles`, then
   `existsSync` every source. **This ordering is what gives you the cropped file** — the sidecar's
   `cropApplied`/`croppedPath` wins over `enhanced`, then root → `/working/` → `/originals/`.
5. `stageImages(...)` → sequence-renamed images + `negNumberMap`.
6. Build the generator job from `negNumberMap` + manifest quantities + `route.printCode` /
   `route.color`; `generateFujiPicProOrderFile(...)`.
7. `writeOrderFile(...)` into Order Data.
8. Enqueue the pending submission and `startMonitoring(route.controllerId)`. **Return immediately** —
   do not await the handshake.
9. `route.checkOrderStatus === false` → `_markCompleted`, else `_markInProduction`.

Return `{ success: true, method: 'fujipicpro-routed', sourcePath: jobFolderPath, orderFilePath,
stagedFolder, negNumberMap }`.

`orderId` = `job.job_name || job.order_number`, matching JobMaker. Per-job, not per-order, so two
jobs from one order don't collide in PIC Pro.

**Reprints** — `_sendReprintViaFujiPicPro`, wired into `sendReprint` (`:713`, branch list at
`:736-738`). Sources from `{reprintJobPath}/originals/` with no manifest and no
`resolveDispatchImageSource`, exactly like the JobMaker reprint. `orderId` =
`{parentOrderRef}-{reprintSuffix}` → a **new** PIC Pro order. Do **not** use PIC Pro's native
`[restart]` — OHD reprints are a re-cropped subset and `[restart]` would reprint the original order.
Does not mark completed/in-production and does not start monitoring, per the JobMaker precedent.

**Tests:** `print-service-reprint-fujipicpro.test.js`, copying the `Module.prototype.require`
monkey-patch harness from `print-service-reprint-fujijobmaker.test.js` — that file is the best
template in the repo. Add `'fujipicpro'` to the completeness matrix in
`print-service-reprint-dispatch.test.js`. Add a dispatch test asserting a cropped image resolves to
`/working/` and that the emitted `order.txt` contains no `UnitCrop=`.

---

## What is deliberately out of scope

- Templates / composites (`[Comp]`, `[Node]`), greeting cards, CD and index-print products, crop
  cards, `Logo=`, `SlimText*`, `Retouch*`. Pre-cropped prints only.
- `[restart]`. `[delete]` may be implemented as a helper but is not wired to any UI in M6.
- Migrating the existing `folder_copy` controller named "Fuji Pic Pro - Folders". Leave it alone;
  Richard will add the new typed controller alongside, test, then delete the old one.
- M6 (`[release]` wiring beyond the monitor phase), M7 polish and M8 docs/CHANGELOG — separate
  sessions.

## Open items Richard still owes you

None block M0–M5. All four are needed before a live test:

1. Real `orderDataPath`, `diginPath`, `mergeDataPath` values.
2. Whether "Container Path Use Subdirs" is ticked in `OrderGateway.exe` (affects the Merge Data check
   only).
3. One or two real `Code=` values from the lab's print-code table, for the golden fixture.
4. PIC Pro version — behaviour differs at 2.5.56 (JBackprint) and 2.6.x (container subdirs).

Where a value is needed to write a test, use an obviously-fake placeholder and leave a `TODO(richard)`
comment naming what to substitute.

## Definition of done for this session

- `npm test` green, with the new suites included and the baseline count increased.
- `npm run build:renderer` run and the regenerated bundle committed (M0.7 touches `.jsx`).
- Branch not pushed. Richard runs a real order first.
- A short summary of what landed, what you had to guess, and anything you found that contradicts
  this brief — particularly if the M0.7 Approve-button gap turns out not to be real.
