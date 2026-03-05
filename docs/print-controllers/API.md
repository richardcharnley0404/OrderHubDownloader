# Print Controller Integration — Developer API Reference

All services are singletons located in `src/main/services/`. They follow the pattern:

```js
const { serviceName } = require('./service-name');
// Usage: serviceName.method(...)
```

---

## PrintControllerStore

**File**: `src/main/services/print-controller-store.js`

Persistent storage for controllers and channels using electron-store (`print-controllers.json`).

### Controller Methods

#### `addController(controller)` → `string`

Adds a new controller. Returns the generated UUID.

```js
const { printControllerStore } = require('./print-controller-store');

const id = printControllerStore.addController({
  type: 'noritsu',
  name: 'Noritsu QSS-3901',
  vendorName: 'NORITSU KOKI',
  vendorAttribute: 'QSS-3901',
  hotFolderPath: 'C:\\PrintControllers\\Noritsu',
  autoCorrect: true,
  isActive: true
});
// id = 'uuid-...'
```

Controller object stored:
```js
{
  id: 'uuid-...',
  type: 'noritsu',
  name: 'Noritsu QSS-3901',
  vendorName: 'NORITSU KOKI',
  vendorAttribute: 'QSS-3901',
  hotFolderPath: 'C:\\PrintControllers\\Noritsu',
  autoCorrect: true,
  isActive: true,
  createdAt: '2026-02-21T15:30:45.000Z',
  updatedAt: '2026-02-21T15:30:45.000Z'
}
```

#### `getController(id)` → `object | undefined`

Returns the controller object or `undefined` if not found.

```js
const controller = printControllerStore.getController('uuid-...');
```

#### `getAllControllers()` → `object[]`

Returns all controllers as an array.

```js
const controllers = printControllerStore.getAllControllers();
// [{ id, name, type, ... }, ...]
```

#### `updateController(id, updates)` → `void`

Merges `updates` into the existing controller. Automatically sets `updatedAt`.

```js
printControllerStore.updateController('uuid-...', {
  hotFolderPath: 'D:\\NewHotFolder',
  autoCorrect: false
});
```

#### `deleteController(id)` → `void`

Deletes the controller and cascades — all channels belonging to this controller are also deleted.

```js
printControllerStore.deleteController('uuid-...');
```

### Channel Methods

#### `addChannel(channel)` → `string`

Adds a new channel. Returns the generated UUID.

```js
const channelId = printControllerStore.addChannel({
  controllerId: 'uuid-controller',
  channelNumber: 145,
  size: '6x4',
  finish: 'Gloss',
  printStyleCode: 'B',
  isActive: true
});
```

#### `getChannel(id)` → `object | undefined`

Returns the channel object.

```js
const channel = printControllerStore.getChannel('uuid-channel');
```

#### `getChannelsByController(controllerId)` → `object[]`

Returns all channels (active and inactive) for a controller.

```js
const channels = printControllerStore.getChannelsByController('uuid-controller');
// [{ id, controllerId, channelNumber, size, finish, printStyleCode, isActive }, ...]
```

#### `updateChannel(id, updates)` → `void`

Merges updates into the channel.

```js
printControllerStore.updateChannel('uuid-channel', { isActive: false });
```

#### `deleteChannel(id)` → `void`

Deletes the channel.

#### `findChannelForSize(controllerId, size)` → `object | undefined`

Finds the first active channel matching the given size string (case-insensitive). Returns `undefined` if no match.

```js
const channel = printControllerStore.findChannelForSize('uuid-controller', '4x6');
// { id, channelNumber: 145, size: '4x6', finish: 'Gloss', ... }
```

---

## JobStore

**File**: `src/main/services/job-store.js`

Persistent storage for DPOF job submissions using electron-store (`jobs.json`).

### Methods

#### `addJob(job)` → `string`

Adds a job with initial `dpofStatus: 'pending'`. Returns the UUID.

```js
const { jobStore } = require('./job-store');

const jobId = jobStore.addJob({
  controllerId: 'uuid-controller',
  channelId: 'uuid-channel',
  orderNumber: '100456',
  productCode: '8x12GLOSS',
  customerName: 'Jane Smith',
  orderReference: '100456',
  lineItems: [
    { lineItemNumber: 1, quantity: 2, filename: 'photo-001.jpg', width: 8, height: 12 }
  ],
  imageFiles: [
    { sourcePath: 'C:\\Downloads\\...\\photo-001.jpg', filename: 'photo-001.jpg' }
  ]
});
```

#### `getJob(id)` → `object | undefined`

Returns a job by its UUID.

#### `getJobByOrderNumber(orderNumber)` → `object | undefined`

Finds the first job with the given order number.

```js
const job = jobStore.getJobByOrderNumber('100456');
```

#### `updateJob(id, updates)` → `void`

Merges updates into the job.

```js
jobStore.updateJob(jobId, {
  dpofStatus: 'submitted',
  dpofSubmittedAt: new Date().toISOString(),
  dpofFolderPath: 'C:\\PrintControllers\\Noritsu\\o100456_8x12GLOSS'
});
```

