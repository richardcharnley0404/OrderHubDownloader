# DPI Validation

OrderHub Downloader validates the resolution of artwork images before they are sent to a print controller. This prevents low-quality jobs from printing automatically without review.

---

## How It Works

When the operator clicks **Send to Print**, OHD:

1. Reads each image file in the job (JPEG, PNG, or TIFF — no extra tools required)
2. Measures the pixel dimensions from the file header
3. Divides pixel dimensions by the physical print size from the order manifest (e.g. `4x6` inches)
4. Compares the result against the configured thresholds
5. Decides whether to **auto-submit**, **warn**, or **block** the job

DPI is calculated as:

```
effectiveDPI = min(pixelWidth / printWidthInches, pixelHeight / printHeightInches)
```

The image is automatically re-oriented if the pixel aspect ratio does not match the print orientation (portrait vs landscape).

---

## Status Levels

| Status    | Icon | Condition                                    |
|-----------|------|----------------------------------------------|
| Excellent | ✅   | DPI ≥ Excellent Threshold (default: 300)     |
| Good      | ✅   | DPI ≥ Warning Threshold AND < Excellent      |
| Warning   | ⚠️   | DPI ≥ Poor Threshold AND < Warning Threshold |
| Poor      | ❌   | DPI < Poor Threshold                         |

---

## Configuration

Settings are in **Settings → Downloads → DPI Validation**.

| Setting | Default | Description |
|---|---|---|
| Enable DPI validation | ✅ On | Turn the entire feature on/off |
| Excellent Threshold | 300 DPI | Images at or above this are considered perfect |
| Warning DPI | 275 DPI | Images between Warning and Excellent trigger a caution |
| Warning — Allow auto-submit | ✅ On | Warning-level jobs print without confirmation |
| Poor DPI | 200 DPI | Images between Poor and Warning are flagged as poor quality |
| Poor — Allow auto-submit | ❌ Off | Poor-level jobs require manual approval before printing |

Jobs with DPI **below the Poor threshold** are always blocked from auto-submission.

### Example Configuration

```
Excellent: 300 DPI  ← perfect
Warning:   275 DPI  ← caution but auto-submits
Poor:      200 DPI  ← requires manual approval
< 200 DPI          ← always blocked
```

---

## Auto-Submit Logic

```
if status == 'excellent' or 'good':
    canAutoSubmit = true

if status == 'warning':
    canAutoSubmit = warningThreshold.allowAutoSubmit   (default: true)

if status == 'poor':
    canAutoSubmit = poorThreshold.allowAutoSubmit       (default: false)

if dpi < poorThreshold:
    canAutoSubmit = false                               (always blocked)
```

---

## Job Table Indicators

The Jobs tab shows a DPI icon in each row once a job has been validated:

| Icon | Meaning |
|------|---------|
| ✅ | All images are excellent or good quality |
| ⚠️ | One or more images are in the warning range |
| ❌ | One or more images are poor quality (manual approval required) |
| – | DPI has not been checked yet (not yet sent to print) |

---

## Manual Approval Workflow

When a job **cannot auto-submit** (poor quality, or warning with auto-submit disabled):

1. Operator clicks **Send to Print**
2. OHD checks DPI — finds images below threshold
3. A **DPI Warning Modal** appears showing:
   - Per-image table: filename, pixel dimensions, print size, DPI, status, recommendation
   - Summary message explaining the issue
4. Operator can:
   - **Cancel** — do not send, return to jobs list
   - **Approve & Send** — mark as manually approved and proceed to print controller
5. On approval, OHD records `_dpiApproved: true` in the local job cache and sends the job

---

## Supported Image Formats

DPI is calculated from **pixel dimensions** only — OHD does not read embedded DPI metadata from EXIF/IPTC. Pixel dimensions are read directly from the image file header:

| Format | Read Method |
|--------|------------|
| JPEG | SOF0/SOF1/SOF2 marker scan |
| PNG | IHDR chunk (bytes 16–23) |
| TIFF | IFD tags 256 (Width) + 257 (Height) |

No external libraries or `sharp` are required — pure Node.js Buffer reads.

---

## Print Size Formats

The `size` field in the order manifest drives the DPI calculation. Supported formats:

| Format | Example | Interpreted as |
|--------|---------|---------------|
| `WxH` (inches) | `4x6` | 4 × 6 inches |
| `WxH` (decimal) | `8.5x11` | 8.5 × 11 inches |
| `WxHcm` | `10x15cm` | 10 × 15 cm → 3.94 × 5.91 inches |

---

## Testing

Run the built-in test suite (no Electron required):

```bash
node scripts/test-dpi-validation.js
```

Tests cover:
- Excellent / Good / Warning / Poor thresholds
- Auto-submit flags at each threshold
- Manual approval when `allowAutoSubmit = false`
- PNG format reading
- Landscape/portrait auto-orientation
- Multi-image jobs (worst status wins)
- DPI validation disabled pass-through
- `parsePrintSize` edge cases (cm, decimal, invalid)

---

## Troubleshooting

### "Cannot read image dimensions"
- The image file is missing, empty, or not a supported format (JPEG/PNG/TIFF)
- Confirm the job was fully downloaded before sending to print

### "Cannot parse print size"
- The `size` field in the order manifest is not in `WxH` format
- Check the manifest file: `{downloadDirectory}/{order_number}_{order_id}/{order_number}.json`

### DPI badge not showing in jobs table
- The DPI badge only appears after Send to Print is clicked (validation happens on demand, not at download time)

### Job is blocked even though DPI looks OK
- Check the print size: a large print size (e.g. 16x20) requires far more pixels than a small one (4x6)
- Check orientation: if pixels are 1200×1800 but print is 6×4 (landscape), DPI may be miscalculated — the auto-orient logic handles most cases but check the manifest `size` value
