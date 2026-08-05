# Fuji PIC Pro — review findings, M0–M5

Review of commits `afe4fc6` → `105a859` (2026-08-02), before any live order.
Severity is about what reaches the printer, not code quality.

Two independent reviewers; every item below was re-verified by reading the code directly
unless marked **UNVERIFIED**.

---

## Fix before any live test

### 1. `Qty` and `{originalFilename}` are lost on any CMY-corrected image — CONFIRMED
`src/main/services/print-service.js:2352` and `:2357`

`_applyCorrectionsToImageFiles` returns `{ sourcePath, filename }` only — it drops every
other key (`print-service.js:3075`). Images with no corrections are passed through
untouched (`:3046`), so the bug is invisible until someone touches a CMY slider.

`_sendViaFujiPicProRouted` reassigns `imageFiles` to that stripped result (`:2301`) and
then reads `imageFiles[i].quantity` and `imageFiles[i].originalFilename` off it.

**Trigger:** any image with a non-zero CMY correction and `quantity >= 2`.
**Consequence:** `Qty=1` in `order.txt` — the customer gets one print instead of N — and
the back-print `{originalFilename}` comes out blank.

**Fix:** read both from the manifest, not from `imageFiles`. JobMaker already does this
correctly (`quantity: manifestImg.quantity || 1` at `:2050`-ish); mirror it. Same bug is
worth checking in `_sendReprintViaFujiPicPro` (`:1354`, `:1356`), which reads `qtyCurrent`
off a similarly post-processed array.

**Test:** an image with corrections AND `quantity: 3` must still emit `Qty=3`.

### 2. Enter/Space bypasses the new Approve gate — CONFIRMED
`src/renderer/views/JobReview/ManualCropMode.jsx:619-622`

Commit `35d50bc` added `targetSizeReady` to `canApprove` (`:1016`), which gates the
button's `disabled` at `:1175`. But the keydown handler calls `approveAndAdvance()`
directly with no check:

```js
case 'Enter':
case ' ':
  e.preventDefault();
  approveAndAdvance();
  break;
```

**Trigger:** any job showing `⚠ No size translation`; press Enter or Space — which is the
shortcut the tooltip itself advertises.
**Consequence:** every image approved at a 1:1 square crop, Send to Print enabled. This is
the original bug, still open. The commit message claims it is fixed.

**Fix:** gate inside `approveAndAdvance` itself rather than at each call site, so the
button, the keyboard and any future caller are covered by one guard. Rebuild the bundle.

### 3. Every phase transition trusts `fs.existsSync` returning false
`src/main/services/fuji-pic-pro-monitor.js:350`, `:385`, `:396`

`existsSync` returns false for an unreachable SMB share and for EACCES, not only for
"genuinely gone". All three phase gates read a missing file as success.

**Trigger:** a momentary network or permission blip on Order Data, DIGIN or Merge Data —
routine on a lab share.
**Consequence:** a blip on Order Data delivers images to DIGIN while the `.txt` is still
sitting there, which is exactly the sequencing the spec forbids. A blip on DIGIN or Merge
Data fires `[release]` for an order that never built.

**Fix:** distinguish "confirmed absent" from "couldn't tell". Use `fs.promises.stat` and
treat only `ENOENT` as absent; on any other error log and stay in the current phase — the
timeout is the backstop. Consider requiring two consecutive absent observations before
advancing, given what a false positive costs here.

---

## Fix before shipping

