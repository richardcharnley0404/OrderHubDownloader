# OHD PDF Transform Pipeline — Claude Code Implementation Brief

## Overview

Implement a configurable PDF post-processing pipeline in OrderHub Downloader (OHD). Each order controller can have a sequence of PDF transform steps that are applied in order to the incoming PDF before it is sent to the print controller hot folder. Steps are applied sequentially, with each step operating on the output of the previous step. Page number references in each step are **relative to the document as it exits the previous step**.

---

## Tech Stack Context

- OHD is an Electron/TypeScript Windows desktop app
- PDF manipulation should use `pdf-lib` — **check first whether it is already in package.json**. If not, add it: `npm install pdf-lib`
- QR code generation: add `npm install qrcode` and `@types/qrcode`
- All pipeline config is stored in OHD local config (same layer as existing channel/product routing config)
- Pipeline config is per order controller — same pipeline applies to all jobs processed by that controller

---

## Type Definitions

Create a new file: `src/pdf-pipeline/types.ts`

```typescript
export type UnitType = 'mm' | 'in';

export interface IdentifierPosition {
  horizontal: 'left' | 'center' | 'right';
  vertical: 'top' | 'middle' | 'bottom';
  offsetX?: number; // mm or inches from edge — only used when horizontal is 'left' or 'right'
  offsetY?: number; // mm or inches from edge — only used when vertical is 'top' or 'bottom'
  unit: UnitType;
}

export interface IdentifierSize {
  width: number;  // in unit specified on position
  height: number;
}

export type IdentifierContentItem =
  | { type: 'qrCode'; data: 'jobNumber' }
  | { type: 'text'; template: string }; // supports {{jobNumber}}, {{qty}}, {{customerName}}, {{orderId}}

export type PdfTransformStep =
  | {
      type: 'interleaveBlanks';
      every: number; // insert this many blank pages after every original page
    }
  | {
      type: 'insertBlanks';
      count: number;        // number of blank pages to insert
      beforePage: number;   // 1-indexed. Use 1 to prepend. Page refs are post-previous-step.
    }
  | {
      type: 'insertPages';
      assetPath: string;    // absolute path to a static PDF asset file
      beforePage: number;   // 1-indexed. Use 1 to prepend.
    }
  | {
      type: 'addOrderIdentifier';
      page: number | 'all'; // 1-indexed, post-previous-step
      position: IdentifierPosition;
      size: IdentifierSize;
      content: IdentifierContentItem[];
    }
  | {
      type: 'addBannerSheet'; // already implemented — included for pipeline completeness
    };

export interface PdfPipelineConfig {
  steps: PdfTransformStep[];
}

export interface JobContext {
  jobNumber: string;
  orderId: string;
  qty: number;
  customerName: string;
}
```

---

## Unit Conversion Utility

Create: `src/pdf-pipeline/units.ts`

```typescript
// pdf-lib works in points (1 point = 1/72 inch)
export const MM_TO_PT = 72 / 25.4;
export const IN_TO_PT = 72;

export function toPoints(value: number, unit: 'mm' | 'in'): number {
  return unit === 'mm' ? value * MM_TO_PT : value * IN_TO_PT;
}
```

---

## Pipeline Runner

Create: `src/pdf-pipeline/pipeline.ts`

```typescript
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { PdfTransformStep, PdfPipelineConfig, JobContext } from './types';
import { toPoints } from './units';

export async function applyPdfPipeline(
  inputBytes: Uint8Array,
  config: PdfPipelineConfig,
  job: JobContext
): Promise<Uint8Array> {
  let current = inputBytes;
  for (const step of config.steps) {
    current = await applyStep(current, step, job);
  }
  return current;
}

async function applyStep(
  pdfBytes: Uint8Array,
  step: PdfTransformStep,
  job: JobContext
): Promise<Uint8Array> {
  switch (step.type) {
    case 'interleaveBlanks':
      return applyInterleaveBlanks(pdfBytes, step.every);
    case 'insertBlanks':
      return applyInsertBlanks(pdfBytes, step.count, step.beforePage);
    case 'insertPages':
      return applyInsertPages(pdfBytes, step.assetPath, step.beforePage);
    case 'addOrderIdentifier':
      return applyOrderIdentifier(pdfBytes, step, job);
    case 'addBannerSheet':
      // already implemented — call existing banner sheet function here
      return pdfBytes;
    default:
      console.warn(`Unknown pipeline step type — skipping`);
      return pdfBytes;
  }
}
```

---

## Step Implementations

Create: `src/pdf-pipeline/steps.ts`