#### `updateJobStatus(orderNumber, status)` → `void`

Updates `dpofStatus` and automatically sets the corresponding timestamp field.

```js
// Sets dpofStatus = 'accepted' and dpofAcceptedAt = now
jobStore.updateJobStatus('100456', 'accepted');

// Sets dpofStatus = 'failed' and dpofFailedAt = now
jobStore.updateJobStatus('100456', 'failed');
```

Timestamp fields set by status:

| Status | Timestamp field |
|--------|----------------|
| `submitted` | `dpofSubmittedAt` |
| `accepted` | `dpofAcceptedAt` |
| `failed` | `dpofFailedAt` |

#### `getAllJobs()` → `object[]`

Returns all jobs.

#### `getJobsByStatus(status)` → `object[]`

Returns jobs filtered by `dpofStatus`.

```js
const pendingJobs = jobStore.getJobsByStatus('pending');
const submittedJobs = jobStore.getJobsByStatus('submitted');
```

#### `deleteJob(id)` → `void`

Permanently deletes a job from the store.

---

## DPOFGenerator

**File**: `src/main/services/dpof-generator.js`

Generates DPOF file content as a string.

### `generate(controller, channel, job)` → `string`

Generates the complete DPOF content (header + all job sections).

```js
const { dpofGenerator } = require('./dpof-generator');

const dpofContent = dpofGenerator.generate(
  {
    vendorName: 'NORITSU KOKI',
    vendorAttribute: 'QSS-3901',
    autoCorrect: true
  },
  {
    printStyleCode: 'B',
    channelNumber: 145
  },
  {
    customerName: 'Jane Smith',
    orderNumber: '100456',
    orderReference: '100456',
    productCode: '8x12GLOSS',
    lineItems: [
      { lineItemNumber: 1, quantity: 2, filename: 'photo-001.jpg', width: 8, height: 12 }
    ]
  }
);

// Returns:
// [HDR]
// GEN REV = 01.00
// ...
// [JOB]
// ...
```

### `generateHeader(controller, channel, job)` → `string`

Generates the `[HDR]` section only. Used internally by `generate()`.

### `generateJob(lineItem, index, controller, job)` → `string`

Generates a single `[JOB]` section. Used internally by `generate()`.

Parameters:
- `lineItem`: `{ lineItemNumber, quantity, filename, width, height }`
- `index`: zero-based index (not currently used in output)
- `controller`: `{ vendorName, vendorAttribute }`
- `job`: `{ orderNumber, productCode, orderReference }`

### `formatTimestamp(date?)` → `string`

Formats a Date object as `YYYY:MM:DD:HH:MM:SS`. Defaults to `new Date()`.

```js
dpofGenerator.formatTimestamp(new Date('2026-02-21T15:30:45'));
// '2026:02:21:15:30:45'
```

---

## OrderFolderWriter

**File**: `src/main/services/order-folder-writer.js`

Creates the hot folder structure for DPOF submission.

### `writeOrderFolder(hotFolderPath, orderNumber, productCode, dpofContent, imageFiles)` → `Promise<string>`

Creates the folder structure, writes `DPOF.001`, and copies all images. Returns the folder path.

```js
const { orderFolderWriter } = require('./order-folder-writer');

const folderPath = await orderFolderWriter.writeOrderFolder(
  'C:\\PrintControllers\\Noritsu',   // hot folder path
  '100456',                            // order number
  '8x12GLOSS',                        // product code
  dpofContent,                         // string from DPOFGenerator
  [
    { sourcePath: 'C:\\Downloads\\...\\photo-001.jpg', filename: 'photo-001.jpg' },
    { sourcePath: 'C:\\Downloads\\...\\photo-002.jpg', filename: 'photo-002.jpg' }
  ]
);

// folderPath = 'C:\\PrintControllers\\Noritsu\\o100456_8x12GLOSS'
```

**Created structure:**

```
C:\PrintControllers\Noritsu\
└── o100456_8x12GLOSS\
    ├── DPOF.001
    └── IMAGES\
        ├── photo-001.jpg
        └── photo-002.jpg
```

**Throws**: If any image `sourcePath` does not exist (checked by `PrintService` before calling this).

---

## FolderMonitor

**File**: `src/main/services/folder-monitor.js`

Watches a hot folder for folder renames (prefix changes) caused by the print controller.

> **Note**: `FolderMonitor` is a class (not a singleton) so multiple instances can monitor different hot folders simultaneously. `PrintControllerService` manages one instance per controller.

### `startMonitoring(hotFolderPath, callback)` → `void`

Starts watching the directory. Scans existing folders on startup, then watches for changes.

```js
const { FolderMonitor } = require('./folder-monitor');

const monitor = new FolderMonitor();

monitor.startMonitoring('C:\\PrintControllers\\Noritsu', (status) => {
  console.log(status);
  // {
  //   orderNumber: '100456',
  //   productCode: '8x12GLOSS',
  //   status: 'accepted',    // 'submitted' | 'accepted' | 'failed'
  //   timestamp: Date
  // }
});
```

