# OHD — Channel Mapping & Job Routing: Claude Code Brief

## Overview

This brief covers the job routing system in OHD. When a job arrives, OHD needs to know where to send it at print time. This is determined by a three-layer decision tree.

---

## Routing Decision Tree

At print time, OHD evaluates each job in this order:

```
1. Does this job's product code + options match a Process Folder exception?
   → Yes: copy files to the configured process folder, done
   → No: continue

2. Is this job's Process value assigned to an Order Controller?
   → No: job waits — show "Assign" button, status stays Pending
   → Yes: continue

3. Does this product code + options combination have a channel 
   mapping for that controller?
   → No: job waits — show "Assign" button, status stays Pending
   → Yes: send via DPOF pipeline to that channel
```

If a job has no valid route it sits in Pending indefinitely until the operator configures one. OHD never discards or errors a job silently — it always waits.

---

## Data Model

### 1. Process → Controller Mapping

Stored in electron-store under `processControllerMappings` as an array:

```json
[
  {
    "process": "Lab",
    "controllerId": "epson-1"
  },
  {
    "process": "PIXFIZZ - Photo Prints",
    "controllerId": "epson-1"
  }
]
```

### 2. Order Controllers

Stored in electron-store under `orderControllers` as an array:

```json
[
  {
    "id": "epson-1",
    "name": "Epson SureLab",
    "type": "dpof",
    "outputPath": "C:\\OrderHub Controllers\\Epson"
  },
  {
    "id": "noritsu-1",
    "name": "Noritsu",
    "type": "dpof",
    "outputPath": "C:\\OrderHub Controllers\\Noritsu"
  }
]
```

### 3. Channel Mappings

Stored in electron-store under `channelMappings` as an array:

```json
[
  {
    "id": "cm-001",
    "controllerId": "epson-1",
    "productCode": "0406-cut-print",
    "options": [
      { "name": "finish-options", "value": "lustre" },
      { "name": "layout-options", "value": "full-bleed" }
    ],
    "channelNumber": 1
  }
]
```

### 4. Process Folder Exceptions

Stored in electron-store under `processFolderExceptions` as an array:

```json
[
  {
    "id": "pfe-001",
    "productCode": "0808-photo-print",
    "options": [
      { "name": "finish", "value": "luster" }
    ],
    "folderPath": "C:\\Process Folders\\8x8"
  }
]
```

---

## Routing Logic — Implementation

Add a new file `src/main/services/routing-service.js`:

```js
const Store = require('electron-store');
const store = new Store();

/**
 * Resolve the routing destination for a job.
 * Returns one of:
 *   { type: 'process-folder', folderPath }
 *   { type: 'controller', controllerId, controllerName, outputPath, channelNumber }
 *   { type: 'unrouted', reason: 'no-controller' | 'no-channel' }
 */
function resolveRoute(job) {
  const productCode = job.product_code;
  const options = job.options || [];
  const process = job.process;

  // Layer 1 — Process Folder Exception
  const exceptions = store.get('processFolderExceptions', []);
  const exception = exceptions.find(e =>
    e.productCode === productCode && optionsMatch(e.options, options)
  );
  if (exception) {
    return { type: 'process-folder', folderPath: exception.folderPath };
  }

  // Layer 2 — Process → Controller
  const processMap = store.get('processControllerMappings', []);
  const processMapping = processMap.find(m => m.process === process);
  if (!processMapping) {
    return { type: 'unrouted', reason: 'no-controller' };
  }

  const controllers = store.get('orderControllers', []);
  const controller = controllers.find(c => c.id === processMapping.controllerId);
  if (!controller) {
    return { type: 'unrouted', reason: 'no-controller' };
  }

  // Layer 3 — Channel Mapping
  const channelMappings = store.get('channelMappings', []);
  const channelMapping = channelMappings.find(m =>
    m.controllerId === controller.id &&
    m.productCode === productCode &&
    optionsMatch(m.options, options)
  );
  if (!channelMapping) {
    return { type: 'unrouted', reason: 'no-channel', controller };
  }

  return {
    type: 'controller',
    controllerId: controller.id,
    controllerName: controller.name,
    outputPath: controller.outputPath,
    channelNumber: channelMapping.channelNumber
  };
}

/**
 * Options match if every option in the mapping exists in the job options.
 * Job may have additional options — partial match is sufficient.
 */
function optionsMatch(mappingOptions, jobOptions) {
  return mappingOptions.every(mo =>
    jobOptions.some(jo => jo.name === mo.name && jo.value === mo.value)
  );
}

module.exports = { resolveRoute };
```

