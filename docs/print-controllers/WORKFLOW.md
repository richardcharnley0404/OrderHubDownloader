# Print Controller Workflow Reference

---

## Order → DPOF → Print Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                      OrderHub API                               │
│          Job arrives with: process, product_code,               │
│          order_number, customer_name, options[]                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  User clicks "Send to Print"
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PrintService.sendToPrint(job)                │
│                                                                 │
│  1. configService.getProcessMapping(job.process)               │
│     → { folderPath?, controllerId? }                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
               ┌───────────┴────────────┐
               │                        │
         has controllerId          no controllerId
               │                        │
               ▼                        ▼
    ┌──────────────────┐    ┌───────────────────────┐
    │   DPOF Pipeline  │    │  File Copy Pipeline   │
    └────────┬─────────┘    └────────────┬──────────┘
             │                           │
             ▼                           ▼
    Validate controller        Check processFolderPath
    is found and active        is configured
             │                           │
             ▼                           ▼
    Locate download folder     Locate job source folder
    {downloadDir}/{order}      {downloadDir}/{order}/{job}
             │                           │
             ▼                           ▼
    Read manifest JSON         Copy folder recursively
    {orderNumber}.json         → {processFolderPath}/{job}
             │                           │
             ▼                           ▼
    Find job in manifest       markInProduction(jobId)
    by job.id                           │
             │                           ▼
             ▼                  { success, method: 'copy' }
    _matchChannel()
    → match by size [+ finish]
             │
             ▼
    Build lineItems[] from manifest images
    Build imageFiles[] with source paths
    Verify all images exist
             │
             ▼
    DPOFGenerator.generate(controller, channel, dpofJob)
    → DPOF content string
             │
             ▼
    OrderFolderWriter.writeOrderFolder(...)
    Creates: {hotFolder}/o{orderNumber}_{productCode}/
                           ├── DPOF.001
                           └── IMAGES/
                               └── *.jpg
             │
             ▼
    markInProduction(jobId) via OrderHub API
             │
             ▼
    { success: true, method: 'dpof', sourcePath, destPath }
```

---

## Job Lifecycle States

### DPOF Submission Status (`dpofStatus` in JobStore)

```
                     ┌──────────┐
                     │ pending  │  ← Initial state when job added to JobStore
                     └────┬─────┘
                          │
                          │  submitJobToController() called
                          │  (folder written to hot folder)
                          ▼
                     ┌──────────┐
                     │submitted │  ← Order folder created: o{num}_{code}/
                     └────┬─────┘
                          │
              ┌───────────┴────────────┐
              │                        │
    Controller renames:        Controller renames:
    o... → e...                o... → q...
              │                        │
              ▼                        ▼
         ┌──────────┐           ┌──────────┐
         │ accepted │           │  failed  │
         └──────────┘           └──────────┘
```

### OrderHub API Job Status (managed by job-service.js)

This is separate from `dpofStatus`. The OrderHub API status tracks:

```
received → in_production → [completed]
```

When `PrintService.sendToPrint()` succeeds (either pipeline), it calls `markInProduction(jobId)` to update the API status to `in_production`.

### Combined status timeline

```
Time →

API status:    [received] ──────────────────────────► [in_production]
                                        ▲
                              sendToPrint() succeeds
                              (folder written, API updated)

dpofStatus:    [pending] → [submitted] → [accepted]
                    ▲           ▲              ▲
                job added   folder       controller
                to store    written      renames folder
```

---

## Folder Naming Conventions

### Order folder (in hot folder)

```
{prefix}{orderNumber}_{productCode}
```

| Component | Example | Notes |
|-----------|---------|-------|
| `prefix` | `o` | Status prefix (see table below) |
| `orderNumber` | `100456` | From `job.order_number` (must be numeric for monitor to work) |
| `_` | `_` | Literal underscore separator |
| `productCode` | `8x12GLOSS` | From `job.product_code` |

Full example: `o100456_8x12GLOSS`

### Status prefixes

| Prefix | Status | Set by |
|--------|--------|--------|
| `o` | Submitted / pending | OrderHub Downloader (`OrderFolderWriter`) |
| `e` | Accepted / processing | Print controller software |
| `q` | Failed / rejected | Print controller software |

### Download directory structure

```
{downloadDirectory}\
└── {orderNumber}_{orderId}\        ← Order folder
    ├── {orderNumber}.json          ← Order manifest
    └── {orderNumber}_{jobId}\     ← Job folder
        ├── photo-001.jpg
        └── photo-002.jpg
