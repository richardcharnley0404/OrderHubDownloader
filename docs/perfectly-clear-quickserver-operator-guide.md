# Perfectly Clear QuickServer in OHD — Operator Guide

OHD can route images through a
[Perfectly Clear QuickServer](https://www.perfectlyclear.com/) hot folder to
enhance them before they leave the lab. This guide is for lab managers and
operators who set up and use the feature. The design details live in
[`perfectly-clear-quickserver-feasibility.md`](perfectly-clear-quickserver-feasibility.md)
and
[`perfectly-clear-quickserver-implementation-plan.md`](perfectly-clear-quickserver-implementation-plan.md).

---

## How it works

QuickServer watches a folder ("Input"), enhances every image dropped into it,
and writes the enhanced result to another folder ("Output"). Files it can't
process — corrupt images, empty files with a .jpg extension, unsupported
formats — land in a third folder ("Rejected"). This set of three folders is
called a **channel** in QuickServer. OHD talks to QuickServer only through
these folders: it never touches QuickServer itself.

OHD can use QuickServer in three separate places, each with its own set of
channels:

- **Jobs** — the operator picks images in Job Review and clicks Enhance.
  Manual only; there is no auto-apply here by design.
- **Film Scans** — every incoming roll can auto-apply a channel *before*
  Film Review, so the operator reviews enhanced frames.
- **File Uploads** — files dropped into the file-uploads watch folder can be
  auto-enhanced before they land on S3.

You can wire the same OHD PC to a QuickServer running on the same PC or on a
different PC on the network (SMB share). QuickServer supports JPEG, PNG and
TIFF; OHD sends only those file types through and leaves any other files
untouched.

---

## 1. Set up the QuickServer channel

Do this in QuickServer, before configuring OHD.

1. Create three folders — anywhere QuickServer can see them:
   - `…\PC\Input\` — the folder QuickServer will watch.
   - `…\PC\Output\` — where enhanced results appear.
   - `…\PC\Rejected\` — where unprocessable files go.
2. In QuickServer, create a **channel** using those three folders. Pick a
   preset that matches what the lab wants (portrait/landscape/etc.). Save.
3. Confirm the channel is running (QuickServer's status should show it green).

If OHD and QuickServer are on different PCs, share the parent folder over
SMB so the OHD PC can reach `\\quickserver-pc\PC\Input`, `…\Output`,
`…\Rejected`. The Windows user running OHD needs read+write on Input and at
least read on Output/Rejected.

---

## 2. Point OHD at the channel

In OHD: **Settings → AI Enhancement → Perfectly Clear**.

You'll see three sections, one per scope: Jobs, Film Scans, File Uploads.
Each works the same way:

1. Tick **Enable Perfectly Clear for X**.
2. Click **+ Add Config** to create an OHD configuration for the channel.
3. Fill in:
   - **Friendly name** — how the channel will appear in dropdowns
     (e.g. "Portraits", "Sports HDR").
   - **Input folder** — the QuickServer channel's Input folder.
   - **Output folder** — the channel's Output folder.
   - **Rejected folder** — the channel's Rejected folder.
4. Click **Test** on the config row. OHD checks that all three folders
   exist and drops a tiny `ohd_probe_….txt` file into Input to prove it
   can write there. (QuickServer treats .txt as a "skipped" file and either
   ignores it or passes it through to Output; OHD cleans up either copy.)
5. For **Film Scans** and **File Uploads**, use the **Apply automatically**
   dropdown to pick which config runs on every incoming roll / upload.
   Leave it on **Off** to keep the feature purely manual.
6. **Save Settings.**

You can add more than one config per scope — for example one Film Scans
config for standard rolls and another for HDR — and switch between them per
job in Job Review, or set one as the auto-apply default.

### Folder rules OHD enforces

At save time OHD checks:

- All three folders exist on disk. Missing folder → save is rejected with
  "input folder does not exist" (etc.). Create the folder in Windows and
  save again.
- **Every Input folder is unique across all scopes.** QuickServer forbids
  two of its own channels from watching the same folder, and OHD extends
  the rule across scopes so Jobs and Film Scans can't accidentally share a
  channel.
- **Output and Rejected must not sit inside any Input folder.** This
  prevents a feedback loop where QuickServer's own output ends up back in
  its watch folder.
- If a scope is **enabled** but has zero configs, the save is rejected —
  either add at least one config, or untick Enable.

If you get a validation error at save, the message names the offending
row (e.g. "Film Scans row 2 (Portraits): output folder is required.").

---

## 3. Using it — Job Review

Job Review's AI Enhancement panel replaces the old Pixfizz/Topaz controls
when Perfectly Clear is enabled for Jobs.

**Single image**
- Select an image in the thumbnail rail.
- If more than one config is configured, pick one from the **Channel**
  dropdown (OHD remembers the last one you used).
- Click **✨ Enhance This Image**. OHD copies the image into the channel's
  Input folder, waits for QuickServer to enhance it, and swaps the enhanced
  result into place.
- When done, the panel shows **✓ Enhanced via Perfectly Clear** and the
  channel name.

**Many images at once**
- Click **Select Multiple Images…** to switch the thumbnail rail into
  multi-select mode (a checkbox appears on each card).
- Tick the images you want, or click **Select All**.
- Click **Enhance Selected (n)**. OHD sends them all through as one batch.
  A live counter shows enhanced / rejected / timed-out counts as each file
  resolves.

**Revert to original**
- Select any image that shows the **✓ Enhanced via Perfectly Clear** badge.
- Click **Revert to Original**. OHD restores the pre-enhance working file
  byte-for-byte. Crop and rotation are left alone.

Reprints deliberately ignore enhancement — they always dispatch from the
job's `/originals/` folder. That is by design: a reprint should look
identical to what the customer originally received.

---

## 4. Using it — Film Scans

If **Film Scans → Apply automatically** is set to a channel:

1. A new roll lands in the watch folder as usual.
2. OHD copies it to storage and runs rotation + thumbnails.
3. Before the roll opens Film Review, OHD sends the whole roll through the
   selected channel. The Film Review roll list shows the roll as
   `Enhancing…` during this step.
4. Successful frames have their storage file replaced with the enhanced
   version and a fresh thumbnail. Rejected frames keep their original bytes
   and get a small "PC rejected" flag.
5. When enhancement finishes the roll continues to Film Review (or straight
   to S3 upload, depending on the review mode).

**If QuickServer times out** (channel down, dead PC, offline share), OHD
still lets you review the roll — timeouts escalate it into Film Review
regardless of the review mode, with the affected frames flagged. The
pipeline never gets stuck.

**Per-frame Revert in Film Review**
Every frame OHD auto-enhances also has a **pre-enhance backup** kept next
to it (`{rollFolder}/pre-enhance/…`). In Film Review:

- Open the focused frame.
- If the frame shows **✓ Enhanced (PC)**, a **Revert** button appears next
  to the Enhance button. Click it — the storage file is restored from the
  backup, byte-identical to what QuickServer saw.

**Per-frame Enhance in Film Review**
You can enhance any frame manually — even on a roll that wasn't auto-applied
— using the **Enhance** button on the focused frame. Pick a channel if more
than one is configured. Works on TIF and JPG scans alike.

**Retention cleanup** sweeps the `pre-enhance/` folder together with the
roll — the same retention setting that already governs how long old rolls
live on the storage folder.

---

## 5. Using it — File Uploads

File Uploads has no review UI — it just needs to work. If
**File Uploads → Apply automatically** is set to a channel:

1. A folder appears in the file-uploads watch folder.
2. OHD copies it to the file-uploads storage folder (the usual step).
3. Before uploading to S3, OHD sends every image in the folder through the
   channel. Enhanced images replace their storage file in-place; rejected
   or timed-out images keep their originals and get a warning line in the
   Activity Log.
4. S3 upload runs on whatever is now in the storage folder — enhanced where
   QuickServer succeeded, originals where it didn't.

Non-image files (PDF, TXT, ZIP, MP4, …) pass through untouched.

---

## 6. What you'll see in the Activity Log

Every batch OHD sends emits a start + finish line, plus a warning for each
rejected/timed-out file. Examples:

```
INFO  filmScans: 2026-07-03/ROLL-42 PC enhance starting (config="Portraits", files=36, timeoutMs=1080000)
WARN  filmScans: 2026-07-03/ROLL-42 PC rejected frame_017.tif — kept original (empty input)
INFO  filmScans: 2026-07-03/ROLL-42 PC enhance complete — enhanced=35, rejected=1, timedOut=false

INFO  ohd:enhancement:batchRun started {"jobId":"PZ12345","count":8,"configId":"cfg-1"}
WARN  pc: job PZ12345 — DSC_0043.jpg rejected
INFO  pc: job PZ12345 batch complete (config="Portraits", enhanced=7, rejected=1, timeout=0, cancelled=0, error=0)

INFO  fileUploads: upload-2026-07-03 PC enhance starting (config="Uploads Standard", files=12, timeoutMs=360000)
WARN  fileUploads: upload-2026-07-03 PC timeout for IMG_2201.jpg — uploading original
INFO  fileUploads: upload-2026-07-03 PC enhance complete — enhanced=11, rejected=0, timeout=1
```

The shared QuickServer client also emits its own lower-level lines prefixed
`pc: batch ohd_…`. Those are for debugging and won't usually be relevant
day-to-day.

---

## 7. Common problems

| What you see | What it probably means |
|---|---|
| Save Settings error: "input folder does not exist" | Create the folder in Windows (or fix the typo) and save again. |
| Save error: "input folder must be unique across all Perfectly Clear configurations" | Two configs point at the same Input folder — QuickServer would reject that too. Use one config per channel, or split into two channels. |
| Save error: "output folder must not be inside an input folder" | Move Output/Rejected out from under Input so QuickServer's own output doesn't re-trigger it. |
| Test button: "Input folder is not writable" | The Windows user running OHD lacks write access on the share. Fix share permissions or map the drive with the right credentials in Windows Credential Manager. |
| Film Review roll stuck showing "Enhancing…" for a long time, then opens with lots of PC-rejected frames | QuickServer was probably down or the channel was disabled while OHD was sending. OHD forces the roll into review after the wall-clock timeout so nothing wedges. Fix the QuickServer channel and use per-frame Enhance in Film Review to re-do them. |
| File uploads reach S3 but look unenhanced | Check `Settings → AI Enhancement → Perfectly Clear → File Uploads`: **Apply automatically** may be **Off**. Also check the Activity Log for `PC unavailable` / `PC processBatch threw` lines. |
| Job Review Enhance button says "Configure Perfectly Clear in Settings" | The Jobs scope isn't enabled, or has zero configs. Add one in Settings → AI Enhancement. |

If a scope is disabled entirely, OHD does absolutely nothing PC-related in
that scope — no folder writes, no log lines. The scope is a strict no-op.
