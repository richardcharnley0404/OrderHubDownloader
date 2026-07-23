# OHD — Make print size mandatory (product-code driven), retire manifest `img.size`

**Status:** Investigation + implementation plan (for Claude CLI)
**Date:** 2026-07-23
**Author context:** Richard — S3-delivered PXDEMO job (Noritsu route) blocked with
"Cannot print — size is missing on one or more images."

---

## 1. The decision

Print size should be **dictated by the channel-mapping the lab configures for a product
code**, not by an upstream `size` field from OrderHub (which S3 jobs — and most
upstream sources — do not provide). Therefore:

1. **Retire the manifest `img.size` gate** — it is the only thing that reads upstream
   size, and it is *vestigial* (see §2).
2. **Make the mapping's print size mandatory** for the one controller type where it is
   currently optional (Noritsu / DPOF).
3. **Gate blank/historical mappings** with a clear message at both *save* time and
   *dispatch* time.

The good news from the investigation: **Darkroom Pro and Fuji JobMaker already work
exactly this way.** This change makes Noritsu/DPOF consistent with them. It is a
smaller change than it first looks.

---

## 2. Why the current error happens (the vestigial gate)

For a Noritsu/DPOF job, the size actually emitted to the printer comes from the
**mapping**, not the manifest:

- `src/main/services/print-service.js:315` —
  `printSizeCode: route.printSizeCode` (this is what the DPOF file receives)
- `route.printSizeCode` is produced by `resolvePrintSizeCode(channelMapping)` in
  `src/main/services/routing-service.js:411` / `:532`.

But a few lines earlier the same method rejects the job based on the **manifest**:

- `src/main/services/print-service.js:247-249`
  ```js
  if (Array.isArray(jobManifest.images) && jobManifest.images.some(img => !img.size)) {
    throw new Error('Cannot print — size is missing on one or more images. Check product configuration in Pixfizz Core.');
  }
  ```

`img.size` is **read here and nowhere else** in the DPOF output path. The DPOF file is
built entirely from `route.printSizeCode`. So the gate blocks jobs on a field it never
uses — and S3-delivered jobs set `img.size: null` **by design**
(`src/main/services/s3-artwork-downloader.js:372`, with a header comment predicting this
exact failure). That is the whole bug.

### Cross-controller size resolution (current state)

| Controller        | Size source                                                   | Mandatory today?              | Reads `img.size`? |
|-------------------|---------------------------------------------------------------|-------------------------------|-------------------|
| **Darkroom Pro**  | `controller.sizeTranslations` (product code → size string)    | ✅ yes (resolve→`''`→throw)   | ❌ no             |
| **Fuji JobMaker** | mapping `printCode` (+ `surface`)                             | ✅ yes (save + dispatch gate) | ❌ no             |
| **Frontline**     | mapping `batchCode` / `sortString`                            | ✅ batchCode required at save | ❌ no             |
| **Noritsu/DPOF**  | mapping `printSizeCode` → silent fallback to `size` or `'KG'` | ❌ **optional**               | ⚠️ **only the vestigial gate** |
| folder_copy / pdf_copy | n/a — no size                                            | n/a                           | ❌ no             |

**Conclusion:** only Noritsu/DPOF needs behaviour change. Everything else already
derives size from the product-code mapping and already gates with a helpful message.
The patterns to mirror:

