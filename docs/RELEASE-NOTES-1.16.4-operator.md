# OrderHub Desktop v1.16.4 — what's changed

Download from **OrderHub → Settings → Info**.

**This is a hotfix for a persistence defect in v1.16.3.** If you
installed v1.16.3 and ticked either **Keep files on the server after
downloading** or **Delete old files from the server (retention
sweep)** under **Settings → FTP Server**, those settings were
silently discarded on save. The checkboxes appeared to stick — the
Settings dialog closed cleanly with no error and the boxes stayed
ticked in the form — but the value never reached the runtime, and
OHD carried on behaving exactly as it did in v1.16.2 (deleting
files from the FTP server after downloading them, no retention
sweep, no dry run).

**Reassuring fact up front.** Nothing was destroyed by the defect
itself. The retention sweep NEVER RAN in v1.16.3 — the code that
performs deletions only runs when its enable flag is `true` at
runtime, and the defect meant the flag was always `false` at
runtime regardless of what you ticked. Nothing was deleted from
your FTP server that would not have been deleted in v1.16.2. No
local files were touched. No orders were changed. The only
consequence was the feature not doing anything.

**If you were relying on FTP Copy mode at more than one location**,
the two locations' behaviour was v1.16.2's behaviour: whichever
site polled first took the files and the other sites did not see
those orders. That is the situation this release restores the
fix for.

## Installing

Windows will warn you that the publisher is unknown. That's expected
— our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers,
channel mappings, and any in-flight jobs are all preserved.

---

## Recovery — re-tick the FTP settings and confirm they stick

After installing v1.16.4:

1. Open **Settings → FTP Server**.
2. Tick the boxes you had ticked before:
   - **Keep files on the server after downloading** — for
     multi-location labs sharing one FTP folder.
   - **Delete old files from the server (retention sweep)** —
     for labs that want OHD to clean up the shared FTP folder.
   - If you enable the sweep, set **Retention window (days)**
     (default 7) and, on first run, tick **Dry run — log what
     would be deleted, but don't delete** so the Activity Log
     shows you what the sweep will do.
3. Click **Save**.
4. **Close the Settings dialog completely, then reopen Settings →
   FTP Server.** The boxes you ticked in step 2 must still be
   ticked. **That is the proof the values persisted.** If any of
   them has reverted to unticked, the fix did not take — please
   contact us with a screenshot.
5. On a multi-location lab, do this at every location that
   downloads from the shared FTP folder. The retention sweep
   itself should be enabled at ONE location only — pick the one
   most likely to be online every day. **Keep files on the
   server** should be ticked at all locations that share the
   folder.

---

## Anything looks wrong?

**If you cannot upgrade immediately** and need FTP Copy mode
working right now, there is a hand-edit workaround. It ONLY
covers turning file retention on — the retention sweep cannot
be enabled this way, and you should install v1.16.4 as soon as
you can regardless.

1. Close OrderHub Desktop.
2. Open `%APPDATA%\OrderHub Downloader\config.json` in a text
   editor (Notepad is fine, but save as UTF-8 without BOM).
3. Add the following line inside the top-level object (add a
   comma at the end of the previous line so the JSON stays
   valid):

   ```
   "ftpKeepFilesOnServer": true,
   ```

4. Save and restart OrderHub Desktop.

The setting will show as unticked in Settings → FTP Server (the
Settings screen reads the same defect that discards saves), but
the runtime will honour the value and stop deleting files from
the FTP server. Do NOT hand-add `ftpRetentionSweepEnabled`,
`ftpRetentionSweepDays`, or `ftpRetentionSweepDryRun` this way —
v1.16.4's config schema validates those fields on startup, and a
mis-typed value (a quoted string, a zero, anything other than a
plain boolean for the two flags or a whole number of at least 1
for the days) will prevent OHD from starting. Install v1.16.4
and use the Settings UI for those.

For anything else that looks wrong, send us a screenshot and
roughly when it happened — the Activity Log tab is the quickest
place to spot the cause.
