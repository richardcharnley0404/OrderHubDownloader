# OrderHub Desktop v1.16.1 — what's changed

Download from **OrderHub → Settings → Info**.

This is a **small feature release for Fuji JobMaker labs** where
OHD and the Fuji JobMaker machine run on different boxes, plus a
carried-forward fix for the Perfectly Clear batch runner. If you
don't use Fuji JobMaker AND don't use Perfectly Clear, this
release has no impact and you can install or skip at leisure.

**Reassuring fact up front.** For every existing Fuji JobMaker
controller, the new field is pre-filled from the value already on
your controller, and the emitted `.txt` file is byte-identical to
what 1.16.0 produced. No operator action is required to upgrade —
open Settings, save the controller, done. If you never open it,
your controllers keep working with no change.

## Installing

Windows will warn you that the publisher is unknown. That's
expected — our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run
   anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings,
controllers, channel mappings, and any in-flight jobs are all
preserved.

---

## New — Fuji JobMaker: image path for OHD and image path for the Fuji machine can now differ

**Who this is for.** Labs running OHD and Fuji JobMaker on
different machines. If both run on the same machine, this release
changes nothing for you — the migration default keeps everything
identical.

**The problem this fixes.** OHD writes the `.txt` job file for
Fuji JobMaker with an `ImagePath=` line pointing at where OHD
wrote the images. Before 1.16.1 that path was OHD's local path —
e.g. `C:\Users\op\Documents\OrderHub Controllers\Fuji Jobmaker\Artwork\{orderRef}\`.
When the `.txt` sits in a hot folder that a different machine
reads, that machine tries to open the same drive-letter path and
finds nothing. The order sits in the hot folder until Frontier's
Failure Timeout fires 30 minutes later, with nothing telling the
operator why.

**The fix.** Two separate fields on the Fuji JobMaker controller:

- **Image Staging Root** (existing) — where OHD writes the image
  files. This is OHD's local view of the folder.
- **Image Path (Fuji JobMaker view)** (new) — the same folder
  expressed as the Fuji JobMaker machine reaches it. This is what
  OHD writes into `ImagePath=` in the `.txt`.

If OHD and Fuji JobMaker run on the **same machine**, the two are
the same path. That is the migration default — every existing
controller opens post-upgrade with **Image Path (Fuji JobMaker
view)** pre-filled to match **Image Staging Root**. Save
immediately with no changes and the controller keeps working.

If OHD and Fuji JobMaker run on **different machines**, set
**Image Path (Fuji JobMaker view)** to whatever the Fuji machine
sees the same folder as — typically a UNC share
(`\\labserver1\Pixfizz\Artwork\`) or a mapped drive letter as
configured on the Fuji machine. **Image Staging Root** stays as
OHD's local write path.

Worked example. OHD sits on Machine A; Fuji JobMaker runs on
Machine B. Both see the same physical share `\\labserver1\Artwork`.

- OHD's view of the share: `Z:\Artwork` (Machine A has it mapped
  as drive Z).
- Fuji JobMaker's view of the share: `\\labserver1\Artwork` (via
  UNC directly).
- Set **Image Staging Root** to `Z:\Artwork` (OHD writes here).
- Set **Image Path (Fuji JobMaker view)** to
  `\\labserver1\Artwork` (this is what goes into `ImagePath=`).

The emitted `.txt` will read:
`ImagePath=\\labserver1\Artwork\{orderRef}\`. Fuji JobMaker
resolves that string on Machine B and finds the artwork exactly
where OHD wrote it.

**Two safety checks OHD runs for you.**

1. **At save**, OHD tries to reach the entered path from its own
   side. If it can't, you see an advisory dialog naming the path
   and the reason. **This is a warning, not a block** — a path
   that is correct for the Fuji machine may legitimately be
   unreachable from the machine running OHD (Machine A might not
   have the same drive letters as Machine B, or might not have
   direct SMB access to the share). Saving proceeds either way.

2. **At dispatch**, before writing the `.txt`, OHD checks that the
   order's artwork folder is reachable via the configured path. If
   the path root exists but the order subfolder is missing, OHD
   fails the job with a specific error naming both the OHD-side
   and Fuji-side paths — this is a real configuration bug and
   catching it at dispatch turns a 30-minute stall into an
   immediate red job with an actionable message. If the path root
   is unreachable from OHD entirely (the legitimate cross-machine
   case), dispatch proceeds and Fuji is left to be the
   authoritative check; a warning is logged to the Activity Log so
   a real bug still leaves a trail.

**What NOT to do.** Do not set **Image Path (Fuji JobMaker
view)** to a folder that resolves from OHD's side but points at a
different physical location than **Image Staging Root** — that is
the exact bug the dispatch-time check is there to catch. If both
paths resolve from OHD and they point at different folders, OHD
will fail every dispatch until you fix the mapping.

---

## Fixed — Perfectly Clear batch runner no longer escapes an unhandled rejection on slow filesystems

This fix has been sitting under `## Unreleased` since v1.16.0 and
ships as part of this release. It affects labs that run image
enhancement through a Perfectly Clear QuickServer hot folder on a
slow SMB share.

**Before this fix.** OHD wraps every file-system call the batch
runner makes in a per-op deadline — so a wedged SMB share can't
hang the whole batch. Most of the runner handled a deadline as
"observation missed, keep polling until wall clock". The
setup-phase filesystem calls — the initial folder creation and
the per-file staging copy — did NOT: a deadline there escaped as
an unhandled rejection, and the batch effectively failed with an
opaque error rather than resolving cleanly at its wall-clock
timeout.

Never surfaced in production (production timeouts are well above
realistic filesystem speeds), but did surface intermittently in
CI on Windows under contention. Fix is symmetrical: setup now
handles a deadline the same way the poll loop does. See the
detailed writeup in CHANGELOG.md.

**What operators should see.** Nothing. In practice this fix has
no visible effect on any lab that has been running successfully;
it plugs a hole that would have surfaced under a slow-share
failure mode that would otherwise have been diagnosed as "OHD
crashed on a batch" rather than the wall-clock-timeout it should
have been.

---

## Nothing else in this release

No changes to any other controller type (Darkroom Pro, DPOF /
Epson / Noritsu, PDF Copy imposition, Folder Copy, Fuji PIC Pro,
Frontline). No changes to XML hot folders. Everything else
works exactly as it did in 1.16.0.

---

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity
Log tab is the quickest place to spot the cause. If a Fuji
JobMaker job goes red with the new "dispatch stopped" error
message, the message itself names both paths and the fix; try
that first, and let us know if the wording was unclear.