### interleaveBlanks

```typescript
export async function applyInterleaveBlanks(
  pdfBytes: Uint8Array,
  every: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const originalPageCount = doc.getPageCount();

  // Work backwards to avoid index shifting
  for (let i = originalPageCount - 1; i >= 0; i--) {
    const sourcePage = doc.getPage(i);
    const { width, height } = sourcePage.getSize();
    for (let b = 0; b < every; b++) {
      // Insert blank page immediately after page i
      const blank = doc.insertPage(i + 1);
      blank.setSize(width, height);
    }
  }

  return doc.save();
}
```

### insertBlanks

```typescript
export async function applyInsertBlanks(
  pdfBytes: Uint8Array,
  count: number,
  beforePage: number // 1-indexed
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const insertIndex = beforePage - 1; // convert to 0-indexed

  // Use adjacent page size for blank dimensions
  const adjacentPage = doc.getPage(Math.min(insertIndex, doc.getPageCount() - 1));
  const { width, height } = adjacentPage.getSize();

  for (let i = 0; i < count; i++) {
    const blank = doc.insertPage(insertIndex + i);
    blank.setSize(width, height);
  }

  return doc.save();
}
```

### insertPages

```typescript
import * as fs from 'fs';

export async function applyInsertPages(
  pdfBytes: Uint8Array,
  assetPath: string,
  beforePage: number // 1-indexed
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const assetBytes = fs.readFileSync(assetPath);
  const assetDoc = await PDFDocument.load(assetBytes);

  const insertIndex = beforePage - 1; // 0-indexed
  const assetPageCount = assetDoc.getPageCount();

  const copiedPages = await doc.copyPages(assetDoc, [...Array(assetPageCount).keys()]);
  for (let i = 0; i < copiedPages.length; i++) {
    doc.insertPage(insertIndex + i, copiedPages[i]);
  }

  return doc.save();
}
```

### addOrderIdentifier

```typescript
export async function applyOrderIdentifier(
  pdfBytes: Uint8Array,
  step: Extract<PdfTransformStep, { type: 'addOrderIdentifier' }>,
  job: JobContext
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  const targetPages: number[] =
    step.page === 'all'
      ? [...Array(doc.getPageCount()).keys()]
      : [step.page - 1]; // convert to 0-indexed

  for (const pageIndex of targetPages) {
    const page = doc.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const blockWidthPt = toPoints(step.size.width, step.position.unit);
    const blockHeightPt = toPoints(step.size.height, step.position.unit);

    // Resolve X position
    let x: number;
    if (step.position.horizontal === 'center') {
      x = (pageWidth - blockWidthPt) / 2;
    } else if (step.position.horizontal === 'left') {
      const offsetX = toPoints(step.position.offsetX ?? 0, step.position.unit);
      x = offsetX;
    } else { // right
      const offsetX = toPoints(step.position.offsetX ?? 0, step.position.unit);
      x = pageWidth - blockWidthPt - offsetX;
    }

    // Resolve Y position
    // pdf-lib origin is bottom-left, so 'top' means high Y value
    let y: number;
    if (step.position.vertical === 'middle') {
      y = (pageHeight - blockHeightPt) / 2;
    } else if (step.position.vertical === 'bottom') {
      const offsetY = toPoints(step.position.offsetY ?? 0, step.position.unit);
      y = offsetY;
    } else { // top
      const offsetY = toPoints(step.position.offsetY ?? 0, step.position.unit);
      y = pageHeight - blockHeightPt - offsetY;
    }

    // Render content items top-to-bottom within the block
    let cursor = y + blockHeightPt; // start at top of block

    for (const item of step.content) {
      if (item.type === 'qrCode') {
        const qrData = resolveTemplate('{{jobNumber}}', job);
        const qrPngDataUrl = await QRCode.toDataURL(qrData, {
          width: Math.round(blockWidthPt),
          margin: 0,
          color: { dark: '#000000', light: '#ffffff' }
        });
        const qrBase64 = qrPngDataUrl.split(',')[1];
        const qrImageBytes = Buffer.from(qrBase64, 'base64');
        const qrImage = await doc.embedPng(qrImageBytes);

        const qrSize = Math.min(blockWidthPt, blockHeightPt * 0.7);
        cursor -= qrSize;
        page.drawImage(qrImage, { x, y: cursor, width: qrSize, height: qrSize });
        cursor -= 4; // small gap

      } else if (item.type === 'text') {
        const resolved = resolveTemplate(item.template, job);
        const fontSize = 8;
        cursor -= fontSize + 2;
        page.drawText(resolved, {
          x,
          y: cursor,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          maxWidth: blockWidthPt
        });
      }
    }
  }

  return doc.save();
}

function resolveTemplate(template: string, job: JobContext): string {
  return template
    .replace(/{{jobNumber}}/g, job.jobNumber)
    .replace(/{{orderId}}/g, job.orderId)
    .replace(/{{qty}}/g, String(job.qty))
    .replace(/{{customerName}}/g, job.customerName);
}
```