| # | File:line | Defect | Consequence |
|---|---|---|---|
| 4 | `print-controller-service.js:174` | No PIC Pro monitor is started at boot — only dispatch calls `startMonitoring` | Restart mid-handshake and the persisted entry is never rehydrated until the next dispatch to that controller. Images sit in staging; PIC Pro holds an image-less order; nothing surfaces. |
| 5 | `fuji-pic-pro-monitor.js:298` | `_scan` re-enters itself — `setInterval` (`:292`) and the `fs.watch` debounce (`:267`), neither awaited, no in-flight guard | A DIGIN move slower than the 1 s sweep runs twice: a half-copied folder renamed into DIGIN, or the entry dropped with no `[release]` and no timeout. Precedent for the fix is `folder-watch-service`'s `_uploadingRolls` Set. |
| 6 | `fuji-pic-pro-monitor.js:507` | All monitor instances share one store key; `controllerId` is written at `:219` but never read back | Two `fujipicpro` controllers and each instance's `_persist()` erases the other's queue and drives the other's orders. |
| 7 | `fuji-pic-pro-monitor.js:380` | `_advance` persists the phase only *after* the DIGIN move, and `deliverToDigin` is not idempotent | Crash in that window: the replayed `delivering` phase throws (staging gone, or rename onto an existing destination = EPERM on Windows) and marks a successfully delivered order failed, with `[release]` never sent. |
| 8 | `fuji-pic-pro-file-writer.js:97` | Staging folder is `mkdir -p`'d without clearing, and no failure path cleans it up | Retrying a job that failed after staging ships stale `000N.<ext>` files. If an extension changed between attempts, the extension-less `NegNumber=0001` can bind to the previous image — **wrong picture printed**. Staging also grows without bound. |
| 9 | `fuji-pic-pro-monitor.js:231` | `enqueueSubmission` overwrites an existing entry for the same orderId, silently | Double-dispatch drops the in-flight order's `[release]` and timeout while new staging writes into the folder the first delivery is renaming. |
| 10 | `fuji-pic-pro-file-writer.js:236` | EXDEV copy fallback has no cleanup on failure and merges into the leftover `.ohdtmp` on retry | A part-way copy leaves `{orderId}.ohdtmp` inside DIGIN; the next attempt merges it, delivering an order assembled from two attempts. |
| 11 | `print-service.js:2414` | `.txt` is written before any pending entry exists; the no-monitor branch still returns `success:true` and marks the job in production | Kill between write and enqueue, or a blank `route.diginPath`: OrderGateway builds an image-less order while OHD reports success. The gateway-timeout path also leaves the `.txt` behind with no `[delete]`. |
| 12 | `print-service.js:2271` | PIC Pro dispatch hard-fails on a blank `printSize` — a crop-only field neither the generator nor the writer reads. JobMaker (`:2050`) correctly does not | A mapping whose `printCode` is a lab package code gets a blank `printSize` from the backfill, so a perfectly valid order never reaches OrderGateway. Make it a save-time requirement only, matching JobMaker. |
| 13 | `ipc-handlers.js:1259` | Writes back `normalized.color`, but `cmSaveBtn` never puts `color` on the payload and `saveChannelMapping` full-replaces the record | Editing any field on a `fujipicpro` mapping whose colour is `B` or `S2` silently resets it to `C` — prints colour instead of black and white. There is no colour input in the UI at all; either add one or stop round-tripping the field. |
| 14 | `fuji-pic-pro-config.js:109` | Validator checks each path is non-empty but never checks `imageStagingRoot` against `diginPath` | Set them equal and images land in DIGIN at stage time, before the `.txt` exists; the move becomes a no-op and every order breaks while reporting `accepted`. |

---

## Pre-existing — NOT caused by this work

**CSV channel-mapping import is silently broken for DPOF controllers.**
`src/renderer/renderer.js:6147` always sends `printSizeCode: ''`, and `:6155` does
`imported++` without checking `result.success`. Since v1.7.22 made print size mandatory
server-side, every row is rejected while the summary reports "N mappings imported, 0
skipped" and nothing persists.

Verified absent from the M0–M5 diff (`git diff afe4fc6~1 105a859 -- src/renderer/renderer.js`
touches neither line). Worth fixing, but as its own commit — it is a v1.7.22 regression,
not a PIC Pro one.

---

## Unverified — confirm or discard

One reviewer reported that `getAllSizeOptions`' new Fuji source (Source 3) collides with
DPOF options because a downstream consumer merges by `{w,h}` last-write-wins, so a lab
with both a Noritsu 4x6 mapping and a Fuji `printSize` 4x6 could get the Fuji
`channelMappingId` onto the merged dropdown row — and cropping would then stamp
`_channelMappingOverride` and silently reroute the job to the Fuji printer.

I could not find any `{w,h}` dedupe in `routing-service.js` — Source 3 simply pushes onto
the same array (`:838-850`). Either the merge is in the renderer's Crop-to-Size dropdown
or the finding is wrong. **Check before dismissing** — a silent reroute to the wrong
printer is the worst outcome on this list. If a merge does exist, make it key on
`sizeOption.id`, not dimensions.

---

## Repo state

- All 8 commits are on **`main`**, not a branch. `main` is 8 ahead of `origin/main`, and
  the four earlier docs commits are underneath them — so `git push` now would publish
  untested PIC Pro code along with the docs. Either move the PIC Pro commits onto a branch
  and push only the docs, or hold the push entirely until after the live test.
- `docs/fuji-pic-pro-investigation-and-plan.md` and
  `docs/fuji-pic-pro-claude-code-brief.md` are still **untracked**.
- One flaky test noted by the build session (`perfectlyClearClient.test.js` "stability
  polling") is a 30 ms write race under full-suite load, in code untouched by this work.
  Worth a follow-up but not a blocker.
