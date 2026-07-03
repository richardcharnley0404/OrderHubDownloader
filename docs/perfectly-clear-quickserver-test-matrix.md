# Perfectly Clear QuickServer — Manual Test Matrix (M6)

Run this checklist against a real Perfectly Clear QuickServer install before
tagging the release. Every item has explicit steps and an expected result;
tick the checkbox when you've verified it end-to-end. Automated tests
already cover the config schema, the shared client, the folder-watch
pipeline branches and the mocked round-trip — this list is deliberately
focused on **behaviours the mocked tests can't prove** (real QuickServer,
network shares, concurrency, retention, dispatch).

**Ground rules for the run**
- Use a clean workstation state where possible (fresh QuickServer, empty
  Input/Output/Rejected folders).
- Watch the Activity Log throughout — several items assert specific log
  lines. Filter on `pc:`, `filmScans:`, `fileUploads:`.
- Don't skip an item just because "it obviously works" — the whole point
  is smoking out silent regressions.

---

## Plan §M6 real-QuickServer matrix

### 1. Same-PC local folders — happy path
- [ ] Same-PC local folders end-to-end.

**Steps**
1. Create three folders on the OHD PC's local disk: `C:\PC\In`, `C:\PC\Out`,
   `C:\PC\Rej`.
2. Point a QuickServer channel at them (any standard preset).
3. In OHD: Settings → AI Enhancement → Perfectly Clear → Jobs. Enable, add
   a config using those three folders, click **Test** — it should return
   green ("Config OK" or equivalent).
4. Open any job in Job Review and click **Enhance This Image** on one file.

**Expected**
- Activity Log shows `pc: batch ohd_… starting` and `pc: batch ohd_… finished
  (enhanced=1, rejected=0, timeout=0, cancelled=0, wallMs=…)`.
- Working file is replaced with the enhanced version (visible in the
  thumbnail refresh + `enhanced` sidecar field).
- Job Review shows **✓ Enhanced via Perfectly Clear** with the channel name.

---

### 2. QuickServer on another PC via SMB
- [ ] Cross-PC channel via SMB share works identically.

**Steps**
1. Install QuickServer on a second PC. Create the three channel folders
   there and share the parent over SMB.
2. From the OHD PC, confirm you can browse to
   `\\quickserver-pc\PC\In`, `…\Out`, `…\Rej` in Explorer.
3. In OHD, add a config pointing at the UNC paths. Click **Test**.
4. Run the same single-image enhance from Job Review that you did in
   item 1.

**Expected**
- **Test** succeeds.
- Enhancement completes end-to-end; ~1–3s of extra latency vs. local is
  normal.
- No warnings about missing folders or write failures in the Activity Log.

---

### 3. Two configs on one scope
- [ ] Multiple configs work independently on the same scope.

**Steps**
1. In Settings → AI Enhancement → Perfectly Clear → Jobs, add two configs
   pointing at two different QuickServer channels with visibly different
   presets (e.g. "Vivid" vs. "Portrait"). Save.
2. Open Job Review with a suitable image. Confirm a **Channel** dropdown
   appears in the Enhance panel.
3. Enhance the image with the first config. Note the visible result.
4. Click **Revert to Original**, then re-enhance the same image with the
   second config.

**Expected**
- Dropdown lists both configs by friendly name.
- Sidecar records `enhancementModel = "<friendlyName>"` matching the config
  used each time.
- The two enhanced results look visibly different from each other, proving
  each channel actually ran.

---

### 4. Concurrent Jobs batch + Film Scans roll — different channels
- [ ] Two scopes running simultaneously on different channels don't
  collide.

**Steps**
1. Configure Perfectly Clear for both Jobs AND Film Scans, each using its
   own QuickServer channel (unique Input/Output/Rejected trios). Set Film
   Scans → **Apply automatically** = one of them.
2. Drop a small film-scan roll (say 6 frames) into the film-scans watch
   folder.
3. While the roll is still in the `Enhancing…` state, jump into Job Review
   for an unrelated job and fire **Enhance Selected** on 4 images.

**Expected**
- Both batches complete cleanly. Activity Log shows two independent
  `filmScans: … PC enhance …` and `pc: job … batch complete` line pairs
  with non-overlapping batch subfolder names (`ohd_{machineId}_{ts}_…`).
- Roll lands in Film Review with all 6 frames enhanced; job shows 4/4
  enhanced.
- No stray files left in either channel's Input/Output/Rejected folders.

---

### 5. QuickServer stopped mid-batch — Jobs
- [ ] Dead QuickServer never wedges Job Review.

**Steps**
1. In Job Review, kick off **Enhance Selected** on ~10 images against a
   channel that's currently running.
