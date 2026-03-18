# OHD Implementation Brief: Unified DPOF Generator & Controller UI

**Project:** OrderHub Downloader (OHD)  
**Prepared for:** Claude Code  
**Date:** 2026-03-08  
**Priority:** High

---

## Overview

This brief covers two related changes:

1. **UI Label Change** — Rename the controller type `DPOF` to `Epson / Noritsu` in the Add Controller dialog
2. **DPOF Generator Overhaul** — Replace any existing DPOF file generation with a single unified, definitive format that works for both Epson Order Controller and Noritsu EZ Controller

---

## Background & Research

DPOF (Digital Print Order Format) is the protocol used by both Noritsu EZ Controller and Epson Order Controller to receive print jobs via a shared folder (hot folder). Both controllers speak the same DPOF dialect — specifically, **Noritsu's VUQ extension format** — meaning a single file format works for both. This has been confirmed against three known-good production samples including output from PhotoFinale, a major commercial lab platform.

---

## Change 1: UI Label — Controller Type Dropdown

### Location
Find the component that renders the "Add Controller" dialog. It contains a `Type` dropdown that currently lists `DPOF` as an option.

### Change Required
Update the **display label only**. Do not change the stored value — existing database records use `'DPOF'` and all generator logic keys off this value.

**Find:**
```tsx
// Could be in a CONTROLLER_TYPES constant, select options, or similar
{ value: 'DPOF', label: 'DPOF' }
// or
<option value="DPOF">DPOF</option>
```

**Replace display label with:**
```tsx
{ value: 'DPOF', label: 'Epson / Noritsu' }
// or
<option value="DPOF">Epson / Noritsu</option>
```

### Also Check
The controller **list/table view** may render the stored `type` value directly. If so, add a display formatter:

```tsx
const getControllerTypeLabel = (type: string): string => {
  switch (type) {
    case 'DPOF': return 'Epson / Noritsu'
    default: return type
  }
}
```

Apply this formatter wherever the controller type is displayed in the UI.

---

## Change 2: Unified DPOF Generator

### File to Modify
Locate the existing `DPOFGenerator` service/module. It will be somewhere like:
- `src/services/DPOFGenerator.ts`
- `src/utils/dpof.ts`  
- `src/lib/dpof/generator.ts`

Replace its core generation logic with the implementation described below.

---

### Definitive DPOF File Format

The following is the canonical format for OHD. It is based on confirmed production samples and works for **both Epson Order Controller and Noritsu EZ Controller** without modification.

#### Complete Example (2 images, 1 order)

```
[HDR]
GEN REV=01.00
GEN CRT="OHD" 1.00
GEN DTM=2026:03:08:13:44:13
USR NAM="Elizabeth Hammond"
USR CID="002296"
AUTO CORRECT=0
VUQ RGN=BGN
VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"
VUQ VER=01.00
PRT PSL=KG
PRT PCH=001
VUQ RGN=END
[JOB]
PRT PID=001
PRT TYP=STD
PRT QTY=002
IMG FMT=EXIF2 -J
<IMG SRC="../IMAGE/Hammond_002296_1_Q2.jpg">
VUQ RGN=BGN
VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"
VUQ VER=01.00
PRT CVP1=1 -STR "002296, 001"
PRT CVP2=0
VUQ RGN=END
[JOB]
PRT PID=002
PRT TYP=STD
PRT QTY=001
IMG FMT=EXIF2 -J
<IMG SRC="../IMAGE/Hammond_002296_2_Q1.jpg">
VUQ RGN=BGN
VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"
VUQ VER=01.00
PRT CVP1=1 -STR "002296, 002"
PRT CVP2=0
VUQ RGN=END
```

---

### Field Reference

#### Header Fields (`[HDR]`)

| Field | Value | Notes |
|-------|-------|-------|
| `GEN REV` | `01.00` | Always this value. Do not use 01.10 |
| `GEN CRT` | `"OHD" 1.00` | Creator identifier — fixed string |
| `GEN DTM` | `YYYY:MM:DD:HH:MM:SS` | Order creation timestamp |
| `USR NAM` | `"Customer Full Name"` | Single quoted string — do not split first/last |
| `USR CID` | `"OrderNumber"` | The OrderHub order number, quoted |
| `AUTO CORRECT` | `0` | Always 0 — images are pre-processed, no printer correction |

#### VUQ Vendor Block (Header — appears in BOTH `[HDR]` and each `[JOB]`)

