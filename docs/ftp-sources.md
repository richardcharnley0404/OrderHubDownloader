# FTP Sources — operator guide

> A plain "watch an FTP folder, move files down to a local folder"
> service. Independent of everything else OHD does. **Files pulled by
> this service never become jobs.**

---

## What this is (and isn't)

Some labs receive files over FTP that have nothing to do with an
OrderHub job — Labworks XML drops, vendor product feeds, reprint
queues from a POS system, whatever. FTP Sources lets OHD pull those
files down onto a local (or UNC share) folder on a schedule you set.
Whatever process reads them on your end — a print controller, an
import script, an inbox — never has to talk to the FTP server itself.

**These files are not jobs.**
- They do not appear on the Jobs grid.
- They are not routed to any controller.
- They are not dispatched to any printer.
- They are not uploaded to S3.
- They do not go through the OrderHub artwork pipeline in any way.

The service ends the moment the file lands at your chosen local
path. If you set up an FTP Source expecting files to appear in Jobs,
they will not. That is by design.

---

## Setup

Settings → Downloads → scroll to **FTP Sources (generic file mover)**
→ click **+ Add FTP Source**.

| Field | What it means |
|---|---|
| **Name** | An operator-facing label, e.g. `Labworks XML`. Must be unique across your sources. Case-insensitive. |
| **Enabled** | Off by default. When on, this source polls on its own timer. |
| **Host** | The FTP server's hostname or IP. Plain FTP only for now (see Limitations below). |
| **Port** | Defaults to 21. |
| **Username** / **Password** | Independent of the Connection tab's OrderHub credentials. |
| **Remote Path** | The folder on the FTP server whose files you want to pull down. Non-recursive — only files at the top of this folder are picked up. |
| **Local Path** | The destination on your machine. Can be a normal local path (`C:\Lab\Inbox`) or a UNC share (`\\server\share\folder`). |
| **Poll interval (minutes)** | 1 to 1440 (24 hours). Defaults to 5. |
| **Delete files from the FTP server after successful download** | On by default — this is the "move" default. Off = copy (files stay on the server). |

Click **Test connection** to check credentials and see how many files
the remote folder holds *right now*. Use it before Save — most
setup failures are wrong credentials or a wrong remote path, and it's
better to find that out at setup than at 3 a.m.

Click **Save**. If Enabled is ticked, the source starts polling on
its own timer straight away. No app restart needed.

## Editing a saved source

Same modal via the row's **Edit** button. Note that the password field
is **empty** on open with a hint that a password is saved — leaving
it blank keeps the existing password. Type a new value only to rotate
credentials. **Test connection** in edit mode uses the saved password
automatically; you don't have to re-type it.

If you change the host, remote path, or any other field except the
password and click Test, it tests against the *typed* values with the
stored password. Fixing a typo in the host and clicking Test gives
you a result against the new host — not the old one.

## Deleting a source

Row **Delete** button, then confirm. Files that already downloaded
stay on your machine. Only the polling schedule and the credential
are removed. If the remote source still has files and you re-add it
later, the next pass will download whatever's there.

---

## Move vs Copy

**Move (default)** — Delete-after-download is ON. Each successful
download is followed by a delete on the remote server. Files
effectively hop from the FTP server to your local folder. If OHD
already has a file at the destination with the same name, it
**skips** rather than overwrites — you'll see a warn line in the
Activity Log naming the file. Never clobbers.

**Copy** — Delete-after-download is OFF. Downloads happen, remote
files stay in place. On the next pass OHD sees the same files
already at the destination and **skips** them (warn log per file).
Useful when another system is authoritative for what stays on the
server and you just want a local mirror. The skip-not-overwrite
behaviour keeps this safe — OHD will never re-download a file it
already has locally.

---

## What each pass does

A "pass" is one round of the polling timer for one source. Each pass:

1. Opens one FTP session to the remote server.
2. Lists the files in the remote path (non-recursive).
3. For each file that doesn't already exist at the destination:
   - Downloads to a temporary name (`.<filename>.part`).
   - Renames into place under the real name only when the transfer
     completes.
   - Deletes the remote copy (if move mode).
4. Closes the FTP session.
5. Logs a one-line summary — `3 moved, 0 skipped, 0 failed`.

**A half-transferred file never appears at the destination under its
real name.** The temp-then-rename pattern is atomic on both local
NTFS and SMB destinations. If the connection drops mid-transfer, the
`.part` file is cleaned up on the next pass and the remote copy is
untouched (never deleted until the local rename has succeeded).

