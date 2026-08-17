# Folder Copy — filename templates & destination layout (build brief)

**Status:** ready to build, 2026-08-17. Supersedes the decisions section of
`docs/folder-copy-filename-templates-investigation.md` (that doc stays as the
research record — read it first for *why*, read this for *what to build*).

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