---

## Settings Screen — New Sections

Add two new sections to the existing Settings screen. Do not remove or restructure existing settings.

### Section 1 — Order Controllers

```
Order Controllers
─────────────────────────────────────────────
[ + Add Controller ]

┌─────────────────────────────────────────┐
│ Epson SureLab                    [Edit] [Delete] │
│ Type: DPOF                                       │
│ Output: C:\OrderHub Controllers\Epson            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Noritsu                          [Edit] [Delete] │
│ Type: DPOF                                       │
│ Output: C:\OrderHub Controllers\Noritsu          │
└─────────────────────────────────────────┘
─────────────────────────────────────────────
```

**Add/Edit Controller modal fields:**
- Name (text) — e.g. "Epson SureLab"
- Type (dropdown) — DPOF only for now (Darkroom Pro is a future phase)
- Output Path (text + Browse button) — folder path on disk

### Section 2 — Process Routing

```
Process Routing
─────────────────────────────────────────────
Assign each Process type to an Order Controller.
Jobs with no controller assigned will wait until configured.

Lab                    → [ Epson SureLab      ▾ ]
PIXFIZZ - Photo Prints → [ Epson SureLab      ▾ ]
Darkroom               → [ Not assigned       ▾ ]
─────────────────────────────────────────────
```

- Process values are populated from the distinct `process` values seen in jobs received by OHD (auto-discovered, not manually entered)
- Dropdown options: all configured Order Controllers + "Not assigned"
- Changes save immediately (no separate Save button needed)

### Section 3 — Channel Mappings (existing, enhance)

The existing channel mappings section should be updated to:
- Show which controller each mapping belongs to
- Group mappings by controller
- Show product code, options, and channel number per row
- Allow edit and delete per mapping

### Section 4 — Process Folder Exceptions

```
Process Folder Exceptions
─────────────────────────────────────────────
Jobs matching these product + option combinations will be 
copied to a folder instead of sent to a controller.

[ + Add Exception ]

┌─────────────────────────────────────────────┐
│ 0808-photo-print + finish: luster   [Edit] [Delete] │
│ → C:\Process Folders\8x8                           │
└─────────────────────────────────────────────────────┘
─────────────────────────────────────────────
```

**Add/Edit Exception modal fields:**
- Product Code (text)
- Options (key/value pairs, + Add Option button)
- Folder Path (text + Browse button)

---

## Job List — Assign Button

### When to show Assign button

Show the **Assign** button in the ACTIONS column when:
- `resolveRoute(job)` returns `{ type: 'unrouted', reason: 'no-channel' }`

Show **"Configure in Settings"** tooltip/message (no modal) when:
- `resolveRoute(job)` returns `{ type: 'unrouted', reason: 'no-controller' }`

When a valid route exists, show the normal **Review** + **Send to Print** buttons as usual.

### Assign button modal

When the operator clicks **Assign**, open a modal pre-filled with the job's details. The operator only needs to enter the channel number.

```
┌─────────────────────────────────────────────────┐
│  Assign Channel                                  │
│                                                  │
│  Product     8x8" Photo Print                    │
│  Product Code  0808-photo-print                  │
│  Controller  Epson SureLab                       │
│                                                  │
│  Options                                         │
│  finish: luster                                  │
│  photo-border: no-border                         │
│  image-enhancement: no                           │
│                                                  │
│  Channel Number  [ ___ ]                         │
│                                                  │
│  [ Cancel ]        [ Save Mapping ]              │
└─────────────────────────────────────────────────┘
```

**Fields:**
- Product, Product Code, Controller, Options — read-only, pre-filled from job
- Channel Number — numeric input, required

**On Save:**
1. Create a new channel mapping in electron-store with the job's `product_code`, `options`, `controllerId`, and the entered channel number
2. Close modal
3. Job list re-evaluates routing for that job — Assign button replaced with Review + Send to Print
4. Show brief success toast: "Channel mapping saved — job is ready to print"