**Two passes for the same source never overlap.** If a pass is still
running when the next tick fires (slow server, big files), the tick
is skipped and logged at debug — a slow or hung FTP server can't
stack up passes.

---

## The Settings list

Below each source's name you see:

- **Enabled / Disabled badge** — whether the polling timer is
  actually running for this source right now.
- **Meta line** — `username@host → localPath · every N min · move|copy`.
- **Last run** — how long ago the pass completed and what it did.
  Refreshes every 5 seconds while you're on the Downloads tab, so
  you can watch a pass finish without leaving.

Row highlights:
- **Amber left border** — the last pass ran, but at least one file
  failed (permission problem on one file, corrupt transfer, etc).
- **Red left border** — the whole pass failed (connection refused,
  auth rejected, remote path missing). The last-result text shows
  the reason.

The Activity Log has the full per-file detail if you need it.

---

## Passwords

Passwords are encrypted before they hit the config file, using
Windows' built-in credential encryption (DPAPI via Electron's
`safeStorage`). They:

- **Never appear in plaintext in the config file.** If you open
  `%APPDATA%\orderhub-downloader\routing.json` and search for a
  password you typed, you won't find it.
- **Never appear in log lines.** The Activity Log will show
  `530 Login incorrect` for a wrong-password test — the actual
  password you tried is redacted, even if the FTP server echoes it
  back in its error text.
- **Never re-display in the Settings modal.** The password field is
  always empty on open. To rotate a credential, type the new value;
  to keep the existing one, leave the field blank.

If safeStorage isn't available on your machine for some reason
(rare, but possible on non-standard Windows configurations), OHD
will refuse to save the source rather than fall through to plaintext
storage. You'll see a clear error at save time.

---

## Limitations (as of this release)

1. **Non-recursive listing.** Sub-folders on the FTP server are
   ignored — only files at the top of your configured remote path
   are picked up. If you need to pull down a nested tree, either
   configure a source per sub-folder or wait for the recursive
   variant on the backlog.
2. **Plain FTP only.** FTPS as a transport isn't wired through yet
   even if you tick Secure in the config. Sources that require
   TLS-wrapped FTP won't work.
3. **Single-source Test connection** — you can only test the source
   currently open in the modal; there's no "test all" button on the
   list.

None of these affect the common case: a plain-FTP folder with files
at the top level.

---

## Troubleshooting

**"No password supplied"** on Test connection for a brand-new source
— you clicked Test before typing a password. Type the password and
try again. (For a saved source, the modal picks up the stored
password automatically; this message is create-mode only.)

**"530 Login incorrect"** — wrong username or password. The password
in the error is redacted; the message is the FTP server's own
response.

**"550 No such directory"** — the remote path is wrong, or the
username doesn't have permission to list it. Verify the path from an
FTP client.

**Source shows a red left border after a while** — the whole pass
has been failing repeatedly. Check the Activity Log for the exact
error at the top of the log (whole-pass failures log at ERROR once
per pass). Common causes: server rebooted and DNS is stale,
credential rotated on the FTP side, network share hosting `localPath`
went offline.

**Row disappeared from Settings after a restart** — you probably
deleted the source. Deletes are immediate and don't require restart.
The row does NOT come back on restart.

**File didn't get picked up** — check whether it's already at the
destination. OHD skips (never overwrites) existing files at the
destination with the same name. If you moved the file locally after
download and want to re-fetch it, use Copy mode (untick
Delete-after-download) so the remote copy stays available.

---

## Under the hood — what's touching what

The service comprises three independent modules:

- **The mover** (`src/main/services/ftp-source-service.js`) —
  runs one pass over one source. Downloads, renames, optionally
  deletes remote. Handles the SMB-doesn't-support-hard-links case by
  falling back to `fs.rename` (INFO-logged once per source when the
  fallback first fires).
- **The scheduler** (`src/main/services/ftp-source-scheduler.js`) —
  one `setInterval` per enabled source. Reconciles on config change
  without an app restart. Never runs two passes for the same source
  concurrently.
- **The UI** (`src/renderer/index.html` + `renderer.js`) — the
  Settings modal, the sources list, the Test-connection button.

The IPC boundary is per-source:
`ohd:ftp-sources:save-source` / `delete-source` /
`test-connection` / `list-sources`. The general Settings save never
round-trips the sources list.

Not touching: `job-service`, `routing-service`, `print-service`,
`runAutoPrint`, S3 uploader. The service is deliberately isolated —
files here never enter the OrderHub job pipeline.