2. Immediately stop the QuickServer service (Services applet or the
   QuickServer UI's Stop button).
3. Wait for the wall-clock timeout to fire (default 5 min).

**Expected**
- Job Review's batch progress eventually settles with the started-but-
  unfinished files marked **timed out** in the counter.
- Activity Log shows `pc: job … — <filename> timeout` warnings per file
  and a `pc: job … batch complete (…, timeout=N, …)` summary.
- Working files that never round-tripped keep their original bytes.
- Restart QuickServer, retry the still-timed-out images individually —
  they succeed the second time.

---

### 6. QuickServer stopped mid-batch — Film Scans
- [ ] Dead QuickServer forces a roll into review without wedging.

**Steps**
1. With Film Scans auto-apply set, drop a fresh 10-frame roll into the
   watch folder.
2. As soon as the Activity Log shows `filmScans: … PC enhance starting`,
   stop the QuickServer service.
3. Wait for the wall-clock timeout (`max(5 min, 30 s × frameCount)`).

**Expected**
- Activity Log shows
  `filmScans: … PC timeout for <frame> — kept original` for each frame,
  then `filmScans: … PC timeout/cancel — escalating to review regardless of
  review mode`, then `filmScans: … PC enhance complete — enhanced=0,
  rejected=N, timedOut=true`.
- Roll appears in Film Review with `uploadStatus = pending` regardless of
  the configured review mode. Every frame carries a "PC rejected" flag.
- Original bytes preserved on every frame.

---

### 7. QuickServer stopped mid-batch — File Uploads
- [ ] Dead QuickServer never wedges the file-uploads pipeline.

**Steps**
1. With File Uploads auto-apply set, drop a folder with 5 images into the
   file-uploads watch folder.
2. Once `fileUploads: … PC enhance starting` appears, stop QuickServer.
3. Wait for the timeout.

**Expected**
- Activity Log shows `fileUploads: … PC timeout for <basename> — uploading
  original` (one line per image), then `fileUploads: … PC enhance
  complete — enhanced=0, rejected=0, timeout=5`.
- S3 upload runs afterwards and uploads the **original** bytes.

---

### 8. Junk .txt dropped into an Output folder is tolerated
- [ ] Non-image files in Output do not break OHD.

**Steps**
1. With any channel idle, drop a `garbage.txt` file directly into the
   channel's Output folder (mimicking QuickServer's "skipped file"
   pass-through).
2. Kick a normal single-image enhance from Job Review using the same
   channel.

**Expected**
- The enhance completes normally.
- Activity Log contains no errors or warnings mentioning `garbage.txt`.
- OHD's batch consumes only the file it staged; `garbage.txt` still sits in
  Output afterwards (OHD only sweeps its own batch subfolder).

---

## Items lacking automated coverage

### 9. Film Review per-frame Revert restores the pre-enhance file
- [ ] Revert is byte-identical.

**Steps**
1. Enable Film Scans auto-apply and process a roll so at least one frame
   is enhanced.
2. Before opening Film Review, copy one enhanced storage file to a scratch
   location as "enhanced-copy.tif".
3. Copy the same frame's `pre-enhance/<name>` file to a second scratch
   location as "pre-enhance-copy.tif".
4. Open the roll in Film Review, focus that frame, click **Revert**.
5. Copy the now-restored storage file as "restored-copy.tif".

**Expected**
- `restored-copy.tif` is **byte-identical** to `pre-enhance-copy.tif`
  (verify with `Get-FileHash` / `certutil -hashfile SHA256`).
- `restored-copy.tif` is **different** from `enhanced-copy.tif`.
- Activity Log shows `[filmScan] PC revert <frameId> — restored from
  pre-enhance/`.
- Focused frame's ✓ Enhanced (PC) badge is gone; **Revert** button hides.
- Thumbnail refreshes to show the pre-enhance image.

---

### 10. Retention cleanup removes a roll's pre-enhance/ folder
- [ ] Old rolls have their pre-enhance backup swept.

**Steps**
1. Set Settings → Film Scans → **Retention (days)** to `1`.
2. Manually backdate an existing enhanced roll's storage folder mtimes to
   `> 24 h ago` — including files inside `pre-enhance/`. PowerShell:
   ```powershell
   $past = (Get-Date).AddDays(-2)
   Get-ChildItem 'C:\Path\To\storage\<rollFolder>' -Recurse |
     ForEach-Object { $_.LastWriteTime = $past; $_.CreationTime = $past }
   ```
3. Wait for the next film-scans cycle (or restart OHD).

**Expected**
- Activity Log shows `filmScans: retention pruned N old roll(s) …`.
- The roll's storage folder AND the nested `pre-enhance/` subfolder are
  both gone.
- No orphaned files or partial deletions left behind.

---

### 11. 36-image Select All batch in Job Review with mixed results
- [ ] Realistic-scale mixed-outcome batch completes cleanly.

**Steps**
1. Prepare a job with 36 files. Deliberately mix in 2 files QuickServer
   will reject (e.g. a `.jpg` that's actually empty; a `.jpg` renamed from
   a `.pdf`).
2. In Job Review, enter multi-select, click **Select All**, click
   **Enhance Selected (36)**.

**Expected**
- The batch UI shows a live-updating counter converging to
  `enhanced=34 · rejected=2` (or matching the exact mix you seeded).
- Activity Log shows one `pc: job … — <filename> rejected` warning for each
  of the 2 rejects, plus a single `pc: job … batch complete (…
  enhanced=34, rejected=2, …)` summary.
- The 34 enhanced files show ✓ Enhanced in the rail; the 2 rejected files
  are untouched and show their original state.
- Dismissing the batch banner returns Job Review to normal.

---

### 12. Dispatch of a PC-enhanced job logs 'Using enhanced image'
- [ ] Print dispatch actually picks up the enhanced file.

**Steps**
1. Enhance at least one image in a job (any channel).
2. Dispatch the job to a print controller (Darkroom Pro / Fuji JobMaker /
   DPOF / folder-copy — any route).

**Expected**
- Activity Log shows a `Using enhanced image for … print` line (with the
  filename in the metadata block) — this proves
  `print-service._getEnhancedPathMap` substituted the enhanced file at
  dispatch.
- The file actually written into the controller's queue matches the
  enhanced bytes, not the untouched `/originals/` copy.
- A **reprint** of the same job dispatched afterwards does NOT log
  `Using enhanced image` — reprints deliberately dispatch from
  `/originals/` per the design.

---

## Sign-off

Run through above; note any anomalies against the item number. If every
box ticks, tag the release, bump `package.json`, build the installer, and
publish release notes referencing the M1–M6 milestone series.