```

### Manifest image filename format

Image filenames in the manifest are relative to the order folder:

```json
{
  "jobs": [
    {
      "jobId": "38334605",
      "images": [
        { "filename": "PXDEMO-K9MYDG_38334605/photo-001.jpg", "size": "4x6", "quantity": 2 }
      ]
    }
  ]
}
```

Full source path: `{downloadDir}\{orderNumber}_{orderId}\PXDEMO-K9MYDG_38334605\photo-001.jpg`

DPOF `IMAGES\` folder receives only the basename: `photo-001.jpg`

---

## Status Detection Mechanism (o → e → q)

```
Hot folder filesystem event timeline:

1. App writes folder:     o100456_8x12GLOSS/ ← appears in hot folder

2. Controller renames:    o100456_8x12GLOSS/ disappears
                          e100456_8x12GLOSS/ appears

3. fs.watch fires:        eventType='rename', filename='e100456_8x12GLOSS'
   (500ms debounce)

4. FolderMonitor.handleChange('e100456_8x12GLOSS'):
   - Folder exists? Yes → it's a directory
   - currentPrefix = 'e'
   - previousPrefix = not in trackedFolders (it's new)
   → call checkForRenamedFolder('e100456_8x12GLOSS', 'e')

5. checkForRenamedFolder():
   - Extract suffix: '100456_8x12GLOSS'
   - Scan trackedFolders for same suffix, different prefix
   - Found: 'o100456_8x12GLOSS' had prefix 'o' (now deleted)
   → This is a rename! Remove old entry.
   → Call handlePrefixChange('e100456_8x12GLOSS', 'e', callback)

6. handlePrefixChange():
   - Parse: orderNumber='100456', productCode='8x12GLOSS'
   - prefix 'e' → status = 'accepted'
   → callback({ orderNumber: '100456', productCode: '8x12GLOSS',
                status: 'accepted', timestamp: Date })

7. PrintControllerService callback:
   → jobStore.updateJobStatus('100456', 'accepted')
   → Sets dpofStatus='accepted', dpofAcceptedAt=now
```

### Regex used for folder parsing

```js
// In checkForRenamedFolder — matches any valid prefix folder
/^[oeq](.+)$/

// In handlePrefixChange — extracts numeric order number and product code
/^[oeq](\d+)_(.+)$/
```

**Important limitation**: The order number must consist entirely of digits (`\d+`). Alphanumeric order numbers (e.g., `PXDEMO-K9MYDG`) will not be parsed and status changes will be silently ignored.

---

## Integration Points with OrderHub

### 1. Config → PrintService (process routing)

```
configService.getProcessMapping(job.process)
  → { controllerId: 'uuid' }  or  { folderPath: 'C:\...' }
```

Process type comes from the OrderHub API job's `process` field (e.g., `"Print"`, `"Cut"`).

### 2. Manifest → PrintService (job details)

The order manifest (`{orderNumber}.json`) bridges between the OrderHub download and DPOF generation:

- Provides image filenames and sizes (used for channel matching and DPOF line items)
- Provides job identity (matched by `jobId` to the API job's `id`)

### 3. OrderHub API → PrintService (job mark as in_production)

After writing the hot folder, `PrintService` calls:
```js
jobService.markInProduction(jobId)
```

This updates the OrderHub API so the order moves to `in_production` status. If the API call fails, the job is updated locally with `_status: 'in_production'` as a fallback.

### 4. FolderMonitor → JobStore (status feedback)

When the controller accepts or rejects a job, `FolderMonitor` detects the folder rename and calls:
```js
jobStore.updateJobStatus(orderNumber, 'accepted' | 'failed')
```

This is currently local-only — it does not push the status back to the OrderHub API.