```
VUQ RGN=BGN
VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"
VUQ VER=01.00
PRT PSL={sizeCode}
PRT PCH={channelNumber}
VUQ RGN=END
```

| Field | Value | Notes |
|-------|-------|-------|
| `VUQ RGN=BGN` | Fixed | Opens vendor block |
| `VUQ VNM` | `"NORITSU KOKI" -ATR "QSSPrint"` | Fixed — do not change |
| `VUQ VER` | `01.00` | Fixed |
| `PRT PSL` | See Size Codes table | Paper size code for this channel |
| `PRT PCH` | Integer e.g. `001` | Print channel number from channel mapping |
| `VUQ RGN=END` | Fixed | Closes vendor block |

#### Paper Size Codes (`PRT PSL`)

| Code | Size | Notes |
|------|------|-------|
| `KG` | 6×4 / 4×6 | Most common — standard 6x4 print |
| `4R` | 4×6 | Alternative code for 6×4, same result |
| `L` | 3.5×5 | |
| `2L` | 5×7 | |
| `A4` | A4 | |
| `W` | 4×6 Wide | |
| `NML -PSIZE "WxH"` | Custom | Use for panoramic/non-standard sizes e.g. `NML -PSIZE "8x4"` |

The size code comes from the **channel mapping configuration** in OHD. Each channel record should store its `printSizeCode`. If no code is configured, fall back to `NML -PSIZE "WxH"` derived from the product dimensions.

#### Job Fields (each `[JOB]` block)

| Field | Value | Notes |
|-------|-------|-------|
| `PRT PID` | `001`, `002`, ... | Zero-padded to 3 digits, sequential per file |
| `PRT TYP` | `STD` | Always STD (standard print) |
| `PRT QTY` | `001`, `002`, ... | Zero-padded to 3 digits, number of copies |
| `IMG FMT` | `EXIF2 -J` | Always this value for JPEG images |
| `<IMG SRC>` | `"../IMAGE/{filename}"` | Relative path — note `IMAGE` singular, not `IMAGES` |

#### VUQ Vendor Block (Job — appears in each `[JOB]`)

```
VUQ RGN=BGN
VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"
VUQ VER=01.00
PRT CVP1=1 -STR "{backprintLine1}"
PRT CVP2=0
VUQ RGN=END
```

| Field | Value | Notes |
|-------|-------|-------|
| `PRT CVP1` | `1 -STR "text"` | Backprint line 1. Format: `{order}, {pid}` e.g. `"002296, 001"` |
| `PRT CVP2` | `0` | `0` = suppress (do not print). Use `1 -STR "text"` to print |

---

### Formatting Rules

These rules are absolute — deviation causes controller parse errors:

1. **No spaces around `=`** — `PRT PCH=001` not `PRT PCH = 001`
2. **No spaces in `<IMG SRC>` tag** — `<IMG SRC="../IMAGE/file.jpg">` not `<IMG SRC = ...>`
3. **`[HDR]` and `[JOB]` tags on their own line**, followed immediately by fields on the next line
4. **Line endings: `\r\n` (CRLF)** — Noritsu EZ Controller on Windows requires CRLF. Do not use LF only
5. **File encoding: ASCII** — Do not use UTF-8 BOM or extended characters
6. **`PRT PID` and `PRT QTY`** — always zero-padded to 3 digits (`001` not `1`)
7. **Image folder name is `IMAGE`** (singular) — not `IMAGES`
8. **One AUTPRINT.MRK per order folder** — never combine multiple orders into one file

---

### Folder Structure

Each order must produce the following folder structure in the controller's output path:

```
{OutputPath}/
  {OrderFolderName}/
    IMAGE/
      {image1.jpg}
      {image2.jpg}
      ...
    MISC/
      AUTPRINT.MRK
```

**Order folder naming convention:**
```
o{OrderNumber}
```
Example: `o002296`

The `IMAGE` folder contains all JPEG files for the order. The `MISC` folder contains only `AUTPRINT.MRK`. Image filenames should follow the existing OHD convention.

---

### TypeScript Interface

```typescript
interface DPOFJobImage {
  filename: string        // Just the filename, no path
  quantity: number        // Number of copies
}

interface DPOFOrderParams {
  orderNumber: string     // e.g. "002296"
  customerName: string    // e.g. "Elizabeth Hammond"
  channelNumber: number   // e.g. 1
  printSizeCode: string   // e.g. "KG", "2L", "NML -PSIZE \"8x4\""
  images: DPOFJobImage[]
  timestamp?: Date        // Defaults to now
}
```

