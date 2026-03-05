# Print Controller Integration

This document describes how OrderHub Downloader routes print jobs to physical print controllers via the DPOF (Digital Print Order Format) protocol.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OrderHub Downloader                          │
│                                                                     │
│  ┌──────────────┐    IPC     ┌─────────────────────────────────┐   │
│  │   Renderer   │◄──────────►│         Main Process            │   │
│  │   (UI/HTML)  │            │                                 │   │
│  └──────────────┘            │  ┌──────────────────────────┐   │   │
│                              │  │      PrintService        │   │   │
│                              │  │  (routing: DPOF / copy)  │   │   │
│                              │  └────────┬─────────────────┘   │   │
│                              │           │                      │   │
│                              │    ┌──────┴──────┐              │   │
│                              │    ▼             ▼              │   │
│                              │  DPOF          File             │   │
│                              │  Pipeline      Copy             │   │
│                              │    │                            │   │
│                              │  ┌─┴────────────────────────┐  │   │
│                              │  │     DPOFGenerator        │  │   │
│                              │  │  (generates DPOF.001)    │  │   │
│                              │  └─┬────────────────────────┘  │   │
│                              │    │                            │   │
│                              │  ┌─┴────────────────────────┐  │   │
│                              │  │   OrderFolderWriter      │  │   │
│                              │  │  (writes hot folder)     │  │   │
│                              │  └─┬────────────────────────┘  │   │
│                              │    │                            │   │
│                              └────┼────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────┐
                    │         Hot Folder               │
                    │  o{orderNumber}_{productCode}/   │
                    │  ├── DPOF.001                    │
                    │  └── IMAGES/                     │
                    │      └── image.jpg               │
                    └───────────────┬──────────────────┘
                                    │  (folder rename)
                    ┌───────────────▼──────────────────┐
                    │      Print Controller            │
                    │    (Noritsu / Epson)             │
                    │  Renames: o... → e... (accept)   │
                    │           o... → q... (fail)     │
                    └───────────────┬──────────────────┘
                                    │ (fs.watch detects rename)
                    ┌───────────────▼──────────────────┐
                    │        FolderMonitor             │
                    │  Updates JobStore status         │
                    └──────────────────────────────────┘
```

---

## Key Concepts

### Controllers

A **print controller** is a physical printing device (or software gateway) that accepts print jobs via a hot folder. Each controller has:

- A **type** (`noritsu` or `epson`)
- A **hot folder path** — the directory the controller watches for new jobs
- **Vendor metadata** — vendor name and attribute used in DPOF headers
- An **autoCorrect** flag — whether to enable auto colour correction

Controllers are stored persistently in `print-controllers.json` (electron-store).

### Channels

A **channel** is a configured paper size/type combination on a controller. Each channel has:

- A **channel number** — the physical channel on the device (e.g., `145`)
- A **size** string — e.g., `4x6`, `8x12`
- A **finish** — e.g., `Gloss`, `Matt`
- A **print style code** — e.g., `B` (Noritsu standard)

Channels are used to route a job to the correct paper stock. When a job arrives, its image size is matched against active channels.

### Jobs (DPOF context)

A **job** in this context is a print submission created from an OrderHub API job. It contains:

- Customer name and order number
- A list of **line items** (image filename, quantity, dimensions)
- A list of **image files** (source path + destination filename)
- DPOF submission status (`pending` → `submitted` → `accepted` / `failed`)

### DPOF

**DPOF** (Digital Print Order Format) is the standard file format print controllers use to receive job instructions. It defines:

- A `[HDR]` section with order metadata and controller settings
- One `[JOB]` section per image/line item

The file is named `DPOF.001` and placed in the order folder.

See [DPOF-FORMAT.md](DPOF-FORMAT.md) for the complete format specification.

### Hot Folders

A **hot folder** is a filesystem directory monitored by the print controller software. When OrderHub Downloader writes an order folder into the hot folder, the controller picks it up automatically.

**Folder naming convention:**

| Prefix | Meaning                                      |
|--------|----------------------------------------------|
| `o`    | Order submitted (written by this app)        |
| `e`    | Accepted / picked up by the controller       |
| `q`    | Failed / rejected by the controller          |

Example: `o100456_8x12GLOSS` → `e100456_8x12GLOSS` (accepted)

---

## How the Integration Works End-to-End

1. **Configuration**: A controller and its channels are configured in Settings → Print Controllers.

2. **Process mapping**: In Settings → Downloads, a process type (e.g., `Print`) is mapped to either a folder path or a controller ID.

3. **Job arrives**: When a job is downloaded from OrderHub and the user clicks "Send to Print", `PrintService.sendToPrint()` is called.

4. **Routing decision**: If the process mapping has a `controllerId`, the DPOF pipeline is used. Otherwise, the file-copy pipeline is used.

5. **DPOF pipeline**:
   - Reads the order manifest (`{orderNumber}.json`) from the download directory
   - Matches the job to a channel using image size (and optionally finish)
   - Generates a DPOF file via `DPOFGenerator`
   - Writes the order folder structure to the hot folder via `OrderFolderWriter`
   - Marks the job as `in_production` via the OrderHub API

6. **Status monitoring**: `FolderMonitor` watches the hot folder using `fs.watch`. When the controller renames the order folder (e.g., `o...` → `e...`), the job status is updated in `JobStore`.

---

## Quick Start

1. Open the app and go to **Settings → Print Controllers**
2. Click **Add Controller** and fill in the controller details
3. Add at least one **channel** with the paper size and channel number
4. Go to **Settings → Downloads → Process Folder Mappings**
5. For the relevant process type (e.g., `Print`), set the **Controller** instead of a folder path
6. Download a job and click **Send to Print** — the folder will appear in your hot folder

For detailed setup instructions, see [SETUP.md](SETUP.md).

---

## Related Documents

| Document | Description |
|----------|-------------|
| [SETUP.md](SETUP.md) | How to configure controllers, channels, and process mappings |
| [DPOF-FORMAT.md](DPOF-FORMAT.md) | DPOF file format specification with annotated examples |
| [WORKFLOW.md](WORKFLOW.md) | Process flow diagrams and job lifecycle |
| [API.md](API.md) | Developer reference for all services |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and how to diagnose them |
