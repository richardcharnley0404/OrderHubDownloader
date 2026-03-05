# Print Controller Troubleshooting

---

## Job Stuck in "submitted" Status

**Symptom**: The order folder was created in the hot folder with an `o` prefix, but the job status never changes to `accepted` or `failed`.

### Check 1: Is the folder monitor running?

The folder monitor must be started for status changes to be detected. In the app, go to the controller settings and verify monitoring is active.

Look in the logs (`%APPDATA%\Electron\orderhub-downloader\logs\app.log`) for:
```
[info] Started monitoring hot folder: C:\YourHotFolder
```

If this log line is missing, monitoring was not started for this controller.

### Check 2: Did the controller rename the folder?

Open the hot folder in Windows Explorer and check:

- Is the folder still named `o{orderNumber}_...`? The controller has not yet processed it.
- Has it been renamed to `e{orderNumber}_...`? The controller accepted it but the monitor did not detect the change.
- Has it been renamed to `q{orderNumber}_...`? The job failed — see the "Jobs failing" section below.

### Check 3: Is `fs.watch` working on this path?

Node's `fs.watch` can be unreliable on some Windows configurations, especially with network shares. Check the following:

- If the hot folder is on a **network share**, `fs.watch` may not receive rename events. Use a local folder instead and let the controller software sync via its own mechanism.
- Verify no antivirus or security software is blocking filesystem event notifications.
- Restart the app after any hot folder path change — monitoring is not automatically restarted.

### Check 4: Suffix matching

The folder monitor matches folders using the pattern `^[oeq](\d+)_(.+)$`. If the order number contains non-numeric characters, the regex will fail to match.

Verify the order number is purely numeric. If not, this is a known limitation.

---

## Jobs Failing (folder renamed to `q...`)

**Symptom**: The order folder has been renamed from `o...` to `q...` (prefix changed to `q`), indicating the controller rejected the job.

### Diagnosis step 1: Check the DPOF file

Open the order folder and read `DPOF.001`. Common rejection causes:

- **Wrong channel number**: The `PRT PCH` value does not match any channel configured in the controller software.
- **Invalid paper size**: The `PRT PSL -PSIZE` value is not recognised by this controller.
- **Incorrect vendor name**: The `VUQ VNM` value does not match the controller's vendor ID.
- **Image not found**: The `<IMG SRC>` path cannot be resolved by the controller.

### Diagnosis step 2: Check the IMAGES folder

Verify that all images referenced in `DPOF.001` are present in the `IMAGES\` subfolder with matching filenames (case-sensitive on some systems).

### Diagnosis step 3: Check the controller software

Open the controller's own management software or logs. It will usually provide a rejection reason:

- Noritsu QSS: Check the QSS system log
- Epson: Check the hot folder software event log

### Diagnosis step 4: Verify channel configuration

In OrderHub Downloader settings, check that the channel number and print style code match what the controller software expects. The channel number must correspond to a real paper channel loaded in the printer.

---

## Hot Folder Permission Issues

**Symptom**: `Error: EACCES: permission denied` or `Error: EPERM: operation not permitted` in the logs when writing the order folder.

### Step 1: Verify the path exists

The hot folder directory must exist before the app starts. The app does not create the hot folder itself — only the order subdirectory is created.

```
✓  C:\PrintControllers\Noritsu\          ← Must exist
     o100456_8x12GLOSS\                  ← Created by the app
         DPOF.001
         IMAGES\
             ...
