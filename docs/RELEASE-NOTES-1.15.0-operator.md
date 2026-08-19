# OrderHub Desktop v1.15.0 — what's changed

Download from **OrderHub → Settings → Info**.

Read this whole page before you install. There are two behaviour changes that
affect what actually comes out of your printer, plus one that changes how
PhotoFinale orders appear in OrderHub — all three are covered first.

## Please read BEFORE installing — Fuji PIC Pro co-location check

If you use a **Fuji PIC Pro** printer, check this now, not after upgrading.

**From 1.15.0, Image Staging Root and DIGIN Path need to be on the same
volume** — same drive letter (both on `D:`), or the same UNC share (both on
`\\labserver\digin`). If they're on different volumes, dispatch to that
controller **stops** at run time with an error naming both paths.

At save time OHD flags this when it can tell — a warning that says the two
paths may be on different volumes, and to fix them if so. The save still
succeeds: OHD can't always tell for certain from network paths alone (two
shares on the same server can be one physical volume or two), and dispatch
is what actually enforces the rule. So the flow is:

1. **Save-time warning** — a heads-up if OHD suspects a mismatch, so you
   can fix it before any order is dispatched.
2. **Run-time enforcement** — if the two paths really are on different
   volumes, dispatch stops with an error and the order stays in Awaiting
   Processing until you fix the paths.

**Where to check now:** Settings → Routing → Order Controllers → Edit your
Fuji PIC Pro controller. Look at **Image Staging Root** and **DIGIN Path**.
Ideally they're on the same drive or the same `\\server\share`. If they
aren't, and you don't want to see the run-time error on your next order,
move Image Staging Root onto the same volume as DIGIN Path before you
install.

