# OHD — Job Review Panel: Claude Code Brief

## Overview

Build a **Job Review Panel** into the existing OrderHub Downloader (OHD) Electron app.

This is a slide-in drawer that opens within the existing Electron window when an operator selects a job. It allows the operator to:

- Preview all images in the job as thumbnails with **live CMY colour correction preview**
- Adjust **print quantity** per image with delta tracking (original vs current)
- Apply **CMY colour corrections** via sliders
- **Flag images for reprint**, which generates a local `-r1` child job folder
- **Close** and return to the job list view — no separate window, no routing change

This panel sits entirely within the existing OHD renderer window. The job list remains mounted behind it.

---

## Brand Colours

```
Green:     #72B622
Blue-grey: #415564

UI palette (all derived from #415564):
BG_DEEP:    #2a3a45
BG_BASE:    #324452
BG_PANEL:   #2e3e4c
BG_CARD:    #374d5c
BG_HOVER:   #3d5464
BG_INPUT:   #2a3a45
BORDER:     #4a6070
BORDER_DIM: #3a4e5e
TEXT_DIM:   #8aa8be
TEXT_MUTED: #5d7a8a
```

---

## Files to Create

### Renderer (`src/renderer/views/JobReview/`)

| File | Purpose |
|------|---------|
| `index.jsx` | Slide-in drawer wrapper. Entry point. Handles open/close animation. |
| `ThumbnailGrid.jsx` | Scrollable grid of all images in the job (left panel). |
| `ThumbnailCard.jsx` | Single thumbnail. Canvas-rendered with live CMY correction preview. Reprint badge. Modified badge. |
| `ControlPanel.jsx` | Right panel. Hosts CMY sliders, QTY controls, reprint flag toggle. |
| `CMYSliders.jsx` | Reusable CMY slider component (Cyan, Magenta, Yellow). |
| `useJobReview.js` | All state and logic. No business logic in components. |

### Main Process (`src/main/jobs/`)

| File | Purpose |
|------|---------|
| `sidecarManager.js` | Read and write the JSON sidecar file for a job. |
| `originalsManager.js` | On first edit, copy all images to `/originals/`. Handles reset. |
| `reprintManager.js` | Create `-r1` folder. Copy flagged images from `/originals/`. Write reprint sidecar. |
| `imageProcessor.js` | **Stub only for now.** Will apply corrections to images at print time in Phase 3. Export an empty `applyCorrections()` function. |

### Shared (`src/shared/`)

| File | Purpose |
|------|---------|
| `jobSchema.js` | Single source of truth for the sidecar JSON structure. Exports a `createImageEntry()` factory and a `createSidecar()` factory. |

---

## Sidecar JSON Structure

Defined in `src/shared/jobSchema.js`. One file per job, saved as `{jobId}.json` in the job root folder.

```json
{
  "jobId": "JOB-00452",
  "schemaVersion": 1,
  "createdAt": "2026-03-05T10:00:00Z",
  "modifiedAt": "2026-03-05T10:22:00Z",
  "reprintOf": null,
  "images": [
    {
      "filename": "IMG_001.jpg",
      "qtyOriginal": 1,
      "qtyCurrent": 2,
      "corrections": {
        "cyan": 0,
        "magenta": 0,
        "yellow": 0
      },
      "reprint": false,
      "reprintJobId": null,
      "enhanced": false,
      "enhancementSource": null
    }
  ]
}
```

**Rules:**
- `qtyOriginal` is set once at job load and never changed again
- `corrections` values are integers in the range `-20` to `+20`
- `enhanced` and `enhancementSource` are stubbed for Phase 3 — always `false` / `null` for now
- `reprintOf` on a reprint sidecar contains the parent job ID (e.g. `"JOB-00452"`)

---

## Job Folder Structure

```
/jobs/
  JOB-00452/
    /originals/          ← created on first edit, source of truth, never modified
    /working/            ← OHD reads/writes here for corrections and print output
    /cache/              ← Phase 3: enhanced images land here (create folder, leave empty)
    JOB-00452.json       ← sidecar

  JOB-00452-r1/          ← created when operator sends a reprint
    /originals/          ← copied from parent /originals/, NOT parent /working/
    /working/            ← only the flagged images
    /cache/              ← stub, empty
    JOB-00452-r1.json    ← reprint sidecar (reprintOf: "JOB-00452")
```

**Critical rule:** A reprint always copies from `/originals/` of the parent job — never from `/working/`. This ensures a reprint is always a clean re-run of the untouched source image.