**If no controller is assigned to this job's Process:**
Do not show the Assign modal. Instead show an inline message on the row:
```
No controller assigned to process "PIXFIZZ - Photo Prints". 
Configure in Settings → Process Routing.
```

---

## IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `ohd:routing:resolve` | renderer → main | `{ job }` | `{ type, ... }` |
| `ohd:routing:get-controllers` | renderer → main | — | `Controller[]` |
| `ohd:routing:save-controller` | renderer → main | `Controller` | `{ success }` |
| `ohd:routing:delete-controller` | renderer → main | `{ id }` | `{ success }` |
| `ohd:routing:get-process-mappings` | renderer → main | — | `ProcessMapping[]` |
| `ohd:routing:save-process-mapping` | renderer → main | `ProcessMapping` | `{ success }` |
| `ohd:routing:get-channel-mappings` | renderer → main | — | `ChannelMapping[]` |
| `ohd:routing:save-channel-mapping` | renderer → main | `ChannelMapping` | `{ success }` |
| `ohd:routing:delete-channel-mapping` | renderer → main | `{ id }` | `{ success }` |
| `ohd:routing:get-exceptions` | renderer → main | — | `ProcessFolderException[]` |
| `ohd:routing:save-exception` | renderer → main | `ProcessFolderException` | `{ success }` |
| `ohd:routing:delete-exception` | renderer → main | `{ id }` | `{ success }` |

---

## Integration with Print Send

Update the existing `jobs:sendToPrint` handler to use `resolveRoute()` before sending:

```js
ipcMain.handle('jobs:sendToPrint', async (event, job) => {
  const route = routingService.resolveRoute(job);

  if (route.type === 'unrouted') {
    return { success: false, error: 'No valid route configured for this job' };
  }

  if (route.type === 'process-folder') {
    // Copy files to process folder — no DPOF, no prefix swap, no status tracking
    return await processFolder.copyToFolder(job, route.folderPath);
  }

  if (route.type === 'controller') {
    // Existing DPOF pipeline — pass outputPath and channelNumber
    return await printService.sendToPrint(job, route.outputPath, route.channelNumber);
  }
});
```

---

## Process Folder Copy — Implementation

For `type: 'process-folder'` jobs, add `src/main/services/process-folder-service.js`:

```js
async function copyToFolder(job, destFolderPath) {
  // Use same folder naming convention as DPOF:
  // {prefix}{jobNo}_{product}_{options}
  // But no IMAGES/MISC structure — files copied flat into the folder
  // No prefix swap needed — just copy directly
  // No status tracking — job goes straight to "Sent" status in OHD
  
  const folderName = buildFolderName('', job);
  const destPath = path.join(destFolderPath, folderName);
  
  await fs.promises.mkdir(destPath, { recursive: true });
  
  for (const image of job.images) {
    const sourcePath = getSourcePath(job, image);
    await fs.promises.copyFile(sourcePath, path.join(destPath, image.filename));
  }
  
  return { success: true, folderPath: destPath };
}
```

Process folder jobs do not go through the `p`/`o`/`q`/`e` status lifecycle — they are marked as "Sent" immediately after the copy completes.

---

## Build Order

1. **`routing-service.js`** — `resolveRoute()` and `optionsMatch()`. No dependencies. Test independently.
2. **IPC handlers** — register all `ohd:routing:*` channels. Wire to electron-store reads/writes.
3. **Settings — Order Controllers section** — Add/Edit/Delete controllers UI.
4. **Settings — Process Routing section** — Process → Controller dropdown mapping. Auto-discover process values from received jobs.
5. **Settings — Process Folder Exceptions section** — Add/Edit/Delete exceptions UI.
6. **Settings — Channel Mappings** — Update existing section to show controller grouping.
7. **`process-folder-service.js`** — flat file copy for process folder jobs.
8. **`jobs:sendToPrint` handler** — integrate `resolveRoute()`. Pass `outputPath` and `channelNumber` through to print service.
9. **Job list — Assign button** — show when `reason: 'no-channel'`. Show inline message when `reason: 'no-controller'`.
10. **Assign modal** — pre-filled form, channel number input, saves to electron-store, refreshes job row routing.

---

## What Is Explicitly Out of Scope

- Darkroom Pro routing (separate phase)
- Multiple controllers per product code
- Bulk assign (multiple jobs at once)
- Controller health check / connectivity test
- Automatic channel number suggestion
