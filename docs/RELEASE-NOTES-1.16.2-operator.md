# OrderHub Desktop v1.16.2 — what's changed

Download from **OrderHub → Settings → Info**.

This release covers **two areas**: Fuji JobMaker and Folder Copy.
It also includes a small Perfectly Clear fix. If you don't use any
of those three things, this release has no impact and you can install
or skip at leisure.

**Note for labs upgrading from v1.16.0.** A v1.16.1 was built but not
distributed — no lab ever installed it — so labs go directly from
v1.16.0 to v1.16.2. Everything v1.16.1 would have brought is folded
into this release, so this document is the single reference for both
the Fuji JobMaker Image Path field (which would have shipped in
v1.16.1) and the Folder Copy changes (new in v1.16.2). You don't
need to read a v1.16.1 document, and there is no separate v1.16.1
installer to look for.

**Reassuring fact up front.** Every existing controller — Fuji
JobMaker, Folder Copy, or anything else — opens post-upgrade with
its saved settings intact. The one behavioural change that reaches
every Folder Copy controller automatically is a safety improvement:
OHD no longer overwrites files that already exist in a copy-to
folder (see below). No new folder gets created for jobs that would
have written into an existing folder before; no filenames get
renamed until a collision would actually have overwritten
something.

## Installing

Windows will warn you that the publisher is unknown. That's expected
— our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers,
channel mappings, and any in-flight jobs are all preserved.

---

## Fuji JobMaker — Image Path for OHD and Image Path for the Fuji machine can now differ

**Who this is for.** Labs running OHD and Fuji JobMaker on different
machines. If both run on the same machine, this release changes
nothing for you — the migration default keeps everything identical.

