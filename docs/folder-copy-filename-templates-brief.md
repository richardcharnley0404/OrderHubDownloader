# Folder Copy — filename templates & destination layout (build brief)

**Status:** shipped in v1.15.0 (2026-08-18). Supersedes the decisions
section of `docs/folder-copy-filename-templates-investigation.md` (that
doc stays as the research record — read it first for *why*, read this
for *what to build*).

**Commits (bisectable, one milestone per commit):**

| Commit | Milestone |
|---|---|
| `3100e0b` | M1 + M1a — `template-tokens`: 4-arg `resolveTemplate`, 11 new tokens, `{option:NAME}`, single-pass regex, typed `opts.now`, `{date}` back-print fix |
| `090b72f` | M2 — `folder-copy-filename.js` pure module (`buildCopyFilenames`), including the `_stripSourceExt` fix that replaced `path.extname`-on-template-output |
| `bcc1691` | M2b — Win32 reserved device names guarded on the stem (CON, PRN, AUX, NUL, COM1-9, LPT1-9) |
| `b70f215` | M3 — three per-controller fields, UI, save-time validation |
| `c6e6564` | M3a — distinguishing-token set narrowed to `{orderNumber}`/`{jobName}`/`{jobId}`; template trimmed at store time |
| `932f726` | M4 — wire into `_sendViaFolderCopyRouted` (dispatch), reprint comment + BACKLOG entry |
| `7d9ba28` | M5 — live preview in Settings, runs the real M1+M2 code path |
| `d96d98e` | M5a — extracted `buildDestFolder` (one implementation of §6.2); preview runs planner on FULL image list |
| `827ba5a` | M6 — CHANGELOG Unreleased entry (operator language) + brief amendments + investigation-doc header |
| `7bd48ae` | M6a — preview-claim wording scoped honest; two Landmines added (buildDestFolder is the one implementation; never `path.extname` on template output) |
| `7f46c43` | M8 — option-name discoverability chips in the preview + honest `{options}` machine-value warning |
| `c23b491` | M7 — Strip Order Number Prefix widened from single string to a `string[]` list; PIC Pro single-job path routed through `getOrCreateSubmissionId` for cross-prefix collision safety |
| `01a844a` | M7a — separator required between prefix and code (no more `PXDEMO → X` leading-substring hijack); flipped the mis-titled printUtils test that had codified the bug |
| `0a81610` | M7b — order-number prefix rules now `{from,to}` pairs with optional REPLACEMENT (customer request); helper renamed `stripOrderNumberPrefixMulti` → `applyOrderNumberPrefixRules`; three-shape tolerant reader on the controller record |
| `8f38729` | M7b UI — pair-row Prefix + Replace-with inputs; help text spells out the "match is replaced verbatim including separator" rule |

Read the brief top-to-bottom AND §12 "Amendments during build" below
before assuming any part is still current — several sections were
superseded in flight.

**Goal:** when a named **Folder Copy** controller writes files out, the
receiving operator should be able to tell from the filename alone what needs
doing — product, quantity, finish options — and the paths should be short
enough to read (drop the `PXDEMO-` / `DIVPRINTS-` prefix, and optionally skip
the per-job subfolder entirely).

---

## 0. Decisions (recorded — do not re-litigate during the build)

