# OHD Backup & Restore — Operator Guide

OHD can snapshot non-sensitive configuration to a network share every day so
that if the lab PC dies or needs to be rebuilt, you can restore the
configuration in one click and a relaunch.

This guide is for the operator (lab manager / IT) who configures and uses the
feature. The technical design lives in
[`OHD_BackupRestore_ClaudeCode_Brief.md`](../OHD_BackupRestore_ClaudeCode_Brief.md).

---

## What the feature does — and what it deliberately does not do

**It backs up**

- Connection settings (OrderHub API URL, Organization ID, Location ID — _but
  not_ API keys/passwords; see below).
- FTP host, port, username, remote path, download directory.
- All Order Routing data: controllers, process mappings, channel mappings,
  process folder exceptions, default process folder.
- Print Controllers (legacy / Darkroom Pro).
- Mode toggles and folder paths for Film Scans, File Uploads, and Order XML
  hot folders.
- AI Quality Gate + AI Enhancement settings.
- App preferences (theme) and Film Review preferences (density, theme).
- The Order XML customer directory (PII — opt-out available).

**It never backs up**

- Passwords or API keys. The following are stripped before write:
  - OrderHub API Key
  - FTP Password
  - S3 Secret Access Key
  - Topaz API Key
- Job state (`jobs.json`, frame metadata, the Order XML ingestion log).
- Activity logs.
- Anything in `%APPDATA%\Electron\orderhub-downloader\` that is not in the
  list above.

After a restore, the operator must re-enter the four credentials above. OHD
shows them in the restore preview so they don't get missed.

---

## Configuring the backup share

1. **Pick a folder on a NAS or file server.** A UNC path is best, e.g.
   `\\NAS\OHD-Backups\`. Local paths (`D:\Backups\OHD`) and mapped drives
   (`Z:\Backups`) also work — but mapped drives can be unavailable when OHD
   launches on Windows startup, before the drive is mounted, so prefer a UNC
   path on a shared NAS.

2. **Make sure this PC's Windows user has read+write access.** OHD uses the
   current Windows user's credentials — there is no separate username/password
   field. If the share needs explicit auth, set that up via Windows Credential
   Manager before pointing OHD at it.

3. **In OHD: Settings → Backup.**

   - Tick **Enable automatic daily backups**.
   - Type or paste the path into **Backup folder**. The field validates the
     path on blur — you should see "Backup folder is writable." in green.
     Common errors and what they mean:
     - _Path not found_ — UNC share is offline or typo in the path.
     - _Permission denied_ — share permissions are wrong for this PC's
       Windows user.
     - _Share is read-only_ — you need write access.
   - Decide whether to include the **Order XML customer directory**. Leave
     checked unless your lab policy forbids storing customer names + emails
     on the backup share.
   - Click **Save Settings**.

OHD will write its first backup within a minute of save, then once per day
after that.

---

## Folder layout on the share

OHD writes each PC's backups into its own hostname-named subfolder so
multiple lab PCs can share a single root:

```
\\NAS\OHD-Backups\
  LAB-PC-01\
    ohd-backup_LAB-PC-01_latest.json
    ohd-backup_LAB-PC-01_2026-05-14_14-30-22.json
    ohd-backup_LAB-PC-01_2026-05-13_09-12-04.json
    ...
  RECEPTION\
    ohd-backup_RECEPTION_latest.json
    ohd-backup_RECEPTION_2026-05-14_09-12-04.json
    ...
```

- The `*_latest.json` pointer is overwritten on every successful backup.
- Timestamped backups are kept for the most recent 30 runs; older ones are
  pruned automatically. The `*_latest.json` pointer is never pruned.

---

## When backups run

- **At app launch**, 30 seconds after startup, _if_ the last successful backup
  was more than 24 hours ago.
- **After the first successful config save of each day** (also gated on the
  same 24-hour window).
- **On demand** when the operator clicks **Backup Now** in Settings →
  Backup.

If a scheduled run fails (share offline, permissions, full disk, …), the
failure message is shown on the **Last backup** line in Settings → Backup
and is retried on the next trigger. OHD does not retry in a tight loop.

---

## Restoring a backup

Use the restore flow on the **new** OHD install (the one that needs the
configuration brought across).

1. Install OHD on the replacement PC.
2. Settings → Backup → set the **Backup folder** to the same path you used on
   the old PC.

   - If the replacement PC has the **same hostname** as the old one
     (recommended), OHD's restore dialog will see the old PC's backups in
     this hostname's subfolder automatically.
   - If the replacement PC has a **different hostname**, you'll need to click
     "Browse backups from other machines" inside the restore dialog so it
     widens the list to include sibling subfolders.

3. Click **Restore from Backup&hellip;**.

4. The restore dialog opens:

   - The default list shows backups for this hostname's subfolder, newest
     first. Click "Browse backups from other machines" to widen.
   - Or click **Browse to file&hellip;** to pick a `.json` file by hand.

5. Click a backup. The preview shows:

   - Source hostname, OHD version, when the backup was created.
   - The list of credentials you'll need to re-enter after restore.
   - A warning if the source backup excluded the customer directory.
   - Checkboxes for each section (all checked by default).

6. Click **Restore**. OHD asks for one final confirmation, applies the
   backup, and shows a "Restart now" modal.

7. Click **Restart now**. OHD relaunches.

8. After OHD comes back up, go to Settings → Connection and re-enter:

   - OrderHub API Key
   - FTP Password
   - S3 Secret Access Key (if using Amazon S3)
   - Topaz API Key (if using Topaz)

   These are intentionally not in the backup.

---

## Hostname collisions — what to do

The backup system uses a persistent **machine ID** (a UUID generated once on
first launch and stored in `config.json`) to detect when two different PCs
end up with the same hostname. This can happen when:

- A Windows image was cloned without sysprep.
- Two PCs were both named `LAB-PC` by default and never renamed.
- A replacement PC was given the same name as the failed one **before** the
  failed one's backups had been removed from the share.

When OHD tries to write a backup into a hostname subfolder that already
contains backups from a _different_ machine ID, it refuses the write rather
than silently overwriting. The collision dialog offers two options:

- **Take over this folder.** Deletes every backup currently in that
  hostname's subfolder on the share, then writes a fresh one from this PC.
  Use this when the previous PC is gone for good and you don't need the old
  backups. There is no undo.
- **Choose a different folder.** Opens the folder picker. Use this when
  both PCs are still alive and you need to rename one or use a different
  share path.

The collision check only runs on **write**, not on restore — so even if the
machine ID on the destination differs from the source, restoring still
works.

---

## Diagnostics

The bottom of the Backup subtab shows **This PC**: the hostname and the first
8 characters of the machine ID. Click the line to copy the full machine ID
to the clipboard — useful when contacting Pixfizz support about a collision.

---

## What if the backup file is malformed?

The restore flow validates the envelope shape before applying anything. If
the file has been hand-edited or truncated, the preview will refuse to load
and surface the validation error. The file on the share is never modified
by restore — only the local stores under `%APPDATA%\Electron\orderhub-
downloader\`.

---

## Out of scope for this version

The current version intentionally does **not**:

- Encrypt the backup file (it's plain JSON on a share).
- Track or merge multiple PCs' configurations.
- Include job state, frame metadata, or activity logs.
- Provide a CLI flag for unattended/scripted restores.

Those may come in future versions.