**Callback trigger conditions:**

| Old prefix | New prefix | `status` in callback |
|-----------|-----------|---------------------|
| none | `o` | `submitted` |
| `o` | `e` | `accepted` |
| `o` | `q` | `failed` |

**Note**: Events are debounced by 500ms to allow rename operations to complete.

### `stopMonitoring()` → `void`

Stops the filesystem watcher and clears all tracked state.

```js
monitor.stopMonitoring();
```

---

## PrintControllerService

**File**: `src/main/services/print-controller-service.js`

Orchestrates job submission and folder monitoring. Manages one `FolderMonitor` per controller.

### `submitJobToController(jobId)` → `Promise<string>`

Retrieves the job, controller, and channel from their stores, generates DPOF content, writes the order folder, and updates the job status to `submitted`. Returns the folder path.

```js
const { printControllerService } = require('./print-controller-service');

const folderPath = await printControllerService.submitJobToController('uuid-job');
// folderPath = 'C:\\PrintControllers\\Noritsu\\o100456_8x12GLOSS'
```

**Throws**: If the job, controller, or channel cannot be found.

### `startMonitoring(controllerId)` → `void`

Starts a `FolderMonitor` for the controller's hot folder. If monitoring is already running for this controller, does nothing.

```js
printControllerService.startMonitoring('uuid-controller');
```

When a status change is detected, it calls:
```js
jobStore.updateJobStatus(status.orderNumber, status.status);
```

### `stopMonitoring(controllerId)` → `void`

Stops monitoring for a specific controller.

### `stopAllMonitoring()` → `void`

Stops all active folder monitors. Call this during app shutdown.

```js
printControllerService.stopAllMonitoring();
```

### `getMonitoringStatus(controllerId)` → `boolean`

Returns `true` if monitoring is active for this controller.

```js
const isMonitoring = printControllerService.getMonitoringStatus('uuid-controller');
```

### `getAllMonitoredControllers()` → `string[]`

Returns an array of controller IDs currently being monitored.

```js
const ids = printControllerService.getAllMonitoredControllers();
// ['uuid-controller-1', 'uuid-controller-2']
```

---

## PrintService

**File**: `src/main/services/print-service.js`

Routes OrderHub API jobs to either the DPOF pipeline or file-copy pipeline.

### `sendToPrint(job)` → `Promise<object>`

Main entry point for sending a job to print. Reads the process mapping from config to decide which pipeline to use.

```js
const printService = require('./print-service');

const result = await printService.sendToPrint(apiJob);
// DPOF result:
// { success: true, method: 'dpof', sourcePath: '...', destPath: '...' }
// File-copy result:
// { success: true, method: 'copy', sourcePath: '...', destPath: '...' }
```

**`job` parameter** is an OrderHub API job object with fields:
- `id` — job ID
- `order_number` — order number
- `order_id` — order ID
- `process` — process type (used for mapping lookup)
- `product_code` — product code
- `customer_name` — customer name
- `options` — array of `{ name, value }` options (used for finish matching)
- `internal_job_id` — optional alternative ID for manifest lookup

**Throws**: Descriptive errors if configuration is missing or job cannot be routed.

---

## IPC Endpoints (Renderer → Main)

Exposed via `contextBridge` in `src/preload/preload.js`. Call these from the renderer as `window.electronAPI.*`.

| API method | IPC channel | Description |
|-----------|-------------|-------------|
| `getPrintControllers()` | `printControllers:getAll` | Get all controllers with their channels |
| `addPrintController(data)` | `printControllers:add` | Add a controller |
| `updatePrintController(id, updates)` | `printControllers:update` | Update a controller |
| `deletePrintController(id)` | `printControllers:delete` | Delete a controller (and its channels) |
| `addPrintChannel(data)` | `printControllers:addChannel` | Add a channel to a controller |
| `updatePrintChannel(id, updates)` | `printControllers:updateChannel` | Update a channel |
| `deletePrintChannel(id)` | `printControllers:deleteChannel` | Delete a channel |
| `runPrintControllerTest()` | `test:printController` | Run integration test |

### `getPrintControllers()` response

```js
[
  {
    id: 'uuid-...',
    name: 'Noritsu QSS-3901',
    type: 'noritsu',
    vendorName: 'NORITSU KOKI',
    vendorAttribute: 'QSS-3901',
    hotFolderPath: 'C:\\PrintControllers\\Noritsu',
    autoCorrect: true,
    isActive: true,
    createdAt: '...',
    updatedAt: '...',
    channels: [
      { id: 'uuid-ch', controllerId: 'uuid-...', channelNumber: 145, size: '6x4', finish: 'Gloss', printStyleCode: 'B', isActive: true }
    ]
  }
]
```

### `runPrintControllerTest()` response

```js
{
  success: true,
  output: '✓ Step 1: Controller created...\n✓ Step 2: Channel created...\n...'
}
// or on failure:
{
  success: false,
  output: '...',
  error: 'Error message'
}
```