```

### Step 2: Check Windows file permissions

Right-click the hot folder → Properties → Security. The Windows user account running OrderHub Downloader needs:

- **Modify** (includes Read, Write, and Delete)
- Ensure permissions apply to **This folder, subfolders and files**

### Step 3: Network share paths

If using a UNC path (e.g., `\\server\share`):

- Ensure the share is mapped and accessible at startup
- Test with `net use` in a Command Prompt to verify connectivity
- Check both share permissions and NTFS permissions — both must allow write access
- Consider using a mapped drive letter (e.g., `Z:\NoritsuHot`) rather than a UNC path, as UNC paths can be unreliable with `fs.watch`

### Step 4: Antivirus interference

Some antivirus products lock files during scanning. Add the hot folder to the antivirus exclusion list.

---

## Image File Not Found Errors

**Symptom**: Error like `Image not found: C:\Downloads\100456_98765\100456_38334605\photo-001.jpg`

### Step 1: Verify the download directory

Go to **Settings → Downloads → Download Directory** and confirm the path is correct and the directory exists.

### Step 2: Verify the job folder was downloaded

The job must be fully downloaded before sending to print. Check that the job folder exists at:

```
{downloadDirectory}\{orderNumber}_{orderId}\{orderNumber}_{jobId}\
```

### Step 3: Verify the manifest image paths

Open the order manifest (`{orderNumber}.json`) in the order folder. Check the `images[].filename` values. These are relative paths from the order folder root. Example:

```json
{
  "images": [
    { "filename": "PXDEMO-K9MYDG_38334605/photo-001.jpg", "size": "4x6", "quantity": 2 }
  ]
}
```

The full source path constructed would be:
```
{downloadDirectory}\PXDEMO-K9MYDG_{orderId}\PXDEMO-K9MYDG_38334605/photo-001.jpg
```

Verify this file exists on disk.

### Step 4: Filename case sensitivity

While Windows is case-insensitive, the manifest may have been generated on a case-sensitive system. If the filename in the manifest uses a different case than the actual file, the existence check may fail on some configurations.

---

## Channel Configuration Mismatches

**Symptom**: Error like `No matching channel found for size "4x6". Check your channel settings.`

### Step 1: Check the manifest size value

Open the order manifest and find the `size` field for the images. The value must exactly match (case-insensitive) the `size` field configured on a channel.

Example manifest: `"size": "4x6"`
Example channel setting: `size: "4X6"` — this will match (comparison is case-insensitive)
Example channel setting: `size: "4 x 6"` — this will NOT match (spaces are not stripped)

### Step 2: Check the channel is active

In **Settings → Print Controllers**, expand the controller and verify the channel for this size has **Active** checked. Inactive channels are ignored during matching.

### Step 3: Multiple size formats

OrderHub may report sizes in different formats for different product types (e.g., `"6x4"` vs `"4x6"`). If you have both orientations, you may need two channels — one for `4x6` and one for `6x4`.

### Step 4: Finish mismatch

If you have multiple channels for the same size with different finishes, and the job has a `Paper` option, verify the finish option value matches the `Finish` field on the channel (case-insensitive comparison).

---

## Monitoring Not Detecting Changes

**Symptom**: The controller renames the folder (visible in Explorer) but the job status never updates.

### Check 1: Debounce delay

The monitor has a 500ms debounce. Status updates may take up to 1 second after the rename. Wait a moment before concluding monitoring is broken.

### Check 2: Folder name format

The monitor parses folder names using the pattern `^[oeq](\d+)_(.+)$`. The order number must be purely numeric digits. If the order number contains letters or dashes (e.g., `PXDEMO-K9MYDG`), the monitor cannot extract it and will silently ignore the rename.

This is a known limitation for alphanumeric order numbers.

### Check 3: `fs.watch` reliability

`fs.watch` on Windows can miss events if:
- The directory is on a network share
- The rename is performed by a process with different permissions
- The folder is deeply nested (some drivers limit event propagation depth)

Consider polling as an alternative if `fs.watch` proves unreliable on your system.

### Check 4: Restart monitoring

If the app was running when the hot folder path was changed in settings, the old monitor (for the old path) is still active. Restart the app to re-initialise monitoring for the new path.

---

## General Diagnostic Steps

1. **Check the log file**: `%APPDATA%\Electron\orderhub-downloader\logs\app.log`
2. **Run the built-in test**: Settings → Print Controllers → Test button
3. **Inspect the hot folder manually**: Check folder names, contents, and the DPOF.001 file
4. **Verify controller software**: Check the print controller's own logs or UI for rejection details
5. **Check electron-store data**: The raw data files are at `%APPDATA%\Electron\orderhub-downloader\`
   - `print-controllers.json` — controller and channel configuration
   - `jobs.json` — job DPOF submission status
