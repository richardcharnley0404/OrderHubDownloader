# OHD — Print Pipeline: Claude Code Brief

## Overview

This brief covers changes to the OHD print output pipeline for **DPOF controllers only** (Epson, Noritsu, and all other controllers except Darkroom Pro).

Darkroom Pro is a separate phase and is explicitly out of scope here.

There are four changes:

1. **Folder naming convention** — human-readable, job-specific folder names
2. **DPOF folder structure** — correct `IMAGES/` and `MISC/` layout with `AUTPRINT.MRK`
3. **Reprint pipeline** — reprints go through the full print pipeline with `-r1`/`-r2` suffix
4. **Job status display** — folder prefix drives status shown to operator, with light polling for failed imports

---

## 1. Folder Naming Convention

### Current behaviour
Replace the existing folder naming logic entirely.

### New naming format

```
{prefix}{JobNo}_{Product}_{OptionValues}
```

**Examples:**
```
pPXDEMO-XXTFLD-1_4x6 Photo Print_lustre_full-bleed   ← while writing
oPXDEMO-XXTFLD-1_4x6 Photo Print_lustre_full-bleed   ← ready for controller
```

**Rules:**
- `{JobNo}` — the OrderHub job number as-is (e.g. `PXDEMO-XXTFLD-1`)
- `{Product}` — product name with unsafe characters stripped (e.g. `4x6" Photo Print` → `4x6 Photo Print`)
- `{OptionValues}` — all option values joined with `_` (e.g. `lustre` + `full-bleed` → `lustre_full-bleed`)
- Strip all filesystem-unsafe characters from every segment: `" / \ : * ? < > |`
- Do **not** strip spaces — leave them as-is for readability
- Segments separated by `_`
- Prefix character prepended directly before the job number (no separator)

**Helper function — add to a shared utility:**

```js
function buildFolderName(prefix, job) {
  const unsafe = /["/\\:*?<>|]/g;

  const jobNo = job.jobNo.replace(unsafe, '');
  const product = job.product.replace(unsafe, '').trim();
  
  const options = (job.options || [])
    .map(opt => opt.value.replace(unsafe, '').trim())
    .filter(Boolean)
    .join('_');

  const segments = [jobNo, product, options].filter(Boolean).join('_');
  return `${prefix}${segments}`;
}
```

---

## 2. Prefix Swap — Safe Copy Pattern

This prevents the order controller from importing a partially-written job.

### Flow

```
1. Build folder name with prefix "p"
2. Create folder: pPXDEMO-XXTFLD-1_4x6 Photo Print_lustre_full-bleed/
3. Write all files into folder (IMAGES/ and MISC/ structure — see section 3)
4. On success → rename folder: p → o
5. On any write error → leave as p, log error, notify operator
```

### Implementation

```js
async function sendToController(job, destBasePath, options = {}) {
  const tempName = buildFolderName('p', job);
  const finalName = buildFolderName('o', job);
  const tempPath = path.join(destBasePath, tempName);
  const finalPath = path.join(destBasePath, finalName);

  try {
    // Create folder structure
    await fs.promises.mkdir(path.join(tempPath, 'IMAGES'), { recursive: true });
    await fs.promises.mkdir(path.join(tempPath, 'MISC'), { recursive: true });

    // Write all image files to IMAGES/
    for (const image of job.images) {
      const sourcePath = getSourcePath(job, image); // enhanced cache or working
      const destPath = path.join(tempPath, 'IMAGES', image.filename);
      await fs.promises.copyFile(sourcePath, destPath);
    }

    // Write AUTPRINT.MRK to MISC/
    const dpofContent = generateDPOF(job);
    await fs.promises.writeFile(
      path.join(tempPath, 'MISC', 'AUTPRINT.MRK'),
      dpofContent,
      'utf8'
    );

    // All files written — rename p → o
    await fs.promises.rename(tempPath, finalPath);

    return { success: true, folderPath: finalPath, folderName: finalName };

  } catch (err) {
    // Leave as p — do not rename, do not delete
    // Operator will see "Import Error" status
    console.error(`Print send failed for ${job.jobNo}:`, err);
    return { success: false, error: err.message, folderPath: tempPath };
  }
}
```

### Source image selection

When copying images to `IMAGES/`, check for an enhanced cached version first:

