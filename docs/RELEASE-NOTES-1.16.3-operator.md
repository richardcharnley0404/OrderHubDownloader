# OrderHub Desktop v1.16.3 — what's changed

Download from **OrderHub → Settings → Info**.

This release covers **three areas**: FTP downloads (a new setting for
labs with more than one location on the same account), the removal of
the global "Default Folder" that used to catch unrouted jobs, and a fix
for the configuration modals occasionally closing mid-edit and losing
what you had typed. Each is independent — if none of the three describes
your lab, this release is a safe skip.

**IMPORTANT for labs installing this release.** v1.16.3's new FTP
Settings ship with a persistence defect: the checkboxes appear in
Settings and can be ticked and saved, but the values are silently
dropped and the runtime never sees them. **Install v1.16.4 instead** —
it fixes exactly this and is otherwise identical to v1.16.3. This
document describes the features as they were designed and as they
work in v1.16.4. See the separate v1.16.4 notes for the recovery
sequence if you already installed v1.16.3.

## Installing

Windows will warn you that the publisher is unknown. That's expected
— our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers,
channel mappings, and any in-flight jobs are all preserved.

---

## FTP — keep files on the server, so more than one location can download the same order

**Who this is for.** Labs that run OrderHub Desktop at **more than one
location** and share one FTP folder between them (the common shape is
one Pixfizz Core account, one FTP folder, multiple lab sites pulling
orders as they arrive). If your lab is a single site, this release
changes nothing — the default behaviour is unchanged.

**The problem this addresses.** Before this release, OHD deleted each
file from the FTP server after downloading it. That's fine for one
location — files land locally, the FTP folder stays clean, no
duplication. For a multi-location lab it's actively broken: **whichever
location polls first takes the files and the other locations can never
see that order**. The other sites end up unable to service reprints
for those orders, or to take over production if the primary lab is
overloaded.

**The setting.** A new checkbox under **Settings → FTP Server**:

> **Keep files on the server after downloading**

When ticked, OHD leaves every file on the FTP server after downloading
it. No delete after download, no cleanup of empty folders, nothing
removed. Every location running OHD sees the same orders as they land
and can pull them down independently.

Files you already have locally are still skipped by OHD's existing
size + magic-byte check — turning this on does not cause repeat
downloads.

**Default is OFF.** A single-location lab upgrading sees no change.
Only tick it if you have more than one location sharing an FTP folder.

## FTP — retention sweep (optional, off by default)

**Who this is for.** Labs that have ticked **Keep files on the server**
above AND want OHD (rather than another system) to clean up old files
so the FTP folder does not grow forever.

**Related fields**, in the same **Settings → FTP Server** section:

- **Delete old files from the server (retention sweep)** — a checkbox.
  Off by default.
- **Retention window (days)** — number, minimum 1, default **7**. A
  lab is typically closed for two or three days and OHD runs
  continuously, so a week is enough headroom to bound growth without
  cutting into normal offline periods.
- **Dry run — log what would be deleted, but don't delete** — a
  checkbox. Off by default. Tick it before the retention sweep to see
  which files the sweep would remove (the Activity Log lists each
  one) before anything actually gets deleted.

**Enable at ONE location per install.** Multiple locations running
the sweep is harmless (they duplicate the same delete work) but
pointless. Pick the location most likely to be online every day.

**The sweep refuses to run if Remote Path is `/` (root).** Sweeping
the FTP root could delete files belonging to Pixfizz Core or to other
systems that share the server. Set Remote Path to a specific folder
(e.g. `/orders`) to enable the sweep. If you tick "Delete old files"
while Remote Path is still `/`, Settings will show an advisory alert
on save explaining this, and the sweep will refuse to run until the
path is changed.

**Safety guarantees.** OHD only deletes files it has itself
successfully downloaded (it compares the local file's size against
the FTP listing before removing). Nothing outside the configured
Remote Path is ever touched. The sweep runs at most once every 24
hours regardless of how often OHD polls — a fast polling cycle
cannot turn into thousands of listing walks per day. Every deletion
is logged in the Activity Log with the file path, the file's
timestamp, and its age in days.

**One thing you must understand before enabling this.** If a
location's OHD is offline for longer than the retention window, that
location will permanently miss those orders' artwork — the
sweep-enabling location will have deleted them from the shared FTP
folder before the offline location came back to pick them up. This
failure is visible (the offline location's job stalls rather than
printing something wrong) and no local data is destroyed (every
other location still holds its own local copy), but the window
must be set higher than the longest outage any of your sites could
reasonably have. Raise it above 7 days if that number is longer at
your labs.