**The problem this fixes.** OHD writes the `.txt` job file for Fuji
JobMaker with an `ImagePath=` line pointing at where OHD wrote the
images. Before this release that path was OHD's local path — e.g.
`C:\Users\op\Documents\OrderHub Controllers\Fuji Jobmaker\Artwork\{orderRef}\`.
When the `.txt` sits in a hot folder that a different machine reads,
that machine tries to open the same drive-letter path and finds
nothing. The order sits in the hot folder until Frontier's Failure
Timeout fires 30 minutes later, with nothing telling the operator
why.

**The fix.** Two separate fields on the Fuji JobMaker controller:

- **Image Staging Root** (existing) — where OHD writes the image
  files. This is OHD's local view of the folder.
- **Image Path (Fuji JobMaker view)** (new) — the same folder
  expressed as the Fuji JobMaker machine reaches it. This is what
  OHD writes into `ImagePath=` in the `.txt`.

If OHD and Fuji JobMaker run on the **same machine**, the two are
the same path. That is the migration default — every existing
controller opens post-upgrade with **Image Path (Fuji JobMaker
view)** pre-filled to match **Image Staging Root**. Save immediately
with no changes and the controller keeps working.

If OHD and Fuji JobMaker run on **different machines**, set **Image
Path (Fuji JobMaker view)** to whatever the Fuji machine sees the
same folder as. **Image Staging Root** stays as OHD's local write
path.

**Prefer a UNC share (`\\server\share\...`) over a mapped drive
letter (`Z:\...`).** Both work when they're right, but a UNC path is
safer against a specific configuration accident: mapped drive letters
are per-Windows-user state, and if the OHD machine happens to have
its own `Z:` mapped to something unrelated, OHD's dispatch-time
reachability check can misinterpret it as a broken config. A UNC
path either resolves to the same physical share on both machines or
does not resolve at all on OHD, and OHD handles both cases correctly.
If your only option is a mapped drive letter because that's what the
Fuji machine is configured with, that's still supported — just
double-check the OHD machine doesn't have a different `Z:` (or
whichever letter) mapped to something else.

Worked example. OHD sits on Machine A; Fuji JobMaker runs on Machine
B. Both see the same physical share `\\labserver1\Artwork`.

- Fuji JobMaker's view of the share: `\\labserver1\Artwork`
  (Machine B accesses it via UNC directly).
- OHD's view of the share: `Z:\Artwork` (Machine A happens to have
  it mapped as drive Z — but OHD can also reach it as UNC).
- Set **Image Staging Root** to `Z:\Artwork` (OHD writes here — the
  local mapped drive is fine because this field never leaves Machine
  A).
- Set **Image Path (Fuji JobMaker view)** to `\\labserver1\Artwork`
  — the UNC form — because this string is what goes into
  `ImagePath=` and gets read on Machine B, where a mapped drive
  letter might mean something different.

The emitted `.txt` will read:
`ImagePath=\\labserver1\Artwork\{orderRef}\`. Fuji JobMaker resolves
that string on Machine B and finds the artwork exactly where OHD
wrote it.

**Two safety checks OHD runs for you.**

1. **At save**, OHD tries to reach the entered path from its own
   side. If it can't, you see an advisory dialog naming the path
   and the reason. **This is a warning, not a block** — a path that
   is correct for the Fuji machine may legitimately be unreachable
   from the machine running OHD. Saving proceeds either way.

2. **At dispatch**, before writing the `.txt`, OHD checks that the
   order's artwork folder is reachable via the configured path. If
   the path root exists but the order subfolder is missing, OHD
   fails the job immediately with a specific error naming both the
   OHD-side and Fuji-side paths — this is a real configuration bug
   and catching it at dispatch turns a 30-minute stall into a red
   job with a message you can act on. If the path root is
   unreachable from OHD entirely (the legitimate cross-machine
   case), dispatch proceeds and Fuji is left to be the authoritative
   check; a warning is logged to the Activity Log so a real bug
   still leaves a trail.

**What NOT to do.** Do not set **Image Path (Fuji JobMaker view)**
to a folder that resolves from OHD's side but points at a different
physical location than **Image Staging Root** — that is the exact
bug the dispatch-time check is there to catch. If both paths resolve
from OHD and they point at different folders, OHD will fail every
dispatch until you fix the mapping.

---

## Folder Copy — OHD no longer overwrites existing files in a copy-to folder

**Who this is for.** Every Folder Copy controller. This one is
automatic — no setting, no opt-in.

**The change.** Before writing any file into a Folder Copy
destination, OHD now checks whether a file with the same name is
already there. If there is, OHD adds a `_2` (or `_3`, `_4`, and so
on) suffix to the incoming file's name and writes that instead of
replacing the existing file. This runs regardless of the filename
template — a blank template, a template with tokens, a template
that shares a name across jobs — nothing OHD writes can silently
replace an existing file. The check runs against actual files on
disk in the destination folder, so it catches collisions across
dispatches (not just within a single dispatch, which was already
covered).

**One thing worth knowing.** Dispatching the same job into the same
folder twice used to produce the same set of filenames both times —
the second dispatch quietly overwrote the first with identical
output. That behaviour is gone. The second dispatch now adds a
second set of files with `_2` suffixes. If you deliberately re-run
a job, you'll see duplicates rather than silent replacement, and
the Activity Log records how many files were suffixed by this check
(shown as `diskSuffixedCount`) so you can spot an accidental
re-dispatch.

**Why the change.** Silent overwrite is invisible until an operator
notices a file missing weeks later. `_2` is visible in the folder
listing and in the Activity Log the moment it happens. The tradeoff
is intentional: safety wins over quiet idempotence.

The pre-1.16.2 save-time hard blocks on some Folder Copy template
shapes (a Root layout with a blank template, or a template without
`{orderNumber}`/`{jobName}`/`{jobId}`) have been softened to
advisories at the same time. The blocks existed to prevent silent
overwrite; the new safety guarantee makes them unnecessary. Saving
still shows an advisory dialog explaining what the chosen shape
means, but the save goes through.

---

## Folder Copy — new "Omit OrderHub job Id" checkbox

**Who this is for.** Operators who want cleaner folder names for
jobs on multi-job orders. Existing controllers keep their current
folder names unless someone ticks the new box.

**What the folder names look like.** Folder Copy has always placed
each job under a per-job subfolder named
`{orderNumber}_{jobId}/`. For example:

```
{OutputPath}\PXDEMO-091YEC_53912\
{OutputPath}\PXDEMO-091YEC_53913\   ← second job on the same order
```

The new **Omit OrderHub job Id** checkbox (Settings → Routing →
Folder Copy controller → Destination layout section) drops the job
Id suffix so both jobs land under one folder:

```
{OutputPath}\PXDEMO-091YEC\        ← both jobs together
```

**Default is OFF for existing controllers.** Every controller that
existed before this release keeps its `{orderNumber}_{jobId}/`
folder shape, no operator action required. If you never open the
controller and tick the box, nothing changes.

**Default is ON for newly created controllers.** When you click
**Add Controller** and pick Folder Copy, the new controller opens
with **Omit OrderHub job Id** already ticked, because that's the
folder shape operators asked us for. Untick it before saving if
you want the pre-1.16.2 `{orderNumber}_{jobId}/` shape on the new
controller.

**One thing to keep in mind when it's on.** With the job Id
omitted, two jobs on the same multi-job order share a folder. Their
image files land in the same directory. That means the filename
template matters more than it did before — if two jobs on the same
order have images with the same source basename (e.g. both have a
`photo.jpg`), the second job's file gets a `_2` suffix by the
never-overwrite guarantee above. Add `{index}`, `{indexPadded}`, or
one of `{jobName}` / `{jobId}` to the filename template to keep
every image's name unique per job. The Settings modal shows an
advisory at save time if the template lacks any per-image
distinguisher while **Omit OrderHub job Id** is on.

The checkbox is only shown when the destination layout is set to
**Per-job subfolder** — under **Files directly in the copy-to
folder**, there's no per-job segment to omit, so the box is
hidden.

---

## Folder Copy — three small changes to the filename-template panel

**Token chips now insert at the cursor.** In the Filename template
panel, the clickable token chips
(`{orderNumber}`, `{lastName}`, `{indexPadded}`, and the rest) used
to copy the token to the clipboard for you to paste. They now
insert the token directly into the template field at the cursor
position, replacing any selected text, and the field keeps focus so
you can keep typing. The tooltip on each chip has been updated to
"Insert `{token}` at cursor" so the new behaviour is discoverable.
The Photo Lines chips on Darkroom Pro controllers are unchanged —
they still copy to the clipboard.

**The Filename template field is taller.** Roughly twice its
previous height. Long multi-token templates were painful to type
into a single-line field; the extra room helps. The field still
carries single-line semantics — pasted or typed newlines are
stripped so the template can never contain an embedded newline.

**Newly created Folder Copy controllers get a default filename
template.** When you click **Add Controller** and pick Folder Copy,
the Filename template field opens pre-filled with:

```
{lastName}_{jobName}_{category}_{productCode}_{quantity}_{indexPadded}
```

Existing Folder Copy controllers open with the template you saved,
verbatim. If yours is blank, it stays blank; if it has a custom
value, it stays exactly as you left it. The default only appears on
brand-new controllers, and only if you don't type over it before
saving.

---

## Also fixed — Perfectly Clear batch runner no longer escapes an unhandled rejection on slow filesystems

This fix has been sitting under `## Unreleased` since v1.16.0 and
ships as part of this release. It affects labs that run image
enhancement through a Perfectly Clear QuickServer hot folder on a
slow SMB share.