### TypeScript Implementation

```typescript
function generateAutoprintMrk(params: DPOFOrderParams): string {
  const {
    orderNumber,
    customerName,
    channelNumber,
    printSizeCode,
    images,
    timestamp = new Date()
  } = params

  const pad3 = (n: number) => String(n).padStart(3, '0')
  const formatChannel = (n: number) => pad3(n)
  const dt = formatDpofDate(timestamp) // YYYY:MM:DD:HH:MM:SS

  const lines: string[] = []

  // --- HEADER ---
  lines.push('[HDR]')
  lines.push('GEN REV=01.00')
  lines.push('GEN CRT="OHD" 1.00')
  lines.push(`GEN DTM=${dt}`)
  lines.push(`USR NAM="${customerName}"`)
  lines.push(`USR CID="${orderNumber}"`)
  lines.push('AUTO CORRECT=0')
  lines.push('VUQ RGN=BGN')
  lines.push('VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"')
  lines.push('VUQ VER=01.00')
  lines.push(`PRT PSL=${printSizeCode}`)
  lines.push(`PRT PCH=${formatChannel(channelNumber)}`)
  lines.push('VUQ RGN=END')

  // --- JOBS ---
  images.forEach((image, index) => {
    const pid = pad3(index + 1)
    lines.push('[JOB]')
    lines.push(`PRT PID=${pid}`)
    lines.push('PRT TYP=STD')
    lines.push(`PRT QTY=${pad3(image.quantity)}`)
    lines.push('IMG FMT=EXIF2 -J')
    lines.push(`<IMG SRC="../IMAGE/${image.filename}">`)
    lines.push('VUQ RGN=BGN')
    lines.push('VUQ VNM="NORITSU KOKI" -ATR "QSSPrint"')
    lines.push('VUQ VER=01.00')
    lines.push(`PRT CVP1=1 -STR "${orderNumber}, ${pid}"`)
    lines.push('PRT CVP2=0')
    lines.push('VUQ RGN=END')
  })

  // Join with CRLF — required for Windows-based controllers
  return lines.join('\r\n') + '\r\n'
}

function formatDpofDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':')
}
```

---

### File Write Location

The `AUTPRINT.MRK` file must be written to:
```
{controller.outputPath}/{orderFolderName}/MISC/AUTPRINT.MRK
```

Both the `IMAGE/` and `MISC/` directories must be created if they do not exist before writing files.

---

### Channel Mapping Integration

The `printSizeCode` for each job comes from the channel mapping system. When OHD resolves a job to a channel, it should:

1. Look up the channel record by the product's mapped channel ID
2. Read the `printSizeCode` field from the channel record
3. If `printSizeCode` is empty/null, construct `NML -PSIZE "{width}x{height}"` from the product dimensions

This means the channel mapping UI/database should include a `printSizeCode` field (string, optional) alongside the existing channel number field.

---

## Testing Checklist

After implementation, verify the following:

- [ ] "Add Controller" dialog shows `Epson / Noritsu` in the Type dropdown
- [ ] Existing controllers with `type='DPOF'` still display correctly as `Epson / Noritsu`
- [ ] Generated `AUTPRINT.MRK` uses CRLF line endings (verify with hex editor or `xxd`)
- [ ] Generated file has no spaces around `=` signs
- [ ] `[HDR]` and `[JOB]` tags are on their own lines
- [ ] `PRT PID` and `PRT QTY` are zero-padded to 3 digits
- [ ] `IMG SRC` paths use `../IMAGE/` (singular) not `../IMAGES/`
- [ ] Order folder is created as `o{orderNumber}` with `IMAGE/` and `MISC/` subdirectories
- [ ] Multi-image orders produce one `[JOB]` block per image with sequential `PRT PID`
- [ ] `PRT CVP1` contains `"{orderNumber}, {pid}"` for each job
- [ ] File is ASCII encoded with no BOM

---

## What NOT to Change

- The stored `type` value in the database — keep `'DPOF'` as the enum/string value
- The controller output path logic — this already works correctly
- The job status tracking / folder monitoring system — DPOF generation is separate
- Channel number mapping — this spec only adds `printSizeCode` to the channel record, it does not restructure the mapping system