---

## Removed — the global "Default Folder" under Settings → Downloads

**Who this is for.** Every lab. If you never used the Default Folder,
nothing changes. If you did, please read this section before installing.

**What has changed.** The old **Settings → Downloads → Process
Folders** section (a single **Default Folder** input) has been
removed. The fallback it powered — jobs whose process type had no
controller mapping being automatically copied to that folder and
marked completed — is gone.

**Why the fallback was actively unsafe.** When a controller in
Settings → Routing was deleted, or the process mapping got left
pointing at an id that no longer existed, the same fallback fired.
Those jobs were quietly copied to the Default Folder and marked
**completed** in the grid — **but no printer ever printed them**.
Files piled up in the Default Folder with nothing linking them
back to the missing routing, and the operator saw a green job
that had never actually reached a printer. The Default Folder was
hiding a real routing failure behind an apparent success. Removing
it is the fix.

**What you will see in the Jobs grid after upgrade.** For any job
whose process type has no controller mapping, or whose mapping
points at a controller you have since deleted, the Process button
is **replaced** by the text:

> **No routing — assign a controller for this process in Settings →
> Routing**

There is no Process button to click for these jobs. The text is
the whole affordance, and the next step is to open Settings →
Routing and assign a controller. Auto-print skips these jobs
silently (they never dispatch), nothing is copied anywhere,
nothing is marked completed, and no local files are destroyed.

**What to do on upgrade.** If your lab had a Default Folder
configured:

1. Open **Settings → Routing** on first launch after upgrading.
2. Confirm every process type your lab receives has a controller
   mapping. Any job showing the "No routing …" text in the grid
   needs a controller assigned for its process type.
3. If you were relying on the Default Folder as a **real
   destination** (a printer that actually watched it), assign that
   folder as a Folder Copy controller in Settings → Routing and
   map the relevant process type to it. The routing pipeline
   handles it the same way as before, and the grid now surfaces
   routing failures instead of hiding them behind an apparent
   completion.

**Not affected.** The **per-process folder exception** feature
(Settings → Routing, per-`productCode`/`options` folder paths) is a
different feature and works exactly as before. It has always been
routed through the visible routing engine, not the hidden fallback.

---

## Fixed — configuration modals no longer close mid-edit and discard what you've typed

**Who this is for.** Anyone who has set up an Order Controller, an
Imposition Template, or any other configuration form in Settings.

**What was happening.** Labs setting up a controller were reporting
that the modal "just closes" on its own, wiping everything they had
just entered. Two everyday actions were triggering it:

1. **Dragging the modal's own scrollbar** — the panel is 420 pixels
   wide with the scrollbar sitting on its right edge; if the mouse
   release landed a few pixels off the panel while dragging, the
   modal would close.
2. **Drag-selecting text in a field to retype it and overshooting
   the panel edge** — the release landed outside the panel, and the
   modal treated it as a click on the darkened backdrop.

Both are gone. Neither action closes the modal any more.

**What changed for the buttons and keyboard.**

- **A genuine backdrop click** (clicking and releasing cleanly on
  the darkened area outside the modal, not overshooting a drag)
  now asks first if you have unsaved changes:

  > **Discard unsaved changes in this form?**

  Click **No** to keep the modal open with your edits intact.
  Click **OK** to close and lose them. If the modal is clean
  (nothing edited), it closes silently — no dialog.

- **The Escape key** now uses the same confirm prompt. It also
  closes only the **topmost** modal, not every open modal — before
  this release, pressing Escape with two modals open would close
  both, which was a common way to lose work.

- **The Cancel button and the ×** are unchanged. They close
  immediately without asking. Use those when you deliberately want
  to abandon your edits.

Applies to every configuration modal in the app, not just the
Order Controller and Imposition Template forms specifically.

---

## Nothing else in this release

No changes to Noritsu, Epson, DPOF, Darkroom Pro, PDF Copy, Fuji
JobMaker, Fuji PIC Pro, or Frontline controllers beyond the
routing-fallback rewrite above. No changes to Film Scans, File
Uploads, or Order XML. Everything else works exactly as it did in
v1.16.2.

---

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity
Log tab is the quickest place to spot the cause. If a job shows
the new "No routing …" text and you thought that process was
already mapped, check Settings → Routing to see whether the
controller for it still exists (the fallback used to hide the
deleted-controller case; now it surfaces). If FTP Copy mode looks
like it's on but files keep disappearing from the shared folder
after other locations poll, install v1.16.4 — the v1.16.3
persistence defect described at the top of this document is the
cause.