---

## Folder Structure: `originalsManager.js` Logic

```
On first edit of any image in a job:
  1. Check if /originals/ folder exists
  2. If not → copy ALL images from /working/ into /originals/
  3. Mark sidecar as having originals backed up

On reset (single image):
  1. Copy /originals/{filename} back to /working/{filename}
  2. Reset that image's sidecar entry to defaults

On reset (full job):
  1. Copy all files from /originals/ back to /working/
  2. Rewrite sidecar with all corrections/qty reset to original values
```

---

## IPC Channels

All channels prefixed `ohd:`. Defined in main process, called from renderer via `ipcRenderer.invoke`.

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `ohd:job:load` | renderer → main | `{ jobId, jobPath }` | Full sidecar object + array of image filenames |
| `ohd:job:save` | renderer → main | Full sidecar object | `{ success: true }` |
| `ohd:job:reset-image` | renderer → main | `{ jobId, filename }` | Updated sidecar entry for that image |
| `ohd:job:reset-all` | renderer → main | `{ jobId }` | Fresh sidecar object |
| `ohd:reprint:create` | renderer → main | `{ jobId, jobPath }` | `{ reprintJobId, reprintJobPath }` |
| `ohd:print:send` | renderer → main | `{ jobId, jobPath }` | Existing — do not change |

---

## `useJobReview.js` — State & Actions

This hook owns all state. Components are display-only and call actions from this hook.

### State shape

```js
{
  jobId: string,
  images: ImageEntry[],       // full sidecar images array
  selectedId: string,         // currently selected image filename
  holdCorrection: boolean,    // if true, corrections broadcast to all images
  isDirty: boolean,           // true if any unsaved changes
  isSaving: boolean,
  reprintCount: number,       // how many reprints have been sent this session
}
```

### Actions to expose

```js
selectImage(filename)
updateCorrection(channel, value)      // channel: 'cyan' | 'magenta' | 'yellow'
updateQty(filename, delta)
toggleReprint(filename)
toggleHold()
resetImage(filename)
resetAll()
saveJob()                             // calls ohd:job:save IPC
sendReprints()                        // calls ohd:reprint:create IPC
```

---

## Drawer Behaviour (`index.jsx`)

- Triggered from the job list by setting a `selectedJobId` in shared state or context
- Slides in from the right over the job list (CSS transform transition, ~250ms)
- Job list remains mounted behind it — do not unmount or route away
- A close button (top right) and pressing `Escape` both close the drawer
- On close: if `isDirty` is true, auto-save before closing (call `saveJob()` first)
- On open: call `ohd:job:load` IPC to fetch sidecar and image list

```jsx
// Rough mount pattern in job list view:
{selectedJobId && (
  <JobReviewDrawer
    jobId={selectedJobId}
    jobPath={selectedJobPath}
    onClose={() => setSelectedJobId(null)}
  />
)}
```

---

## Launching the Panel — ACTIONS Column Button

The Job Review panel is launched from the **ACTIONS column** in the existing job list table.

The ACTIONS column currently contains a single **"Send to Print"** teal button per row. Add a secondary **"Review"** button to the left of it:

```
[ Review ]  [ Send to Print ]
```

### Button styling

- **"Review"** — outlined style, not filled. Border colour `#415564`, text colour `#415564`, background transparent. On hover: background `#415564`, text white.
- **"Send to Print"** — existing style, do not change.

### What the Review button passes to the drawer

Each job row already has access to its `jobId` and `jobPath` (the local folder where images are stored). The Review button click sets these into state to trigger the drawer:

```jsx
// In the job list row component — add alongside existing Send to Print button:
<button
  className="btn-review"
  onClick={() => {
    setReviewJobId(job.jobId);
    setReviewJobPath(job.jobPath);
  }}
>
  Review
</button>
```

### State to add to the job list view

Add two state values to the job list view component (or its parent context):

```js
const [reviewJobId, setReviewJobId] = useState(null);
const [reviewJobPath, setReviewJobPath] = useState(null);
```

Mount the drawer conditionally below the job list table:

```jsx
{reviewJobId && (
  <JobReviewDrawer
    jobId={reviewJobId}
    jobPath={reviewJobPath}
    onClose={() => {
      setReviewJobId(null);
      setReviewJobPath(null);
    }}
  />
)}
```

### FLAGS column indicator (optional — implement only if straightforward)