- **Darkroom:** `resolveSize()` returns `''` when no translation
  (`src/main/services/darkroom-pro-output.js:97`), and the dispatch pre-flight throws a
  helpful error (`darkroom-pro-output.js:~196`, "No size translation found for product
  code …").
- **Fuji:** dispatch gate at `print-service.js:1845` →
  *"Fuji JobMaker route is missing surface or printCode for product "X". Add a channel
  mapping for this product in Settings → Routing."*
  and save-time validation at `ipc-handlers.js:1190` (`validateProductMappingConfig`).

---

## 3. Changes to make

### 3.1 Remove the vestigial manifest gate  *(unblocks Richard immediately)*
**File:** `src/main/services/print-service.js:247-249`
Delete the `img.size` check. Replace with a **mapping-based** pre-flight gate on the
resolved route, mirroring Fuji/Darkroom:

```js
// Print size is dictated by the product-code channel mapping, not the upstream
// manifest. Gate on the resolved route so a mis-/un-configured mapping fails
// with a clear, actionable message instead of a wrong-size print.
if (!route.printSizeCode || String(route.printSizeCode).trim() === '') {
  throw new Error(
    `No print size configured for product "${job.product_code || '(none)'}". ` +
    `Set the Print Size Code on this product's channel mapping in Settings → Routing.`
  );
}
```
(Exact `route.printSizeCode` value depends on §3.2 — see note about the `'KG'`
fallback.)

### 3.2 Make `printSizeCode` genuinely mandatory (remove the silent `'KG'` fallback)
**File:** `src/main/services/routing-service.js:59-70` (`resolvePrintSizeCode`)
Today a blank field silently resolves to `mapping.size` (legacy) or `'KG'`. That silent
default is what lets a mis-configured mapping print at the wrong size. Change so that:

- blank `printSizeCode` **and** blank legacy `size` → return `''`/`null` (so the §3.1
  gate fires with a clear message), **not** `'KG'`.
- keep the legacy `mapping.size` backfill (see §3.4 migration) so existing Noritsu
  mappings that relied on `size` keep working.

⚠️ **Back-compat:** some historical Noritsu mappings carry a legacy `size` but blank
`printSizeCode`. Do **not** break those. Handle via the migration in §3.4 (backfill
`printSizeCode` from `size`) so that after migration `printSizeCode` is the single
source of truth and the `'KG'` default can be dropped safely.

### 3.3 Enforce at save time (server-side IPC + modal)
**Server (authoritative, also covers CSV import):**
`src/main/ipc-handlers.js:1169` handler `ohd:routing:save-channel-mapping`. Extend the
existing validation block (currently Fuji-only at `:1180-1206`) so that for a
**DPOF/Noritsu** controller a blank `printSizeCode` is rejected:
```js
if (parentCtrl && parentCtrl.type !== 'darkroompro'
    && parentCtrl.type !== 'fujijobmaker'
    && parentCtrl.type !== 'frontline'
    && parentCtrl.type !== 'folder_copy' && parentCtrl.type !== 'pdf_copy') {
  const sz = (mapping.printSizeCode || mapping.size || '').trim();
  if (!sz) {
    return { success: false, error:
      'Print Size Code is required. It sets the print size for this product code.' };
  }
}
```
This covers both the modal **and** the CSV-import path (`renderer.js:5953` →
`saveChannelMapping` IPC), so no blank mapping can be created from any entry point.

**Renderer modal (fast feedback):**
`src/renderer/renderer.js:5700-5702` — in the DPOF/Noritsu branch (the
`else if (!isDarkroomProCtrl)` arm) add:
```js
if (!printSizeCode) { alert('Print Size Code is required — it sets the print size for this product code.'); return; }
```

**Label / help text:**
`src/renderer/index.html:1380-1382` — drop the `(optional)` tag on `cmPrintSizeCode`,
and remove the "Leave blank to use the product size as NML fallback" sentence (that
fallback is being retired). New helper text e.g.:
*"Sets the print size for this product code. Common codes: KG (6×4), 2L (5×7), A4. Or
enter a size like 4x6 and OHD formats it for the printer."*

### 3.4 Gate historical blanks (migration + proactive warning)
Existing installs already have saved mappings with blank `printSizeCode`. Three-part
handling:

1. **One-time backfill migration** (on settings load / app start): for every channel
   mapping whose controller is Noritsu/DPOF and `printSizeCode` is blank but legacy
   `size` is present → set `printSizeCode = size`. This preserves currently-working
   mappings and lets §3.2 drop the `'KG'` default cleanly.
2. **Dispatch-time gate:** already handled by §3.1 — any still-blank mapping fails with
   the actionable message instead of silently printing at `'KG'`.
3. **Proactive UI warning (recommended):** in the routing list
   (`renderer.js:5464` `renderChannelMappings`) badge any DPOF mapping with a blank
   size (e.g. an amber "⚠ No print size" chip next to the row, mirroring the existing
   `printSizeCode` span at `:5527`) so the lab can fix them before a job hits them.

### 3.5 Free consistency win — Job Review "No size translation"
`getAllSizeOptions()` (`routing-service.js:649`) and `resolveTargetSize()`
(`src/main/jobs/batchCropActions.js:676`) build the Job Review crop target from the same
mapping `printSizeCode`. Once §3.2–3.4 guarantee it is always populated, the
"No size translation" state in Job Review disappears for correctly-configured products
too — same root cause, fixed once.

### 3.6 Leave S3 manifest as-is
`src/main/services/s3-artwork-downloader.js:372` can keep writing `size: null`. Nothing
reads it after §3.1, and keeping the field preserves the byte-shape parity test. No
change needed (optionally update the header comment to note the gate moved to the
mapping).

### 3.7 Add mandatory Print Size Code to the per-job Assign Channel modal
**Files:** `src/renderer/index.html`, `src/renderer/renderer.js`

The per-job Assign modal (job row → Assign) is the primary way operators map a **new**
product. Its DPOF branch (`renderer.js` `openAssignModal`, save handler at ~line 1710)
currently builds the `saveChannelMapping` payload with only
`{controllerId, productCode, options, channelNumber, skipAutoPrint}` — no
`printSizeCode` — so every mapping created from Assign is size-less and shows
"No size translation" in Job Review. Once §3.3 lands, the IPC also rejects a blank
size, so this Assign flow breaks entirely with no field to fix it. Darkroom already
collects a size (`dpSizeInput`) and Fuji collects `printCode`; only the DPOF/Noritsu
branch is missing it.

Mirror `#cmPrintSizeCode`:

1. **`index.html`** — inside `#assignDpofGroup` (next to `assignChannelNumber`, ~line
   1518), add a required `#assignPrintSizeCode` input with the same placeholder as
   `cmPrintSizeCode` (`e.g. KG, 2L, NML -PSIZE "8x4"`) and helper text
   *"Sets the print size for this product code. Common codes: KG (6×4), 2L (5×7), A4.
   Or enter a size like 4x6 and OHD formats it for the printer."*. No `(optional)`
   tag and no NML-fallback sentence — §3.3 retired that fallback.
2. **`renderer.js` `openAssignModal`** (~line 1475, DPOF reset block where
   `assignChannelNumber.value` is cleared) — also clear `assignPrintSizeCode.value = ''`.
   Fuji/Darkroom branches untouched (`assignDpofGroup` is already hidden for them at
   line 1384).
3. **`renderer.js` save handler, DPOF branch** (lines 1686-1717) — read
   `assignPrintSizeCode.value.trim()`, validate non-blank with the same
   `setCustomValidity`/`reportValidity` pattern as the `channelNumber` check
   (*"Print Size Code is required — it sets the print size for this product code."*),
   and include `printSizeCode` in the `saveChannelMapping` payload.

The client-side message matches the §3.3 server-side validator, so a valid assign must
now pass both. This is DOM code with no unit-test harness in the repo (same as §3.4.3);
IPC-level coverage of the mandatory-size rule is already provided by the §3.3 tests —
this step is presentation plus manual verification: saving with a size creates a mapping
whose Job Review target resolves (no "No size translation"), and saving with a blank
size is blocked client-side before the IPC call.

---

## 4. Tests to update / add
- `src/main/services/__tests__/resolvePrintSizeCode.test.js` — blank now yields
  `''`/`null` (not `'KG'`); add legacy-`size` backfill cases.
- `src/main/services/__tests__/ipc-handlers-auto-print.test.js:268-276` — asserts the
  old "size is missing" message; update to the new mapping-based message.
- `batchCrop.test.js` — resolveTargetSize cases; verify still green with mandatory size.
- `s3-artwork-downloader.test.js` — byte-shape parity (`size: null`) unaffected; add a
  test that an S3 job now dispatches to a Noritsu mapping that has a `printSizeCode`.
- New: save-channel-mapping IPC rejects a blank-size DPOF mapping.

---

## 5. Suggested commit order (small, reviewable steps)
1. **Unblock:** §3.1 remove manifest gate + add route-based gate. (Richard's job prints.)
2. **Migration:** §3.4.1 backfill `printSizeCode` from legacy `size`.
3. **Mandatory:** §3.2 drop `'KG'` fallback + §3.3 save-time validation (IPC + modal +
   label).
4. **Proactive:** §3.4.3 routing-list warning badge.
5. **Assign modal:** §3.7 add `assignPrintSizeCode` field + client-side validation +
   include `printSizeCode` in the `saveChannelMapping` payload, so the primary
   product-mapping entry point creates sized DPOF mappings and passes the §3.3 gate.
6. Tests (§4) alongside each step.

---

## Appendix — key references
- `print-service.js:247` vestigial `img.size` gate (remove) · `:315` real size source
- `routing-service.js:59` `resolvePrintSizeCode` (`'KG'` fallback to remove) · `:411`/`:532` route build
- `darkroom-pro-output.js:97` `resolveSize`→`''` + `:196` dispatch throw (pattern)
- `print-service.js:1845` Fuji dispatch gate (pattern)
- `ipc-handlers.js:1169` save-channel-mapping IPC · `:1190` Fuji validator (pattern)
- `renderer.js:5675` modal save validation · `:5765` payload · `:5464`/`:5527` list render · `:5953` CSV import
- `index.html:1379-1382` `cmPrintSizeCode` label + help text
- `batchCropActions.js:676` `resolveTargetSize` · `routing-service.js:649` `getAllSizeOptions`
- `s3-artwork-downloader.js:372` `size: null` (leave as-is)
