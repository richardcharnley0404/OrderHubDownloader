# OrderHub Downloader

A Windows desktop application (Electron) that automates a photo lab's print
production: it ingests jobs from OrderHub, pulls the artwork, lets an operator
review and crop it, routes it to the right print controller, and uploads film
scans and customer file uploads to S3.

Runs continuously in the system tray. Product name on disk is
**OrderHub Downloader** (`%APPDATA%\OrderHub Downloader\`); the window title
says OrderHub Desktop.

---

## What it does

OHD runs four independent ingestion loops, each separately enabled in Settings:

| Loop | Default interval | Purpose |
|---|---|---|
| **Jobs** | 60s | Poll the OrderHub API for pending jobs, download artwork over FTP and/or S3, route and dispatch to print controllers |
| **Film Scans** | 5 min | Watch a scanner output folder, review/rotate/enhance, upload rolls to S3 |
| **File Uploads** | 5 min | Same watch→upload pattern for customer file uploads, no review surface |
| **Order XML** | 1 min | Watch hot folders for ROES / Photo Finale order XML and submit orders into OrderHub |

A PC can run any subset — an upload-only station can have job polling switched
off entirely and still do film scans.

### Feature areas

**Job ingestion.** `job-service.js` polls `/jobs/pending`, merges into a
persisted cache, marks jobs received and syncs authoritative status back.
Artwork arrives over FTP (`ftp-service.js`, with magic-byte integrity checks)
or S3 (`s3-artwork-downloader.js`) — both produce an identical on-disk layout.
Files can land before the order manifest does; `awaiting-manifest.js` holds the
job in a recoverable state rather than a sticky error.

**Job Review.** A React drawer over the Jobs grid: per-image crop, rotate,
discard/restore, reprint flag, AI quality score, enhancement. Non-destructive —
pristine copies are kept in `{job}/originals/` and never rewritten.
**Manual Crop mode** is the per-image-first cropping workflow for manual-source
artwork, with best-fit crop-box orientation (the box matches each image's own
aspect, not the target size's) and Approve All.

**Routing and dispatch.** `routing-service.js` resolves a job through three
layers — process-folder exceptions, process→controller mappings, then channel
mappings (product code + options → channel, print size, media). Unmatched jobs
surface for manual Assign rather than guessing. `print-service.js` then
dispatches per controller type:

- `noritsu` / `epson` — DPOF (`AUTPRINT.MRK`) + `IMAGES/` folder, prefix-based
  status lifecycle watched by a hot-folder monitor
- `darkroompro` — Darkroom Pro job files, incl. back-print token templates
- `fujijobmaker` — one `.txt` per surface into the JobMaker share
- `frontline` — XML
- `folder_copy` / `pdf_copy` — flat copy and the PDF pipeline (interleaves,
  banner sheets, order identifiers)

Print size is mandatory and comes from the channel mapping, never from the
upstream manifest.

**Film Scans / Film Review.** Optional mirror from a scanner source folder,
stability check, AI auto-rotation (ONNX), optional Perfectly Clear enhancement,
operator review (Auto / Smart / Manual modes), then S3 upload with a completion
manifest. **Auto Assignment Mode** holds each roll until a Film Development job
with a matching twin check arrives, then uploads and stamps the match onto the
manifest so OrderHub can record it.

**AI quality gate.** A MUSIQ ONNX model scores incoming artwork; low scores can
warn or hold the job out of auto-print, with optional automatic fix-up.
Fails open — a scoring failure never blocks a print.

**Enhancement.** Two independent systems: Perfectly Clear QuickServer
(hot-folder, usable on Jobs / Film Scans / File Uploads) and AI upscaling
(local Real-ESRGAN, or Topaz cloud with an API key).

**Reprints and customer originals.** Reprints always source from
`{job}/originals/`, never the working set. Operators can open a customer's
pre-crop upload and re-crop from it; every re-crop is written to
`{job}/recrops/` as an append-only audit trail.

**Backup & restore.** Daily snapshot of five config stores to a UNC or local
path, per-host, secrets deliberately excluded. See `docs/backup-restore.md`.

---

## Architecture

```
src/
  main/            Electron main process
    index.js         boot: single instance, migrations, IPC, window, tray, timers
    ipc-handlers.js  ~125 IPC handlers + the auto-print orchestrator
    services/        ingestion, routing, dispatch, film scans, AI, config stores
    jobs/            Job Review main-side logic (sidecar, crops, reprints)
    enhancement/     Perfectly Clear client + local/Topaz AI upscaling
  preload/         the single contextBridge surface (window.electronAPI)
  renderer/
    index.html       tab shell: Jobs / Film Scans / Order XML / Settings / Log
    renderer.js      vanilla JS driving all of the above (no build step)
    views/           React sources for the two rich views
    *.bundle.js      committed esbuild output for those views
  shared/          Electron-free logic used by BOTH main and renderer
  pdf-pipeline/    pdf_copy controller pipeline
```

Two rendering styles coexist deliberately. The tab shell and Settings are plain
HTML + `renderer.js` and need no build. **Job Review** and **Film Review** are
React, compiled by esbuild into `job-review.bundle.js` / `film-review.bundle.js`
— and those bundles are **committed to git**.

> **If you edit any `.jsx` under `src/renderer/views/`, you must run
> `npm run build:renderer` and commit the regenerated bundle.** Otherwise the
> app keeps showing the old behaviour and it looks like a broken feature.

### Where data lives

Everything is in `%APPDATA%\OrderHub Downloader\`, logs in `logs/` beneath it.

| File | Holds |
|---|---|
| `config.json` | credentials, folders, all feature flags and intervals |
| `routing.json` | controllers, process mappings, channel mappings — the live routing store |
| `jobs-cache.json` | the OrderHub job cache |
| `dpof-state.json` | operator "Printed" flags |
| `frame-metadata.json` | per-frame film-scan rotation / flags / review state |
| `order-xml-ingestion.json` | order XML ingestion history |
| `app-prefs.json` | app theme |
| `print-controllers.json` | **legacy** — migrated into `routing.json` on startup |

---

## Development

```bash
npm install
npm start              # or: npm run dev
npm run build:renderer # after any .jsx change — then commit the bundle
npm test
npm run build          # Windows NSIS installer into dist/
```

`npm test` runs `node --test` over five explicit globs (see `package.json`).
There is no test framework — `node:test` + `node:assert/strict`. Concurrency is
pinned to 1 on purpose: several folder-watch integration tests share an on-disk
store file and flake in parallel. A `__tests__` directory outside those five
globs will silently never run.

Releases ship **unsigned** unless the Azure signing environment variables are
present; users install through the SmartScreen warning.

> When running `npm run build`, never redirect or tee the output into a file
> inside the repo. electron-builder packs the asar in two passes; a file growing
> between passes corrupts the offsets and produces an installer that launches
> and then dies natively with no logs.

---

## Documentation map

- `CHANGELOG.md` — the authoritative per-release record
- `docs/RELEASE-NOTES-*.md` — long-form notes for recent releases
- `docs/print-controllers/` — per-controller formats, setup, workflow,
  troubleshooting, validation
- `docs/backup-restore.md`, `docs/order-xml-hotfolder.md`,
  `docs/perfectly-clear-quickserver-*.md` — subsystem guides
- `docs/phase*-spec.md`, `docs/orderhub-film-gallery-email-workflow-plan.md` —
  designs for planned, not-yet-built work
- `CLAUDE.md` — orientation for AI coding agents working in this repo