**Why the rule at all (and why it's actually a good change).** Some labs
have been seeing every order arrive twice — once correct, once blank, and
the blank one's folder name ends in `.ohdtmp`. Cause: when the two paths were
on different volumes, OHD had to copy into a temp folder inside DIGIN and
then rename it into place. PIC Pro's watcher was picking up the temp folder
mid-copy, ingesting it as a blank order, and then also ingesting the real
one — one good order, one blank duplicate. The old code claimed PIC Pro's
watcher would ignore the temp folder; production disproved that. Same-volume
delivery avoids the temp folder entirely — one atomic rename into DIGIN,
nothing partial visible to the watcher, no blank duplicate.

If you've been seeing the `.ohdtmp` duplicates, this is the fix. The blank
folders never had any images and are safe to delete once you've confirmed
the correct order printed.

Once both paths sit on the same volume — or you've decided to leave them and
let dispatch confirm — jump to **## Installing** below.

---

## Please read BEFORE installing — {date} on Fuji back prints

If you use **Fuji JobMaker** or **Fuji PIC Pro** with **Back Print Mode = Text**
and your back-print template contains `{date}` — the seeded default is
`{firstName}/{filename}/{date}` — read this.

**Until now, `{date}` in a Fuji back-print template printed the literal text
`{date}` on the back of every image.** From 1.15.0 it resolves to today's
date as `YYYY-MM-DD`.

**How to check:** Settings → Routing → Order Controllers → Edit each Fuji
controller. If Back Print Mode is **Text** and the Back Print Template
contains `{date}`, this affects you. If Back Print Mode is **None** or
**Off**, you're fine.

**If you want the date on the back print** (most labs will), no action
needed — it now works as the template said it would.

**If you don't want the date on the back print**, delete `{date}` from the
Back Print Template before this release lands at the lab.

---

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

---

## Please read — PhotoFinale imports now arrive UNPAID

If you use **PhotoFinale XML** hot folders, this changes how those orders
appear in OrderHub.

**From 1.15.0, every PhotoFinale order imports as unpaid.** You mark it paid
in OrderHub the same way you would for any other order. Previously they came
in pre-marked as paid on the assumption that PhotoFinale had already taken
payment upstream — but the lab preference now is to mark payment in OrderHub
alongside everything else, so they land unpaid.

**Orders that were imported before you upgrade keep whatever paid state they
had at import.** So for a while you'll see a mix — older PhotoFinale orders
still marked paid, newer ones unpaid. That's expected, not a bug.

**ROES XML imports are unaffected.** ROES has always taken its paid/unpaid
state from `<PaymentStatus>` in the XML, and still does.

---

## New — filename templates for Folder Copy controllers

Rename the image files that a Folder Copy controller writes out so the
receiving operator can tell from the filename alone what needs doing.
Settings → Routing → Order Controllers → Edit a Folder Copy controller →
**Filename template**.

Leave the field blank to keep today's original filenames — **nothing changes
for existing Folder Copy controllers unless you type a template**.

When set, every image is renamed per the template. The source file's
extension is always preserved, so `{product}` on a `.tif` source produces
`{product}.tif`, never `{product}.jpg`. Available placeholders:

- `{customerName}` / `{firstName}` / `{lastName}` — from the order
- `{orderNumber}` / `{jobName}` / `{jobId}` — order-level identifiers
- `{product}` / `{productCode}` / `{category}` / `{process}` — job classification
- `{options}` — all option values joined with `_`
- `{option:NAME}` — one option value by name (e.g. `{option:finish-options}`)
- `{filename}` / `{originalFilename}` — per-image
- `{quantity}` — per-image copy count from the manifest
- `{index}` / `{indexPadded}` — 1-based position within the job
- `{dueDate}` / `{date}` — ISO YYYY-MM-DD

Same-name collisions within one dispatch get `_2`, `_3` suffixes
automatically. If the template resolves to duplicate names on more than one
image the Settings preview flags it — adding `{index}` or `{indexPadded}`
makes every name distinct.

## New — destination layout: per-job subfolder or files in the root

Same Folder Copy modal → **Destination layout**.

- **Per-job subfolder (today's behaviour)** writes each job's files under
  `{OutputPath}/{orderNumber}_{jobId}/` exactly as before.
- **Files directly in the copy-to folder** drops the images straight into
  the Output Path with no per-job wrapper — useful when the receiving system
  reads a single flat directory.

If you pick the root layout, the filename template becomes required, and
must include at least one of `{orderNumber}`, `{jobName}` or `{jobId}` so
files from different jobs don't overwrite each other. Save is rejected with
an explanation if that guardrail isn't met.

## New — live preview in Settings

Right under the template field a preview panel shows the resolved sample
filenames and the full destination path, updating live as you type. It runs
the same rename code the real dispatch uses, against a recent real job when
one is available, so what you see is what dispatch will do.

The preview also warns you about the same signals dispatch would log:
duplicate names that had to be auto-suffixed, filenames that hit the
120-character cap, and images where the template resolved to empty and fell
back to the original basename. And if `{options}` on this job resolves to
include a machine reference (a photo id, a long numeric variant id) the
preview names the offending option and suggests `{option:NAME}` for the
specific value you want.

**The preview also shows the option names on the sample job as clickable
chips** — click any chip and its `{option:…}` token drops into the template
at the cursor. You no longer need to know the option names by heart.

The preview labels its data source: if OHD can find a recent job routed to
this controller with a readable manifest, the preview uses it and says
"Preview using job 12345". Otherwise it falls back to any recent job with a
manifest, or to a synthetic sample labelled "Preview using sample data" so
it can never be mistaken for a real resolution.

## New — order number prefix rules (list + optional replacement)

Settings → Routing → Order Controllers → Edit → **Order number prefix
rules**. Available on both **Fuji PIC Pro** and **Folder Copy**.

Each rule is a pair: **Prefix** on the left, **Replace with (optional)** on
the right. Leave Replace with blank to **strip** the prefix (the previous
behaviour). Fill it in to **replace** it: Prefix `PXDEMO-` → Replace with
`PX-` turns `PXDEMO-091YEC` into `PX-091YEC`. Add as many rules as you need
with the **+ Add rule** button.

**One thing to know about replacement:** what's matched is replaced verbatim,
including the separator between the prefix and the code. Prefix `PXDEMO` (no
hyphen) → Replace with `PX` (no hyphen) turns `PXDEMO-091YEC` into
`PX091YEC` — the hyphen is part of what the rule matched, so it's part of
what gets replaced. If you want the hyphen in the output, type it on both
sides: `PXDEMO-` → `PX-`. The field help text spells this out.

An OrderHub org can ship orders with several source-website prefixes on the
same account, so the list can mix strip-only and replacement rules. Longest
match wins, so `PXDEMO` and `PXDEMO1` can coexist safely. Case-insensitive on
the match; the surviving tail keeps its original casing.

**If you already had a strip prefix set** (from v1.13.0 or v1.14.0), it
loads as a row with **Replace with** blank — nothing to migrate. On Folder
Copy, rules apply to the destination folder name AND any `{orderNumber}` /
`{jobName}` token in the filename template. On Fuji PIC Pro they apply to
the submission id (staging folder, `.txt` filename, DIGIN folder) exactly as
strip-only did before.

---

## Coming from v1.12.1 or earlier?

Most labs are jumping from 1.12.1 straight to 1.15.0, so you're skipping
1.12.2, 1.13.0 and 1.14.0. Everything they added is in 1.15.0 — the release
notes for 1.14.0 cover the highlights:

- **Splitting large jobs on the Epson Order Controller** — Maximum prints
  per job + Send batches automatically tick, per-batch banner sheets,
  Resend batch action on failed batches.
- **A hold fix for large Darkroom Pro jobs** that had been silently broken
  since 10 August — the "Large job — review required" flag was true but the
  job had already gone to the printer. See RELEASE-NOTES-1.14.0-operator.md
  for the retrospective check we suggested.
- **FTP Sources** in Settings → Downloads for ad-hoc file collection
  (Labworks XML and similar) — moves files off an FTP server into a local
  folder or share.
- The **Order XML** tab is hidden unless you use Order XML hot folders.

See `docs/RELEASE-NOTES-1.14.0-operator.md` in the repo (or ask us for a
copy) if you want the full 1.14.0 write-up.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab is
the quickest place to spot the cause.