**Before this fix.** OHD wraps every file-system call the batch
runner makes in a per-op deadline — so a wedged SMB share can't
hang the whole batch. Most of the runner handled a deadline as
"observation missed, keep polling until wall clock". The setup-phase
filesystem calls — the initial folder creation and the per-file
staging copy — did NOT: a deadline there escaped as an unhandled
rejection, and the batch effectively failed with an opaque error
rather than resolving cleanly at its wall-clock timeout.

Never surfaced in production (production timeouts are well above
realistic filesystem speeds), but did surface intermittently in CI
on Windows under contention. Fix is symmetrical: setup now handles
a deadline the same way the poll loop does.

**What operators should see.** Nothing. In practice this fix has no
visible effect on any lab that has been running successfully; it
plugs a hole that would have surfaced under a slow-share failure
mode that would otherwise have been diagnosed as "OHD crashed on a
batch" rather than the wall-clock-timeout it should have been.

---

## Nothing else in this release

No changes to Noritsu, Epson, DPOF, Darkroom Pro, PDF Copy, Fuji
PIC Pro, or Frontline controllers. No changes to XML hot folders.
Everything else works exactly as it did in v1.16.0.

---

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity
Log tab is the quickest place to spot the cause. If a Fuji JobMaker
job goes red with the new dispatch-stopped error message, the
message itself names both paths and the fix; try that first, and
let us know if the wording was unclear. If a Folder Copy
destination is filling up with `_2` / `_3` copies you didn't
expect, check the Activity Log for `diskSuffixedCount` on the
dispatch line — that tells you how many files were suffixed and
which job they belonged to.