```js
function getSourcePath(job, image) {
  // Use enhanced version if available
  if (image.enhanced && image.enhancedPath) {
    if (fs.existsSync(image.enhancedPath)) {
      return image.enhancedPath;
    }
  }
  // Fall back to working copy
  return path.join(job.jobPath, 'working', image.filename);
}
```

---

## 3. DPOF Folder Structure

Every job sent to a DPOF controller must use this exact structure:

```
{prefix}{JobNo}_{Product}_{Options}/
  IMAGES/
    IMG_001.jpg
    IMG_002.jpg
    ...
  MISC/
    AUTPRINT.MRK
```

**Rules:**
- All image files go directly into `IMAGES/` — no subdirectories
- The instruction file is always named `AUTPRINT.MRK` (not `DPOF.001` or any other name)
- `MISC/` contains only `AUTPRINT.MRK` — nothing else
- This structure applies to all DPOF controllers (Epson, Noritsu, and others)
- Darkroom Pro is excluded — separate phase

**`AUTPRINT.MRK` content** — use the existing DPOF generation logic currently producing `DPOF.001`. The content is unchanged — only the filename and location change:

- Old: `{jobFolder}/DPOF.001`
- New: `{jobFolder}/MISC/AUTPRINT.MRK`

---

## 4. Reprint Pipeline

Reprint jobs (`-r1`, `-r2` etc.) must go through the full print pipeline — same folder naming, same DPOF structure, same prefix swap.

### Folder naming for reprints

```
pPXDEMO-XXTFLD-1_r1_4x6 Photo Print_lustre_full-bleed   ← while writing
oPXDEMO-XXTFLD-1_r1_4x6 Photo Print_lustre_full-bleed   ← ready for controller
```

The reprint suffix (`_r1`, `_r2`) is inserted between the job number and the product name.

**Update `buildFolderName()` to accept an optional reprint suffix:**

```js
function buildFolderName(prefix, job, reprintSuffix = null) {
  const unsafe = /["/\\:*?<>|]/g;

  const jobNo = job.jobNo.replace(unsafe, '');
  const reprint = reprintSuffix ? `_${reprintSuffix}` : '';
  const product = job.product.replace(unsafe, '').trim();
  
  const options = (job.options || [])
    .map(opt => opt.value.replace(unsafe, '').trim())
    .filter(Boolean)
    .join('_');

  const segments = [
    `${jobNo}${reprint}`,
    product,
    options
  ].filter(Boolean).join('_');

  return `${prefix}${segments}`;
}
```

### Reprint source images

Reprint jobs always copy from `/originals/` of the parent job — never from `/working/` or `/cache/`. This ensures a reprint is always a clean re-run of the untouched source image.

```js
function getReprintSourcePath(parentJob, image) {
  return path.join(parentJob.jobPath, 'originals', image.filename);
}
```

---

## 5. Job Status Display

### Prefix → Status mapping

OHD reads the prefix character of the output folder name to determine the job's current status. This applies to **all DPOF controller jobs only**.

| Folder prefix | Status shown in OHD | Colour |
|---|---|---|
| `p` | Import Error | Red |
| `o` | Awaiting Import | Amber |
| `q` | Failed Import | Red |
| `e` | Mark as Printed | Green (button) |

**Notes:**
- `p` = file transfer failed midway. Rare edge case but must be surfaced to the operator.
- `o` = successfully written, waiting for controller to import. Normal state after send.
- `q` = controller attempted import but failed. Operator must investigate and resend.
- `e` = operator has confirmed job is printed. Set by operator clicking "Mark as Printed" button — NOT set automatically.

### "Mark as Printed" button

- Remains a **manual operator action** — not automated
- Operator clicks "Mark as Printed" in the job list ACTIONS column
- OHD renames the output folder from `o{...}` to `e{...}`
- Job status updates to reflect the rename
- This button is only shown for DPOF jobs in `o` (Awaiting Import) status

### Status detection — how OHD reads the prefix

When the job list loads or refreshes, for each DPOF job OHD scans the configured output folder for a matching folder:

```js
async function getJobOutputStatus(job, destBasePath) {
  const prefixes = ['p', 'o', 'q', 'e'];
  const baseName = buildFolderName('', job); // no prefix

  for (const prefix of prefixes) {
    const folderName = `${prefix}${baseName}`;
    const folderPath = path.join(destBasePath, folderName);
    try {
      await fs.promises.access(folderPath);
      return { prefix, folderName, folderPath };
    } catch {
      // not found, try next prefix
    }
  }
  return null; // not yet sent
}
```