| # | Question | Decision |
|---|---|---|
| D1 | Product size | **`{product}` only.** No size-translation table, no parsing of `product_code`. Size is embedded in the product display name and that is good enough. |
| D2 | Quantity | **Per-image quantity** from the order manifest. `job.quantity` is NOT exposed as a token — see §3.3. |
| D3 | Collision behaviour | **Auto-suffix** `_2`, `_3`, … — scoped to a single dispatch. See §4.4 for why that scoping matters. |
| D4 | Scope | **Named Folder Copy controllers only.** Default Folder and Process Folder routes keep today's behaviour (original filenames, `{orderNumber}_{jobId}` subfolder) — they share `_sendViaFolderCopyRouted` but pass no template, so this falls out for free. Verify it with a test rather than assuming. |
| D5 | Options token | Keyed by **option name**, resolves to the option **value**: `{option:finish-options}` → `lustre`. Plus `{options}` for all values joined. |
| D6 | Prefix stripping | Reuse the existing **per-controller `stripOrderNumberPrefix`** field and the existing `printUtils.stripOrderNumberPrefix` helper. See §2 — this is the one place the brief deliberately does something slightly different from what was asked, and the reasoning is written out. |
| D7 | Destination layout | Per-controller choice: **job subfolder** (default, today's behaviour) or **root of the copy-to folder**. |
| D8 | Reprints | **Out of scope for v1.** `_sendReprintViaFolderCopy` keeps original filenames. Documented, backlogged — see §8. |

---

## 1. What exists today

`_sendViaFolderCopyRouted` (`src/main/services/print-service.js:2253`) is the
whole of the current naming logic:

```js
const jobFolderName = `${job.order_number}_${job.id}`;
const destFolder    = path.join(route.outputPath, jobFolderName);
fs.mkdirSync(destFolder, { recursive: true });
for (const img of imageFiles) {
  fs.copyFileSync(img.sourcePath, path.join(destFolder, img.filename));
}
```

Everything in this brief lands on those five lines plus the config that feeds
them.

The `{token}` resolver already exists and is shared:
`src/main/services/template-tokens.js`, used by Frontline back-print
(`frontline-generator.js:74`), Darkroom Pro photo lines
(`darkroom-pro-output.js:313`), Fuji JobMaker back-print
(`fuji-jobmaker-generator.js:147`) and Fuji PIC Pro back-print
(`fuji-pic-pro-generator.js:90`). **Extend that resolver — do not write a
second one.**

`printUtils.stripOrderNumberPrefix` already exists
(`src/shared/printUtils.js:235`), built for PIC Pro in 1.13.0: leading match
only, case-insensitive, preserves the surviving casing, **never strips to
empty**.

---

## 2. D6 in full — why the configured prefix, not "everything before the first hyphen"

The ask was *"remove `PXDEMO-` — anything before the `-`"*. Two readings:

**(a) Blunt rule:** strip up to and including the first hyphen.
**(b) Configured prefix:** operator types `PXDEMO-` once per controller; strip
it when it appears at the start.

For Richard's actual data these produce **identical output**
(`PXDEMO-091YEC` → `091YEC`, `PXDEMO-091YEC-1` → `091YEC-1`). They diverge
where (a) is destructive:

- An order number with no vendor prefix but a legitimate hyphen — (a) eats the
  first real segment, silently and unrecoverably, with no way to turn it off
  for that order.
- A different lab's prefix format (no hyphen, or two hyphens) — (a) either does
  nothing or eats too much.
- (a) cannot be switched off per controller; every Folder Copy destination gets
  it whether the operator wants it or not.

(b) also costs nothing to build: the field, the helper, and its tests already
exist and ship in 1.14.0. So **build (b)**.

> If you'd rather have the blunt rule, it's a small change to the helper plus
> its tests — but say so before M1 rather than after, because the field label
> and the save-time validation differ.

**Field reuse note:** `stripOrderNumberPrefix` currently only surfaces in the
UI for `fujipicpro` (`renderer.js:5502`, `:6130`, `updateOcTypeFields:5358`).
M3 adds `folder_copy` to that visibility gate. The stored field name, the
helper and the semantics stay identical across both types — one concept, one
name, one implementation.

---

## 3. M1 — extend `template-tokens.js`

Pure module, no fs, no electron-store. All of M1 is unit-testable.

### 3.1 New signature

```js
resolveTemplate(template, job = {}, ctx = {}, opts = {})
```

`opts` is **new and optional**. Existing callers pass three arguments and must
be byte-identical after this change — that is the M1 tripwire (§3.6).

| opt | Type | Meaning |
|---|---|---|
| `stripPrefix` | string | Passed to `printUtils.stripOrderNumberPrefix` for `{orderNumber}` and `{jobName}`. Blank/absent = no stripping. |
| `now` | Date | Injected clock for `{date}`. Absent = real clock. Tests MUST inject. |

### 3.2 New tokens

| Token | Source | Notes |
|---|---|---|
| `{product}` | `job.product` | Display name, e.g. `4x6" Photo Print`. This is D1's answer to "size". |
| `{productCode}` | `job.product_code` | e.g. `0406-cut-print`. |
| `{category}` | `job.category` | |
| `{process}` | `job.process` | |
| `{quantity}` | `ctx.quantity` | **Per-image.** See §3.3. |
| `{index}` | `ctx.index` | 1-based image index within the job. |
| `{indexPadded}` | `ctx.index` | Zero-padded to the width of the job's image count (`3` of 20 → `03`; `3` of 200 → `003`). Width comes from `ctx.imageCount`. |
| `{option:NAME}` | `job.options[]` | Lookup by option name → **value**. `{option:finish-options}` → `lustre`. Case-insensitive on the name. Absent option → blank. |
| `{options}` | `job.options[]` | All non-empty values joined with `_`, in array order — same shape `buildFolderName` already produces. |
| `{dueDate}` | `job.due_date` | ISO `YYYY-MM-DD`. Blank when absent. |
| `{date}` | `opts.now` | Dispatch date, ISO `YYYY-MM-DD`. See §3.5 — this also fixes a latent bug. |

Existing eight tokens (`{customerName}`, `{firstName}`, `{lastName}`,
`{jobId}`, `{orderNumber}`, `{jobName}`, `{filename}`, `{originalFilename}`)
keep their current behaviour except for the `stripPrefix` opt applying to the
two order-derived ones.

### 3.3 `{quantity}` is per-image, deliberately

`job.quantity` is not a reliable print count — recorded during the
batch-splitting work: film jobs carry copies *per image*, manual jobs carry a
total, and Pixfizz jobs are skipped entirely by
`recompute_job_quantity_from_artwork`. The per-image manifest quantity is what
the batch splitter and the print-count gate both read, and it is what an
operator means by "how many of this one".

**Do not add a job-level quantity token.** A confidently wrong number baked
into a filename is worse than no number. If a job total is ever wanted it gets
its own differently-named token and its own caveat in the UI help text.

### 3.4 `{option:NAME}` implementation note

`{option:...}` needs a regex replace with a capture group, not a literal
`String.replace`. Match `\{option:([^}]+)\}` and resolve per match. Be explicit
about:

- Name matching is **case-insensitive** and trimmed (`{option: Finish-Options }`
  resolves).
- Absent name → **blank**, consistent with every other token and with the
  module's long-standing "empty resolves to empty rather than throwing" rule.
- An option present with an empty value → blank.
- A malformed token (`{option:}`) → blank, and the token is consumed (not left
  in place). Test this — a leftover literal `{option:}` in a filename is the
  kind of thing nobody notices until a lab complains.

### 3.5 `{date}` also fixes a latent bug — verify before fixing

`renderer.js` seeds the Fuji back-print template default as
`'{firstName}/{filename}/{date}'` (two places in `openOrderControllerModal`),
but `resolveTemplate` has never supported `{date}`, and
`_sanitiseBackprintText` (`fuji-jobmaker-generator.js:89`) only strips
`%(;'` and `~` — braces survive.

**So a Fuji controller left on the seeded default with mode `text` emits a
literal `{date}` on the back print.** Confirm that by reading those three
places before touching anything; if it holds, adding `{date}` in M1 fixes it as
a side effect. Note it in the commit message so it isn't mistaken for an
unrelated change.

This is the only place in the brief where an existing output changes. It is a
fix, not a regression, but it *is* a behaviour change for any controller with
`{date}` in a live template — call it out in the release note.

### 3.6 M1 tests

- **Tripwire first:** a test that every current call shape
  (`resolveTemplate(t, job, ctx)`, three args) produces exactly what it
  produced before, for each of the eight existing tokens. Write this test,
  confirm it passes, and confirm it *fails* if you make `stripPrefix` default
  to anything other than blank. A four-arg signature change to a module shared
  by four emitters is the highest-risk edit in this brief.
- Each new token: populated, empty, and missing-field cases.
- `{option:...}`: found / not found / case-insensitive / empty value /
  malformed / two different lookups in one template.
- `{indexPadded}`: widths for 9, 10, 99, 100, 200 images.
- `stripPrefix`: applies to `{orderNumber}` and `{jobName}`; blank is a no-op;
  never strips to empty; case-insensitive; non-leading match untouched.
- `{date}` with an injected `opts.now` — no real clock in tests.

---

## 4. M2 — new pure module `src/main/services/folder-copy-filename.js`

All naming logic, zero fs calls. This is where the safety rules live.

```js
buildCopyFilenames(images, job, opts) -> [{ sourcePath, destFilename }]
```

`images` is the array `_sendViaFolderCopyRouted` already builds
(`{ sourcePath, filename }`, plus the manifest `quantity` threaded through —
see M4). `opts` carries `{ template, stripPrefix, now }`.

### 4.1 Blank template = untouched

`template` blank/absent → return the input basenames verbatim. **Nothing
changes for any existing installation.** Lock this with a test.

### 4.2 Extension is never template-controlled

Always take the extension from `path.extname(img.sourcePath)` and append it to
the resolved name. Strip any extension the template happened to produce so a
template of `{filename}_{quantity}` cannot yield `photo.jpg_2` or
`photo.jpg.jpg`. Test both.

Note `img.sourcePath` may be an *enhanced* image (`_getEnhancedPathMap`
substitution happens before this point) — take the extension from the file
actually being copied, not from `img.filename`.

### 4.3 Sanitising

- Strip `printUtils.UNSAFE_CHARS` (`" / \ : * ? < > |`). **Export it** from
  `printUtils` — it is currently module-private. Do not write a second
  character class; a divergence between folder naming and file naming is a
  future bug.
  - This also means a template cannot inject a path separator. Test `{product}`
    containing `/`.
- Collapse runs of whitespace to a single space; trim.
- Strip trailing dots and spaces (Windows silently drops them, which turns a
  collision check into a lie).
- Cap the resolved stem at **120 characters** before the extension. Log once
  per dispatch at WARN when truncation happens — silent truncation makes two
  different jobs collide and look like an auto-suffix bug.
- Resolves to empty after all that → **fall back to the original basename** and
  log WARN with the job id and the template. Never write a file named `.jpg`.

### 4.4 Collisions: within one dispatch only

Twenty images and a template of `{quantity}_{product}` produce the same name
twenty times; `copyFileSync` overwrites silently and nineteen images vanish
with no error. That is the failure this module exists to prevent.

**Rule: de-duplicate within the returned array.** Keep a `Set` of names already
issued in this call; on a repeat, insert `_2`, `_3`, … before the extension.
Cap at 999 attempts, then throw — an unbounded loop here would hang a dispatch.

**Do NOT check the filesystem.** This is deliberate and it matters:

- Re-sending or retrying a job today overwrites the same filenames in the same
  folder, so a retry is idempotent. An fs-based no-overwrite rule would turn
  every retry into a folder full of `_2`, `_3` duplicates — a worse bug than the
  one being fixed, and one the operator would find much later.
- The vanishing-images failure is entirely *within* one dispatch, so
  within-dispatch de-duplication solves all of it.

Write that reasoning into the module docstring. Somebody will try to "improve"
this into an `fs.existsSync` check otherwise.

### 4.5 M2 tests

- Blank template → basenames verbatim (the no-change lock).
- 20 identical resolutions → `name.jpg`, `name_2.jpg` … `name_20.jpg`, all
  unique, order preserved.
- Extension always from source; template-supplied extension stripped; enhanced
  source with a different extension.
- Unsafe characters, path separators, trailing dots, whitespace collapse.
- 120-char truncation.
- Empty resolution → original basename fallback.
- Mixed case: two images that collide plus one that doesn't — the
  non-colliding one must NOT get a suffix.

---

## 5. M3 — controller config

Three new fields on `folder_copy` controllers:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `filenameTemplate` | string | `''` | Blank = keep original filenames. |
| `destinationLayout` | `'job'` \| `'root'` | `'job'` | `job` = today's `{outputPath}/{folder}/`; `root` = files straight into `{outputPath}`. |
| `stripOrderNumberPrefix` | string | `''` | Existing field, existing helper, now also shown for `folder_copy`. |

### 5.1 Both route literals — the drift hazard

`folder_copy` builds a route object in **two** places in
`src/main/services/routing-service.js`:

- `resolveRoute` — around **:410**
- `resolveRouteForController` — around **:783** (the reassign-a-held-job path)

They are currently identical. Add all three fields to **both**, then add a test
that asserts the two literals produce the same keys for the same controller.
The 1.12.0 PIC Pro bug (`mergeOrderJobs` assigned in the wrong type block, so
it never persisted) and the epson `nameOpts.batch` drop were both this exact
shape of mistake: two places that must agree, one of them updated. A test that
compares the two shapes is cheap and catches the whole class.

### 5.2 Renderer

- `updateOcTypeFields` (`renderer.js:5331`): show the new groups for
  `folder_copy`, and add `folder_copy` to the existing
  `ocStripOrderNumberPrefixGroup` visibility gate (currently `fujipicpro`
  only).
- `openOrderControllerModal`: load the three fields; blank/`'job'` for any
  other type, matching how the PIC Pro fields are loaded at `:5480-5504`.
- `ocSaveBtn` handler: assign the three fields **inside the `folder_copy`
  block**, not in a shared section. That discipline is what the comment at
  `renderer.js:6003` is about, and it is why the PIC Pro merge bug happened.
  `stripOrderNumberPrefix` is currently assigned in the `fujipicpro` block at
  `:6130` — the `folder_copy` block needs its own assignment; do not hoist it
  to a shared position.
- Token reference panel: add a **new** `FOLDER_COPY_TOKENS` list. Do **not**
  extend `PHOTO_LINE_TOKENS` (`renderer.js:5148`) — photo lines never receive
  per-image `index`/`quantity` context, so advertising those tokens there would
  offer an operator tokens that silently resolve blank. Two lists, each
  advertising only what its caller actually supplies. Note in a comment that
  both are manually synced with `template-tokens.js` because the renderer can't
  `require` Node modules.

### 5.3 Save-time validation (renderer + IPC mirror)

Follow the established pattern: validate in the renderer for a fast message,
mirror it at the IPC boundary in `ohd:routing:save-controller`
(`ipc-handlers.js:1232`) so a malformed payload can't persist.

1. `destinationLayout` must be exactly `'job'` or `'root'`. Anything else →
   reject.
2. **`destinationLayout === 'root'` requires a non-blank `filenameTemplate`.**
   Without it, every job's original basenames land in one shared folder — and
   across orders those names *will* repeat, with nothing to disambiguate them.
3. **`destinationLayout === 'root'` requires the template to contain at least
   one job-distinguishing token** — one of `{orderNumber}`, `{jobName}`,
   `{jobId}`. A root-layout template of `{product}_{index}` resolves
   identically for every job that shares a product and silently overwrites
   across dispatches. Within-dispatch de-duplication (§4.4) cannot see that,
   by design — so the guard has to be here, at save time, where it can
   actually be explained to the operator.

   > **M3a correction (2026-08-17).** The first version of this rule listed
   > five tokens: `{orderNumber}`, `{jobName}`, `{jobId}`, `{filename}`,
   > `{originalFilename}`. That was wrong. `{filename}` resolves to a
   > manifest basename like `5_IMG.jpg` — an index-prefixed customer
   > filename — and `{originalFilename}` is the same value with the leading
   > `N_` index prefix stripped. Camera filenames repeat across orders
   > constantly (`IMG_0001.jpg`, `DSC_0001.jpg`), so two orders each
   > containing that name at the same slot resolve identically and would
   > overwrite in root layout. Only job-level identifiers actually
   > distinguish across jobs; per-image tokens don't count.
4. `filenameTemplate` is free text otherwise — no token-validity check. An
   unrecognised token resolving blank is the module's documented behaviour, and
   the live preview (M5) is the right place to catch typos.

Error messages should name the fix, not the rule — e.g. *"A filename template
is required when files go in the root of the copy-to folder, and it must
include at least one of {orderNumber}, {jobName} or {jobId} so files from
different jobs don't overwrite each other."* (M3a-narrowed set.)

### 5.4 M3 tests

- Route literal parity between `:410` and `:783`.
- Read-time defaults: a controller record with none of the three fields
  resolves to `''` / `'job'` / `''`.
- IPC rejects: bad `destinationLayout`; `root` with blank template; `root` with
  a template lacking every distinguishing token. Each with the specific error
  text.
- IPC accepts: `job` with blank template (the existing-installation case).
- Round-trip: save a `folder_copy` controller with all three fields, read it
  back, confirm all three persisted. This is the test the PIC Pro merge bug
  didn't have.

---

## 6. M4 — wire into `_sendViaFolderCopyRouted`

`src/main/services/print-service.js:2253`.

### 6.1 Thread per-image quantity through

The `imageFiles` map (`:2276`) currently keeps `sourcePath` and `filename`. Add
`quantity: img.quantity` from the manifest image, and pass `imageCount` for
`{indexPadded}`. `{quantity}` resolving blank because nobody threaded it is a
plausible and quiet failure — assert on it in the M4 test.

### 6.2 Destination folder

```
layout 'job'  →  path.join(route.outputPath, jobFolderName)
layout 'root' →  route.outputPath
```

`jobFolderName` becomes
`${stripOrderNumberPrefix(job.order_number, route.stripOrderNumberPrefix)}_${job.id}`.

**With `stripOrderNumberPrefix` blank the folder name must be byte-identical to
today's `${job.order_number}_${job.id}`.** Same constraint as the unsplit-DPOF
folder name in `buildFolderName`, and it gets the same kind of regression test.
Note that `jobFolderName` is also used at `:2261` to locate the *source* job
folder under `downloadDirectory` — that one must **not** be stripped. Keep two
clearly-named variables (`sourceJobFolderName` / `destJobFolderName`) rather
than reusing one; conflating them would send OHD looking for a source folder
that doesn't exist, and the error would point at the wrong thing entirely.

### 6.3 Filenames

Replace the copy loop's `img.filename` with the M2 result. Log at INFO once per
dispatch: layout, whether a template was applied, image count, and how many
names were auto-suffixed. A suffix count above zero is the operator's signal
that their template is under-specified.

### 6.4 Default Folder / Process Folder must be unaffected (D4)

`ipc-handlers.js:4040` builds its own route object with only `outputPath` and
`controllerName`, so `filenameTemplate` / `destinationLayout` /
`stripOrderNumberPrefix` all arrive undefined and every default applies. That
gives D4 for free — **but test it explicitly** rather than reasoning about it,
because it is exactly the sort of thing a later refactor breaks silently.

### 6.5 M4 tests

Use a real temp directory and the real writer for at least one test — the
epson batch-name bug passed every test it had because the writer was stubbed.

- Real temp dir, template set, 3 images: correct names on disk, correct folder.
- Real temp dir, blank template, blank strip prefix: filenames **and** folder
  name byte-identical to pre-change output (the no-change lock).
- `root` layout: files at `route.outputPath`, no subfolder created.
- Strip prefix set: destination folder stripped, source folder lookup NOT
  stripped.
- Per-image quantity reaches `{quantity}`.
- Default-folder route (no template fields): original names, original folder.
- Re-dispatch the same job twice with a template: same filenames both times, no
  `_2` duplicates (the §4.4 idempotence guarantee).

---

## 7. M5 — live preview in Settings

The highest-value control in this feature. Without it the operator discovers
their template mistake by looking at the destination folder, possibly after a
lab has already printed from it.

- A read-only preview line under the template field, updating as the operator
  types (debounced).
- New IPC: given a template + the three config fields + a controller id, return
  2–3 resolved sample filenames.
- Sample source, in order of preference: the most recent job routed to this
  controller; else the most recent job with a manifest; else a hard-coded
  synthetic job. **Label which one is in use** — "Preview using job 12345" vs
  "Preview using sample data" — so a preview built from synthetic data is never
  mistaken for a real resolution.
- Show the destination path too, not just the filename, so the layout choice
  and the prefix strip are both visible in one place. Path length is half the
  point of this feature.
- The preview must run the **real** M1+M2 code path. A preview that
  approximates the resolver is worse than no preview: it will disagree with
  reality exactly when the operator is relying on it.

Tests: the IPC returns names identical to what M2 produces for the same inputs
(assert equality against `buildCopyFilenames` directly, not against a literal);
graceful behaviour with no jobs available.

---

## 8. Out of scope — decided, not forgotten

- **Reprints** (D8). `_sendReprintViaFolderCopy`
  (`print-service.js:1442`) keeps original filenames into its
  `…_{id}-r{n}` folder. Reprint images come from the sidecar
  (`qtyCurrent`, no manifest), so `{quantity}` and `{index}` would need
  different plumbing and different semantics. Add a one-line comment in that
  method saying templates deliberately don't apply, pointing at this brief, and
  add a `docs/BACKLOG.md` entry. An operator who sets a template and then can't
  work out why reprints look different needs that comment to exist.
- **Default Folder / Process Folder routes** (D4).
- **Size translation table** for Folder Copy (D1) — revisit only if `{product}`
  proves too verbose in practice.
- **`pdf_copy`** controllers. Same shape of ask, different pipeline; if it comes
  up, M1 and M2 are reusable as-is.

---

## 9. Docs & release

- `docs/folder-copy-filename-templates-investigation.md` — add a header line
  pointing at this brief as the decisions-of-record.
- Operator note: the three new fields, the full token table, the
  root-layout requirement, and the `{date}` behaviour change from §3.5.
- `docs/BACKLOG.md` — the reprint entry from §8.

---

## 10. Build order

M1 → M2 → M3 → M4 → M5. M1 and M2 are pure and fully testable with no app
running; get them green before touching config or the dispatch path.

Land M1–M4 together (the feature is not usable without all four), then M5
separately so the preview can be iterated on without re-testing dispatch.

## 11. Tripwires — the four things most likely to go wrong

1. **The four-argument `resolveTemplate` change** breaking one of the four
   existing emitters. Mitigation: §3.6's byte-identical test, written first.
2. **One of the two `folder_copy` route literals** not getting the new fields.
   Mitigation: §5.1's parity test.
3. **`jobFolderName` reused for both source lookup and destination** once
   stripping is added. Mitigation: two differently-named variables, §6.2, and
   the source-not-stripped test.
4. **An fs-based no-overwrite check** getting added later and breaking retry
   idempotence. Mitigation: §4.4's reasoning in the module docstring, and the
   double-dispatch test.

---

## 12. Amendments during build

The brief was updated in flight — future-me reading it needs to know which
parts were superseded and which parts of the code no longer match the
original spec. Every commit in the table at the top of this file corresponds
to at least one amendment listed here.

### M2 amendments A / B / C (before implementation, per operator note)

Three shape corrections agreed before M2 was written:

- **A. Return shape carries `stats`.** §4 as originally written had
  `buildCopyFilenames` returning a bare `[{ sourcePath, destFilename }]`
  array. Amended to
  `{ files: [...], stats: { suffixed, truncated, fallbacks } }`. The
  module stays logger-free (test-friendly, no stub needed); M4 reads
  the stats and logs once per dispatch. `fallbacks` is an array of
  original basenames so the log can name them individually rather than
  just count.
- **B. `opts.now` is TEST-ONLY.** Passed through to `resolveTemplate`
  when the caller supplies one, but M4 must NEVER thread one through
  in production: M1a made `resolveTemplate` throw on a non-Date
  `opts.now`, and any value round-tripped through config or JSON
  arrives as a string. M4 lets the real clock default; the M2
  docstring calls this out explicitly.
- **C. Index context owned by the module.** §4 as originally written
  had the caller passing `ctx.index` / `ctx.imageCount`. Amended:
  M2 owns the loop, so it sets `index` (1-based, from the loop
  variable) and `imageCount` (from `images.length`) per iteration.
  Caller-supplied values are ignored. A dedicated test passes
  `index: 999` from the caller and confirms the module overrides.

### M2b — Win32 reserved device names (added, not in original brief)

CON, PRN, AUX, NUL, COM1-COM9 and LPT1-LPT9 are refused by Win32
regardless of extension. Without a guard a resolved stem matching one
of those would fail `fs.copyFileSync` at dispatch with a generic
OS-layer error that points nowhere near the template that caused it.
Guard prefixes with an underscore (`CON` → `_CON`) on the templated
path only; fallback path is deliberately unguarded (upstream data
issue, should stay visible).

Not in the original brief because the failure mode wasn't spotted
until the operator asked about it after M2 shipped. Added as its own
commit (`bcc1691`) before M3 landed.

### M2 fix — `path.extname` on template output (bug caught by operator review)

`_stripTemplateExt(s)` in the initial M2 called `path.extname` on the
RESOLVED template value. `path.extname` finds the LAST dot in the
last path segment, so any resolved value containing an embedded dot
got truncated there. `{product}` = `"8.5x11 Canvas"` with a `.tif`
source produced `"8.tif"` — the whole product name silently lost.
Decimal sizes (8.5x11, 11x8.5, 1.5in) are normal in Wide Format,
which is the *primary* use case for this feature, so the bug would
have hit real dispatches on day one.

`_nextSuffixed` had the same flaw for the fallback path — a dotted
no-ext name like `"8.5x11 Canvas"` would suffix mid-name as
`"8_2.5x11 Canvas"`.

Fix, bundled into the M2 commit `090b72f`:

- `_stripSourceExt(s, sourceExt)` removes case-insensitive occurrences
  of the LITERAL source extension; caller appends `sourceExt` once.
  Never calls `path.extname` on template output.
- `_nextSuffixed(name, sourceExt, issued)` takes the source ext
  explicitly, inserts `_N` before it when the name ends in it,
  appends at end otherwise.
- Meta-test reads the module source and asserts exactly ONE
  `path.extname` call remains, and that it is on `img.sourcePath`
  (the trusted anchor). A future maintainer who reintroduces the
  pattern gets a loud test failure naming the exact signature.

The gap that let the initial bug ship was that no test used a
resolved value with an embedded dot. Closed with 19 targeted cases
across sanitisation, truncation, collision path, and fallback.

Removing ALL occurrences of the source ext (not just the trailing
one) is a deliberate trade — a product named `"Canvas.jpg Print"`
with source `.jpg` becomes `"Canvas Print.jpg"` rather than
`"Canvas.jpg Print.jpg"`. End-anchoring would preserve that name but
would break the `{filename}_{quantity}` case (`"photo.jpg_2"` →
must not survive as the forbidden `"photo.jpg_2"`, must strip to
`"photo_2.jpg"`). Optimise for the natural template-mistake shape;
the mid-name-`.jpg`-in-a-product-name shape is vanishingly rare.

### M3a — §5.3 token set was WRONG (correction to the brief itself)

§5.3 originally listed FIVE tokens as job-distinguishing under the
root layout: `{orderNumber}`, `{jobName}`, `{jobId}`, `{filename}`,
`{originalFilename}`. That was wrong, and the error was in the
brief.

`{filename}` resolves to a manifest basename like `"5_IMG.jpg"` — an
index-prefixed customer filename. `{originalFilename}` is the same
value with the leading `N_` index prefix stripped, so it is strictly
weaker at distinguishing. Camera filenames repeat across orders
constantly (`IMG_0001.jpg`, `DSC_0001.jpg`): two orders each
carrying that name at the same slot resolve identically and would
overwrite in root layout. Only job-level identifiers distinguish
across jobs. A root-layout template of `{originalFilename}_{index}`
passed the pre-M3a check and was unsafe.

Narrowed in commit `c6e6564` to `{orderNumber}` / `{jobName}` /
`{jobId}` in both the renderer regex AND the IPC mirror. Regex sites
carry a comment auditing each excluded token so a future maintainer
can't quietly widen it back. §5.3 above updated with a dated
correction note.

Same commit also fixed a distinct bug: `controller.filenameTemplate`
was stored untrimmed while validation ran on the trimmed value. A
whitespace-only `"   "` template under 'job' layout stored as truthy
and M2 later treated it as a real template, resolved to blank, and
sent every image down the empty-resolution fallback. Both the
renderer and the IPC boundary now trim at store time (symmetric with
`stripOrderNumberPrefix`).

### M5a — `buildDestFolder` extracted + preview runs planner on full images

Two related shape corrections after M5 shipped:

1. **The destination-folder rule was implemented twice.** M4 inlined
   the layout switch and `destJobFolderName` derivation in
   `_sendViaFolderCopyRouted`; M5 re-derived the same rule in
   `folder-copy-preview.js`. Two copies of §6.2 in two files — same
   drift hazard as the two route literals in routing-service, but
   here the fix is a single helper rather than a parity test.

   Extracted `buildDestFolder({ outputPath, orderNumber, jobId,
   destinationLayout, stripPrefix })` into
   `src/main/services/folder-copy-filename.js` alongside
   `buildCopyFilenames`. Both callers go through it. The
   blank-outputPath branch — previously a preview-only special case —
   is now handled inside the helper so preview and dispatch cannot
   disagree even in the mid-edit "before Save" case.

   **The single-implementation rule for the destination folder lives
   in `buildDestFolder`.** If a future caller re-derives the rule
   inline, the code contains two truths and one of them is going to
   drift. Update the helper; don't copy.

2. **The preview was slicing images to 3 BEFORE calling the M2
   planner.** Two silent failures:

   - `ctx.imageCount` was 3, so `{indexPadded}` width was 1. A
     40-image job with template `x{indexPadded}` previewed as
     `x1, x2, x3` and then dispatched as `x01…x40`. The preview
     showed filenames that were NOT the filenames.
   - Within-call collision detection only saw 3 of 40 images. A
     template lacking any index token previewed with no auto-suffix
     warning and then suffixed 39 files at dispatch. The warning
     went quiet exactly when it mattered.

   Fixed in commit `d96d98e`: preview runs `buildCopyFilenames` on
   the FULL image list (pure and cheap — 40 iterations of string
   replacement costs nothing), slices for display only. Stats and
   warning counts derive from the full run; the response's
   `sampleSize` is the display truncation, `totalImageCount` is the
   real image count, and the operator-facing warning wording quotes
   the count out of the real total ("39 of 40 preview names…").

### Docs (§9) — deferred pieces

Also worth recording: §9 called for an "operator note" separate
from the CHANGELOG. Both landed: the CHANGELOG entry (now v1.15.0,
2026-08-18) is the primary reference and drives release-time
release-notes generation at
`docs/RELEASE-NOTES-1.15.0-operator.md`.

### M8 — option-name discoverability + honest `{options}` warning

`{option:NAME}` was unusable without knowing the option name — they
are API keys like `finish-options`, `photo`, `layout-options` that an
operator has no way to see anywhere else in the app. Preview now
renders the sample job's option names as click-to-insert chips beside
the "Preview using job 12345" label.

Also: the preview now warns when `{options}` on the sample job
resolves to include a machine-shaped value (a `db:…` photo id, a
long numeric shopify variant id). Names the offending option and
suggests `{option:NAME}` for the specific value the operator wants.
`{options}` remains available — click-to-copy — for cases where the
lab actually wants the whole joined string.

Landed in `7f46c43`.

### M7 → M7a → M7b — Strip Order Number Prefix: shape shifted twice

The `stripOrderNumberPrefix` field described in §5 and §6 of this
brief was a single string. Two shape shifts landed after the initial
brief, both in response to real customer configurations:

**M7 (`c23b491`) — widened to a list.** One OHD install talks to one
OrderHub org, but that org can ship orders with several source-website
prefixes (Richard's install already had `ORD-`, `PXDEMO-`, `POS-`
live on the same Pixfizz account). The single-string field couldn't
express "match whichever of these three arrives". Changed to a
repeating-row `string[]` on the controller record, longest-match-first
sort inside the helper, PIC Pro single-job path routed through
`getOrCreateSubmissionId` for cross-prefix collision safety on the
staging folder / .txt / DIGIN folder.

**M7a (`01a844a`) — separator required.** M7 accepted leading-substring
matches when the remainder didn't start with `-` or `_`. A configured
`PXDEMO` would strip `PXDEMOX-1` to `X-1`. Fix: unless the configured
prefix already ends in `-` / `_`, the remainder MUST begin with one;
otherwise this candidate does not match and the next is tried. Test
that pinned the bug was mis-titled — the title said "PXDEMO must NOT
strip PXDEMOX" but the assertion codified the strip. Flipped as part
of M7a and CLAUDE.md now has a convention note: "assertions come from
the invariant, never from observed output".

**M7b (`0a81610` + `8f38729`) — pairs with optional REPLACEMENT.**
Customer request: turn `PXDEMO-091YEC` into `PX-091YEC` (short prefix
that reads better in the printer console), not just strip it. Each
row became a `{from, to}` pair — blank `to` = pure strip (byte-
identical to M7 behaviour), non-blank = replacement. Helper renamed
`stripOrderNumberPrefixMulti` → `applyOrderNumberPrefixRules`, reader
renamed `readStripPrefixes` → `readOrderNumberPrefixRules` (three-
shape tolerant: pair-array wins, then M7 `string[]`, then legacy
1.13.0 single string), field renamed on the controller record
`stripOrderNumberPrefixes` → `orderNumberPrefixRules`, resolveTemplate
`opts.stripPrefixes` → `opts.prefixRules`, buildDestFolder
`args.stripPrefixes` → `args.prefixRules`. Every existing controller
loads correctly with `to` blank; nothing to migrate.

**Subtle rule spelled out in the field help text:** replacement
substitutes for EXACTLY what was matched, including any separator
the M7a rule consumed. `{from:'PXDEMO', to:'PX'}` on
`PXDEMO-091YEC` produces `PX091YEC`, not `PX-091YEC` — the hyphen was
consumed by the match. An operator who wants the hyphen writes
`{from:'PXDEMO-', to:'PX-'}`. Predictable and matches how the request
was phrased.

The single-job PIC Pro counter (`order-submission-seq
.getOrCreateSubmissionId`) is keyed on `displayBase`, so two rules
that funnel different raw prefixes to the same replacement
(`PXDEMO-` → `PX-` and `PXDEMO2-` → `PX-`) get `PX-091YEC` and
`PX-091YEC-2` — the same collision safety net that already covered
pure-strip collisions.