If a job has been through the review panel and has saved corrections or reprint flags, add a small pencil icon (✎) to the FLAGS column alongside the existing lightning bolt and note icons. This gives operators a quick visual cue that a job has been modified. Only implement this if the FLAGS column is already component-driven and easy to extend — do not restructure the job list table to achieve it.

---

## ThumbnailCard — Canvas Rendering

Each thumbnail is rendered on an HTML `<canvas>` element. CMY corrections are applied as a colour overlay so the operator can see the effect without modifying any file.

**Correction preview logic:**
- Cyan adds a cyan tint (reduces red channel visually)
- Magenta adds a magenta tint (reduces green channel visually)
- Yellow adds a yellow tint (reduces blue channel visually)
- Overlay opacity scales with correction magnitude
- This is a visual approximation only — actual correction is applied at print time by `imageProcessor.js`

**Badges on thumbnail:**
- `REPRINT` — red, shown when `reprint: true`
- `MOD` — green, shown when qty or corrections differ from original
- QTY badge — shown when `qtyCurrent !== qtyOriginal`

---

## CMYSliders Component

```jsx
<CMYSliders
  corrections={{ cyan, magenta, yellow }}
  onChange={(channel, value) => updateCorrection(channel, value)}
  disabled={false}
/>
```

- Range: `-20` to `+20` per channel
- Displays current value with `+` prefix when positive
- `+` / `−` buttons for single-step increment as well as drag slider
- Cyan accent colour: `#44cccc`
- Magenta accent colour: `#cc44cc`
- Yellow accent colour: `#cccc44`

---

## QTY Control

- Shows current quantity as a large number
- `+` / `−` buttons, minimum value `0`
- When `qtyCurrent !== qtyOriginal`, shows `orig: {qtyOriginal}` below in muted text
- Delta is stored in the sidecar — original value is never overwritten

---

## Reprint Flag

- Toggle per image
- When toggled on: image gets `reprint: true` in sidecar, red border on thumbnail
- Bottom action bar shows: `↺ Send {n} Reprints → JOB-00452-r1` button
- On send: calls `ohd:reprint:create` IPC, clears all reprint flags, increments `reprintCount`
- Reprint job naming: `{parentJobId}-r{n}` where n increments per session

---

## Build Order

Build in this sequence to avoid blocked dependencies:

1. **`jobSchema.js`** — data shape, factory functions. No dependencies.
2. **`sidecarManager.js`** — read/write JSON. Depends on jobSchema.
3. **`originalsManager.js`** — folder operations. Depends on sidecarManager.
4. **`reprintManager.js`** — reprint folder creation. Depends on originalsManager.
5. **`imageProcessor.js`** — stub only. No dependencies.
6. **IPC handlers** — wire up all `ohd:job:*` and `ohd:reprint:*` channels in main process.
7. **`useJobReview.js`** — state hook. Calls IPC channels.
8. **`CMYSliders.jsx`** — isolated UI component. No dependencies.
9. **`ThumbnailCard.jsx`** — canvas component. No dependencies.
10. **`ThumbnailGrid.jsx`** — composes ThumbnailCard. Depends on useJobReview.
11. **`ControlPanel.jsx`** — composes CMYSliders + QTY + Reprint. Depends on useJobReview.
12. **`index.jsx`** — drawer wrapper. Composes everything. Wires onClose.

---

## What Is Explicitly Out of Scope (Phase 1)

Do not build these — they are stubbed only:

- Perfectly Clear / Topaz API integration (`imageProcessor.js` is a stub)
- Soft proof / PDF output
- Per-printer correction profiles
- Reason codes on reprints
- OrderHub API calls for reprint jobs
- Any modification to the existing `ohd:print:send` flow

---

## Visual Reference

A working React mockup of the UI is available at:
`OHD_OrderReview.jsx`

Use this as the visual reference for layout, colours, and component behaviour. The mockup uses the correct brand colours and demonstrates all interactive states.

---

## Notes for Claude Code

- OHD is an **Electron app**. Main process is Node.js, renderer is React.
- All file system operations (sidecar read/write, folder creation, file copy) happen in the **main process only**. The renderer never touches the file system directly — always via IPC.
- Use `fs/promises` for all async file operations in the main process.
- The `/cache/` folder should be created but left empty — it is a Phase 3 hook.
- `imageProcessor.js` must export `applyCorrections()` as a named export even though it is a stub — Phase 3 will implement it without changing the import signature.
- Do not create any new Electron `BrowserWindow` instances. Everything stays in the existing window.

