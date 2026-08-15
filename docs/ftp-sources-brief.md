# Claude Code brief — additional FTP sources (generic file mover)

> Paste everything below the line into Claude Code CLI, run from
> `C:\Dev\OrderHubDownloader` on `main`, working tree clean, after 1.13.0
> has shipped.

---

Read `CLAUDE.md` first.

**Context.** Labs receive ad-hoc files over FTP that have nothing to do with
OrderHub jobs — Labworks XML in particular. Because they run OrderHub Desktop
rather than a commercial file-transfer product, they need a plain, generic
"watch an FTP folder, move files down to a local folder" service. Deliberately
generic: no parsing, no job creation, no OrderHub involvement.

**Scope boundary — read this twice.** These files must **never** enter the job
pipeline. They do not create jobs, do not appear in the Jobs grid, are not
routed, and are not dispatched. This feature ends when the file is on local
disk. If you find yourself touching `job-service`, `routing-service`,
`print-service` or `runAutoPrint`, stop and tell me.

Work in **six commits, in order**. Do not start a milestone until the previous
one's tests pass. Stop and tell me if you hit something this brief did not
anticipate — do not improvise.

I run `npm test` and all manual testing on Windows. Do not claim anything is
production ready. Show me the diff before committing each milestone.

---

## M1 — Config shape + store

A list of named sources under Settings → Downloads. Each source:

| Field | Notes |
|---|---|
| `id` | uuid |
| `name` | operator-facing label, required, unique |
| `enabled` | boolean, default **false** |
| `host` / `port` | port defaults to 21 |
| `username` / `password` | **independent of** the Connection tab's credentials |
| `secure` | plain FTP vs FTPS — match whatever `ftp-service.js` already supports; do not invent a new transport |
| `remotePath` | source folder on the server |
| `localPath` | destination folder — local or UNC |
| `intervalMinutes` | integer ≥ 1, default 5 |
| `deleteAfterDownload` | boolean, default **true** (this is the "move" in the request) |

- Store passwords through the existing `encryption-service.js`. Never write a
  plaintext password to the config store, and never log one — including in
  error messages, which is where they usually leak.
- Validate at the IPC boundary as well as in the renderer: required fields
  present, `intervalMinutes` an integer in [1, 1440], `localPath` non-empty.

**Tests:** persistence round-trip; password stored encrypted and not present in
plaintext anywhere in the store; validation rejects each bad shape; a disabled
source round-trips unchanged.

---

## M2 — The mover (pure-ish core)

New `src/main/services/ftp-source-service.js`. One function that, given one
source config, does a single pass:

1. Connect, list `remotePath` (files only, non-recursive for v1 — say so in the
   docblock).
2. For each file: download to a **temporary name** in `localPath`
   (e.g. `.<name>.part`), then rename into place once the transfer completes.
   Never let a half-transferred file appear at the destination under its real
   name — whatever picks these up may be watching that folder.
3. Only after the rename succeeds, delete the remote file when
   `deleteAfterDownload` is on.
4. If the destination file already exists, **do not overwrite**. Skip it, count
   it, and log at warn. Silently clobbering a file someone else's process is
   using is the worst failure mode here.
5. Return a summary: `{ moved, skipped, failed, errors[] }`.

Reuse `ftp-service.js` rather than adding a second FTP client. If it can't be
reused cleanly, tell me why before writing a new one.

**Tests:** with a stubbed FTP client — happy path; download fails mid-file
(no file left at the destination, remote not deleted); rename fails; existing
destination file is skipped not overwritten; `deleteAfterDownload: false`
leaves the remote intact; empty listing is a no-op.

---

## M3 — Scheduling

- One timer per enabled source, at its own `intervalMinutes`. `.unref()` so it
  can't hold the main process open.
- **Never let two passes for the same source overlap** — if a pass is still
  running when the timer fires, skip that tick and log at debug. A slow or
  hung FTP server must not stack up passes.
- Timers reconcile when settings are saved: added, removed, re-intervalled, and
  disabled sources stopped — without an app restart.
- Do **not** run a pass on startup before the UI is ready; first pass on the
  first tick.

**Tests:** timer created per enabled source; disabled source gets none; saving
new settings reconciles without leaking timers; overlapping tick is skipped.

---

## M4 — Settings UI (Downloads tab)

- A list of sources with name, enabled state, last-run time and last result.
- Add / edit / delete, in a modal following the existing controller-modal
  pattern. Use `class="modal-checkbox"` for every tick (see the M1 fix in
  `auto-batch-and-ui-tidy-brief.md` — do not hand-roll inline flex).
- A **Test connection** button that connects, lists the remote folder, and
  reports how many files it can see. This is the single highest-value control
  in the feature — most failures here are credentials or a wrong path, and the
  operator needs to find that out at setup time, not silently at 3am.
- Password field masked; never render a stored password back into the DOM.

`renderer.js` / `index.html` only — **no bundle rebuild**. If you find yourself
editing anything under `src/renderer/views/*.jsx`, stop and tell me.

---

## M5 — Visibility

A silent file mover is undebuggable. Every pass logs a one-line summary at
**info** naming the source, moved/skipped/failed counts. Failures log at
**warn** with the filename and reason; a whole-pass failure (connection
refused, auth rejected, remote path missing) logs at **error** once per pass,
not once per file.

Surface last-run time and last result per source in the Settings list, so the
operator can see it's working without reading the Activity Log.

---

## M6 — Docs + changelog

- `CHANGELOG.md` under `## Unreleased`, in operator language: what it does,
  that it's off by default, and that these files never become jobs.
- A short `docs/ftp-sources.md` covering setup and the move-vs-copy behaviour.
- Do not bump the version or touch `electron-builder.yml`.

---

## Guardrails

- **These files never enter the job pipeline.** No jobs, no routing, no
  dispatch, no Jobs grid.
- **Never overwrite an existing destination file.**
- **Never delete a remote file before the local rename has succeeded.**
- **Never log a password**, including inside error objects.
- **`is_film_development` jobs must never reach** the Jobs grid, auto-print, the
  S3 downloader, or `markReceived`.
- **`.gitattributes` forces `eol=lf`** — check `git diff --ignore-cr-at-eol`
  before believing a whitespace-only diff.
- **Tests must live in one of the five globs in `package.json`.** `node:test` +
  `node:assert/strict`. Direct `node --test` runs need `--test-force-exit`.
- Do not wrap a `require` in a `catch` that swallows the error — see the
  2026-08-15 batch-gate incident in `CHANGELOG.md`.

## Verification checklist (I will run these)

1. A source with wrong credentials fails Test connection with a clear message.
2. A good source moves files down and removes them from the server.
3. `deleteAfterDownload` off leaves the remote copy in place.
4. A file already present at the destination is skipped, logged, not clobbered.
5. Killing the app mid-transfer leaves no real-named partial file, and the
   remote copy still exists.
6. Two sources on different intervals both run at their own cadence.
7. Disabling a source stops it without a restart.

Start with M1. Show me the diff before committing.