### Polling for Failed Import (`o` → `q`)

OHD polls jobs in `o` (Awaiting Import) status to detect if the controller renames the folder to `q` (failed).

**Rules:**
- Poll interval: **10 seconds**
- Only poll jobs currently in `o` status
- When a job moves to `q` → stop polling it, show "Failed Import" alert to operator
- When a job moves to `e` (operator marked as printed) → stop polling
- If no jobs are in `o` status → pause polling (resume when a new job is sent)
- Do **not** poll `p` or `e` jobs

```js
// Pseudocode for poll loop
async function pollAwaitingJobs(jobs, destBasePath) {
  const awaitingJobs = jobs.filter(j => j.outputStatus?.prefix === 'o');
  
  for (const job of awaitingJobs) {
    const status = await getJobOutputStatus(job, destBasePath);
    if (status?.prefix === 'q') {
      // Notify renderer — job failed import
      mainWindow.webContents.send('ohd:job:status-changed', {
        jobId: job.jobNo,
        status: 'Failed Import',
        prefix: 'q'
      });
    }
  }
}

// Start polling — 10 second interval
let pollTimer = null;

function startStatusPolling(jobs, destBasePath) {
  if (pollTimer) return; // already running
  pollTimer = setInterval(() => {
    pollAwaitingJobs(jobs, destBasePath);
  }, 10000);
}

function stopStatusPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
```

### IPC channels — status

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `ohd:job:get-output-status` | renderer → main | `{ jobNo, product, options }` | `{ prefix, folderName }` or `null` |
| `ohd:job:mark-printed` | renderer → main | `{ jobNo, product, options }` | `{ success: true }` |
| `ohd:job:status-changed` | main → renderer | `{ jobId, status, prefix }` | — (event, no response) |

---

## 6. Job List UI Changes

### Status column

For DPOF jobs that have been sent, replace the current status display with the prefix-driven status:

| Prefix | Badge text | Badge colour |
|---|---|---|
| `p` | Import Error | Red |
| `o` | Awaiting Import | Amber |
| `q` | Failed Import | Red |
| `e` | Printed | Grey |

Jobs not yet sent retain their existing status (e.g. "Received", "In Production").

### ACTIONS column

For DPOF jobs in `o` (Awaiting Import) status:
- Show **"Mark as Printed"** button (teal, existing style)
- This replaces the "Send to Print" button once the job has been sent

For DPOF jobs in `q` (Failed Import) status:
- Show **"Resend"** button (amber/orange) alongside a red "Failed Import" badge
- Resend follows the full pipeline — new `p` folder, writes files, renames to `o`

For DPOF jobs in `p` (Import Error) status:
- Show **"Retry"** button (red outline) 
- Retry attempts to complete the write and rename to `o`

For DPOF jobs in `e` (Printed) status:
- No action button needed — job is complete

---

## 7. Build Order

Build in this sequence:

1. **`buildFolderName()`** utility function — add to `src/shared/printUtils.js` (new file). No dependencies. Include unit-testable examples.
2. **`getJobOutputStatus()`** — add to `src/main/jobs/outputStatusManager.js` (new file).
3. **`sendToController()`** — update existing print send logic in main process. Replace old folder naming and structure. Depends on `buildFolderName` and `getSourcePath`.
4. **DPOF structure** — update `IMAGES/` + `MISC/AUTPRINT.MRK` layout within `sendToController()`. Rename instruction file from `DPOF.001` to `AUTPRINT.MRK` in `MISC/`.
5. **Reprint pipeline** — update `reprintManager.js` to call `sendToController()` with reprint suffix. Depends on `buildFolderName`.
6. **IPC handlers** — register `ohd:job:get-output-status`, `ohd:job:mark-printed`. Add `ohd:job:status-changed` as a push event from main → renderer.
7. **Status polling** — add poll loop in main process. Start on app launch. Push status changes to renderer via `ohd:job:status-changed`.
8. **Job list UI** — update STATUS column and ACTIONS column to reflect prefix-driven statuses. Wire "Mark as Printed", "Resend", and "Retry" buttons.

---

## 8. What Is Explicitly Out of Scope

Do not build these — they are separate phases:

- Darkroom Pro output format and status handling
- Differences between Epson and Noritsu DPOF variants
- Batch resend of multiple failed jobs
- Email/notification alerts for failed imports
ENDOFBRIEF
echo "done"