---

## Phase 3 — AI Enhancement via Replicate / Topaz

This phase activates the Enhancement panel in the Job Review screen and adds Replicate API key configuration to the OHD Settings screen.

---

### New Files to Create

#### Main Process (`src/main/enhancement/`)

| File | Purpose |
|------|---------|
| `replicateClient.js` | Wraps the Replicate Node.js SDK. Handles image upload, polling, and result download. |
| `enhancementManager.js` | Orchestrates enhancement jobs. Reads API key from settings, calls replicateClient, saves result to `/cache/`. Updates sidecar. |

#### Renderer (`src/renderer/views/Settings/`)

| File | Purpose |
|------|---------|
| `AIEnhancementSettings.jsx` | New section added to the existing Settings screen. API key field, default model selector, face enhancement toggle, Test button. |

---

### Settings Screen — AI Enhancement Section

Add a new section to the existing Settings screen. Do not replace or restructure existing settings — append this as a new named section.

```
AI Enhancement
─────────────────────────────────────────────
Replicate API Key    [••••••••••••] [Show] [Test]
                     Get your key at replicate.com

Default Model        [Standard V2            ▾]

☐ Enable face enhancement by default
☐ Enable auto-enhance on job load
─────────────────────────────────────────────
[ Save Settings ]
```

**Test button behaviour:**
- Calls `ohd:enhancement:test` IPC
- Main process makes a minimal Replicate API call to verify the token is valid
- Shows inline result: green "✓ API key valid" or red "✗ Invalid key — check and try again"
- Does not process a real image — just validates authentication

**Key storage:**
- Store the Replicate API key using the existing `electron-store` instance already in OHD
- Store under key: `replicateApiKey`
- Store default model under: `enhancementDefaultModel`
- Store face enhancement default under: `enhancementFaceEnhancement` (boolean)
- Store auto-enhance preference under: `enhancementAutoEnhance` (boolean)
- The API key field should mask the value (password input type) with a Show/Hide toggle
- Never log the API key to console or Activity Log

---

### IPC Channels — Enhancement

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `ohd:enhancement:test` | renderer → main | `{ apiKey }` | `{ valid: true }` or `{ valid: false, error: string }` |
| `ohd:enhancement:run` | renderer → main | `{ jobId, filename, model, options }` | `{ status: 'started', predictionId }` |
| `ohd:enhancement:status` | renderer → main | `{ predictionId }` | `{ status: 'processing' \| 'succeeded' \| 'failed', outputPath? }` |
| `ohd:enhancement:cancel` | renderer → main | `{ predictionId }` | `{ cancelled: true }` |

---

### `replicateClient.js` — Implementation

Use the official Replicate Node.js SDK (`npm install replicate`).

```js
const Replicate = require('replicate');
const fs = require('fs');
const https = require('https');
const path = require('path');

async function runUpscale(apiKey, inputPath, cachePath, options = {}) {
  const replicate = new Replicate({ auth: apiKey });

  // Read image as base64 data URI for Replicate
  const imageBuffer = await fs.promises.readFile(inputPath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(inputPath).replace('.', '').toLowerCase();
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dataUri = `data:${mimeType};base64,${base64}`;

  const output = await replicate.run(
    "topazlabs/image-upscale",
    {
      input: {
        image: dataUri,
        model: options.model || "Standard V2",
        output_format: "jpg",
        output_quality: 95,
        face_enhancement: options.faceEnhancement || false,
        sharpen: options.sharpen || null,
        denoise: options.denoise || null,
        fix_compression: options.fixCompression || null,
      }
    }
  );

  // Output is a URL — download and save to cache
  await downloadFile(output, cachePath);
  return cachePath;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function validateApiKey(apiKey) {
  try {
    const replicate = new Replicate({ auth: apiKey });
    await replicate.models.get("topazlabs", "image-upscale");
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = { runUpscale, validateApiKey };
```

---

### `enhancementManager.js` — Implementation