---

## Config Storage

Extend the existing order controller config structure. The pipeline config should be stored under the controller's config key in the same JSON config file OHD already uses.

Example structure within the existing config:

```json
{
  "controllers": {
    "calendar-noritsu": {
      "hotFolder": "C:/PrintControllers/Noritsu/Calendar",
      "pdfPipeline": {
        "steps": [
          {
            "type": "interleaveBlanks",
            "every": 1
          },
          {
            "type": "insertBlanks",
            "count": 2,
            "beforePage": 1
          },
          {
            "type": "addOrderIdentifier",
            "page": 2,
            "position": {
              "horizontal": "center",
              "vertical": "bottom",
              "offsetY": 10,
              "unit": "mm"
            },
            "size": { "width": 40, "height": 40 },
            "content": [
              { "type": "qrCode", "data": "jobNumber" },
              { "type": "text", "template": "Job: {{jobNumber}} | Qty: {{qty}}" }
            ]
          }
        ]
      }
    }
  }
}
```

---

## Integration Point

In the existing job processing flow, after the PDF is downloaded and before it is written to the hot folder, add:

```typescript
import { applyPdfPipeline } from './pdf-pipeline/pipeline';

// existing code fetches pdfBytes and resolves controllerConfig...

const pipelineConfig = controllerConfig.pdfPipeline;
if (pipelineConfig && pipelineConfig.steps.length > 0) {
  const jobContext: JobContext = {
    jobNumber: job.jobNumber,
    orderId: job.orderId,
    qty: job.qty,
    customerName: job.customerName
  };
  pdfBytes = await applyPdfPipeline(pdfBytes, pipelineConfig, jobContext);
}

// write pdfBytes to hot folder as normal
```

---

## UI — Pipeline Builder (Controller Settings)

In the order controller settings panel, add a **PDF Pipeline** section below the existing channel routing config. Implement as a list of step cards with the following behaviour:

- **Add Step** button opens a dropdown with the five step types
- Each step renders as an expandable card showing its type and a summary of its params
- Cards have **Move Up / Move Down** buttons (or drag handle if drag-reorder is already used elsewhere in OHD)
- **Delete** button per card with confirmation
- Each step type has its own form fields:

| Step | Fields |
|---|---|
| `interleaveBlanks` | Every N pages (number input) |
| `insertBlanks` | Count (number), Before page (number) |
| `insertPages` | Asset file path (file picker), Before page (number) |
| `addOrderIdentifier` | Page (number or "all" toggle), Horizontal (select), Vertical (select), Offset X (number), Offset Y (number), Unit (mm/in toggle), Width, Height, Content items (sub-list: add QR Code / add Text) |
| `addBannerSheet` | No fields (already configured separately) |

- Below the step list, show a **read-only page count simulator** — a small text summary showing the running page count after each step based on an input of "original page count". For example: `Input: 13 → after interleaveBlanks: 26 → after insertBlanks: 28`. This helps the user reason about page targeting.

---

## File Structure Summary

```
src/
  pdf-pipeline/
    types.ts          ← all type definitions
    units.ts          ← mm/in to points conversion
    steps.ts          ← individual step implementations
    pipeline.ts       ← pipeline runner (applyPdfPipeline)
```

---

## Notes & Edge Cases

- **Page out of bounds**: If a step references `beforePage` or `page` beyond the current document length, log a warning and skip that step rather than throwing.
- **Blank page dimensions**: Always inherit dimensions from the adjacent page (prefer the page immediately before the insertion point; fall back to page after if inserting at position 0).
- **interleaveBlanks `every` > 1**: Insert `every` blank pages after each original page. So `every: 2` on a 3-page doc = 9 pages total.
- **pdf-lib coordinate system**: Origin is bottom-left. Y increases upward. All Y calculations must account for this — the step implementations above already handle this.
- **QR code sizing**: QR code takes priority within the block; text renders below it. If only text is in the content array, it fills the block from top.
- **Asset file not found**: If `insertPages` asset path does not exist, log an error, skip the step, and continue the pipeline — do not abort the job.