```js
const { runUpscale, validateApiKey } = require('./replicateClient');
const sidecarManager = require('../jobs/sidecarManager');
const path = require('path');
const fs = require('fs');

async function enhanceImage(jobId, jobPath, filename, options = {}) {
  const inputPath = path.join(jobPath, 'working', filename);
  const cacheDir = path.join(jobPath, 'cache');
  
  // Ensure cache directory exists
  await fs.promises.mkdir(cacheDir, { recursive: true });
  
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);
  const cachePath = path.join(cacheDir, `${baseName}_enhanced.jpg`);

  // Run upscale
  await runUpscale(options.apiKey, inputPath, cachePath, options);

  // Update sidecar
  const sidecar = await sidecarManager.load(jobId, jobPath);
  const image = sidecar.images.find(img => img.filename === filename);
  if (image) {
    image.enhanced = true;
    image.enhancementSource = 'Replicate/Topaz';
    image.enhancedPath = cachePath;
    image.enhancedAt = new Date().toISOString();
    await sidecarManager.save(jobId, jobPath, sidecar);
  }

  return cachePath;
}

module.exports = { enhanceImage, validateApiKey };
```

---

### Enhancement Panel in Job Review — UI Changes

The Enhancement section in the `ControlPanel.jsx` is currently stubbed and greyed out. Activate it as follows:

**If no API key is configured:**
```
AI Enhancement
──────────────────────────────
  Configure Replicate API key
  in Settings to enable
  [Open Settings]
──────────────────────────────
```

**If API key is configured and image is NOT enhanced:**
```
AI Enhancement
──────────────────────────────
Model  [Standard V2        ▾]
       ☐ Face enhancement

[ ✨ Upscale This Image ]
──────────────────────────────
```

**While processing (after button clicked):**
```
AI Enhancement
──────────────────────────────
  ⟳ Enhancing via Topaz...
  This may take 30–60 seconds
  [Cancel]
──────────────────────────────
```

**After successful enhancement:**
```
AI Enhancement
──────────────────────────────
  ✓ Enhanced via Topaz
  Model: Standard V2
  [View Original] [Re-enhance]
──────────────────────────────
```

**Thumbnail badge:** When `enhanced: true` in sidecar, show a purple `AI` badge on the thumbnail alongside any existing MOD/REPRINT badges.

**At print time:** When OHD sends a job to the print controller, check if `/cache/{filename}_enhanced.jpg` exists for each image. If it does, use the cached enhanced version instead of the working original.

---

### Available Models — Dropdown Options

Show these options in the model selector in both Settings and the Enhancement panel:

| Display Name | API Value |
|---|---|
| Standard V2 (Recommended) | `Standard V2` |
| High Fidelity V2 | `High Fidelity V2` |
| Low Resolution V2 | `Low Resolution V2` |
| Recovery V2 — Extreme rescue | `Recovery V2` |

Default selection: `Standard V2`

For photo lab use, do not expose Generative models (Redefine, Wonder, Standard MAX) in Phase 3 — these are slower and may alter image content unpredictably, which is not appropriate for production print workflows.

---

### Sidecar Schema Updates for Phase 3

Add the following fields to each image entry in `jobSchema.js`. These were stubbed as `null` in Phase 1:

```json
{
  "enhanced": false,
  "enhancementSource": null,
  "enhancedPath": null,
  "enhancedAt": null,
  "enhancementModel": null
}
```

Update `createImageEntry()` in `jobSchema.js` to include `enhancedPath`, `enhancedAt`, and `enhancementModel` as null defaults.

---

### Build Order — Phase 3

1. **`npm install replicate`** — add Replicate SDK dependency
2. **`replicateClient.js`** — API wrapper. Test `validateApiKey()` independently first.
3. **`enhancementManager.js`** — orchestration layer. Depends on replicateClient + sidecarManager.
4. **IPC handlers** — register `ohd:enhancement:test`, `ohd:enhancement:run`, `ohd:enhancement:status`, `ohd:enhancement:cancel` in main process.
5. **`jobSchema.js`** — add new fields to `createImageEntry()`.
6. **`AIEnhancementSettings.jsx`** — Settings UI section. Wire to `ohd:enhancement:test` IPC.
7. **`ControlPanel.jsx`** — Activate Enhancement panel. Wire to `ohd:enhancement:run` and `ohd:enhancement:status` IPC. Add polling logic for status updates.
8. **`ThumbnailCard.jsx`** — Add `AI` badge when `enhanced: true`.
9. **Print send logic** — Update `ohd:print:send` handler to substitute enhanced cache files where available.

---

### Phase 3 Out of Scope

- Batch enhancement (all images in a job at once) — Phase 4
- Perfectly Clear integration — separate decision
- Auto-enhance on job load (setting exists but does not need to be wired in Phase 3)
- Cost tracking / per-image billing dashboard

