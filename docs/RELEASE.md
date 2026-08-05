# Release process

The only artifact this repo produces is a single Windows NSIS installer:

- **File**: `OrderHub Desktop Setup {version}.exe`
- **Size**: ~576 MB (Electron + Chromium + bundled AI models)
- **Signing**: none (see [Unsigned installer — SmartScreen](#unsigned-installer--smartscreen))
- **Distribution**: Richard uploads manually — no CI pipeline

Runtime auto-updates are driven by `src/main/updater.js`, which points
`electron-updater` at a download URL returned by OrderHub's `/checkin`
API. That has one non-obvious consequence: **`latest.yml` MUST land at
the download URL alongside the `.exe` on every release** — see
step 6 below.

---

## 1. Pre-flight

Before touching the version number:

1. **Tests green.** `npm test` reports `0 fail`. The
   `perfectlyClearClient.test.js` "stability polling" case is
   flaky and unrelated to any dispatch code — rerun once to be
   sure, but it is known and not release-blocking.
2. **Renderer bundle in sync.** If any `.jsx` under
   `src/renderer/views/` has changed since the last committed bundle,
   run:
   ```bash
   npm run build:renderer
   ```
   and commit the regenerated `src/renderer/job-review.bundle.js` /
   `src/renderer/film-review.bundle.js` in a `chore(build): rebuild …
   bundle for …` commit before proceeding. `renderer.js`,
   `index.html` and `styles.css` do not need a bundle rebuild — they
   ship as-loaded. See CLAUDE.md.

## 2. Version bump

Update `package.json`:

```json
"version": "1.8.0",
```

Semver applies to what changed in the release, not to the calendar:

- **Minor** for a new controller type, a new dispatch pipeline, a
  new user-visible feature.
- **Patch** for a bugfix release.
- **Major** is reserved for a breaking config-schema change (none
  since v1.x).

## 3. CHANGELOG

Add the new version at the top of `CHANGELOG.md`, above the previous
entry. Structure the entry with **New / Fixed / Changed** sub-headings
where each sub-heading is meaningful in isolation. Match the density
of recent entries — a paragraph per sub-item, not a one-liner.
Recent releases (v1.7.22, v1.8.0) are the pattern.

If a doc supplements the entry, link it — e.g. "Full format spec in
`docs/print-controllers/FUJI-PIC-PRO-FORMAT.md`."

## 4. Build

From the project root, in PowerShell:

```powershell
npm run build 2>&1 | Tee-Object -FilePath "$env:TEMP\ohd-build.log"
```

Takes a few minutes on a warm machine. Exit code 0 = success.

### ⚠ Never redirect build output into the repo

`npm run build > build.log` (or any redirect into the working tree,
including PowerShell `Tee-Object -FilePath .\anything.log`) is a
release-blocker footgun. `electron-builder` packs the asar in two
passes; a file growing between them corrupts the header-offset table
and every `require()` in the packaged app ends up reading bytes from
the previous file. The installer launches then dies natively with
`0xc000041d` and no logs. This bit v1.7.0. **Always tee to
`$env:TEMP` or `%TEMP%`.**

Signing behaviour during the build: `scripts/sign.js` reads six
`AZURE_*` env vars. When any are missing (i.e. every current build),
it logs `[sign.js] Azure Trusted Signing env vars not set —
skipping code signing.` four times (main exe → elevate.exe →
uninstaller → installer) and returns cleanly. The build succeeds
unsigned.

## 5. Verify the artifact

From the project root:

```powershell
$exe = "dist\OrderHub Desktop Setup 1.8.0.exe"
$ver = (Get-Item $exe).VersionInfo
$exe
Get-Item $exe | Select LastWriteTime, Length
$ver.FileVersion; $ver.ProductVersion; $ver.ProductName
Get-Item dist\latest.yml | Select LastWriteTime
Get-Content dist\latest.yml
```

Expected:

- `dist\OrderHub Desktop Setup {version}.exe` exists, ~576 MB,
  `LastWriteTime` = a few minutes ago.
- `FileVersion` and `ProductVersion` both read the version you
  bumped in step 2. If they read the old version, the build did
  not consume the new `package.json` — verify you ran `npm run
  build`, not a stale `electron-builder --dir` from a prior
  session.
- `ProductName` = `OrderHub Downloader` (installer branding is
  `OrderHub Desktop`; the internal exe metadata still reads
  `Downloader` because renaming would break the
  `%APPDATA%\OrderHub Downloader\` data folder — see
  `electron-builder.yml`).
- `dist\latest.yml` exists and its `LastWriteTime` matches the exe
  (within a few seconds). Content should read:
  ```yaml
  version: 1.8.0
  files:
    - url: OrderHub Desktop Setup 1.8.0.exe
      sha512: <...>
      size: <bytes>
  path: OrderHub Desktop Setup 1.8.0.exe
  sha512: <...>
  releaseDate: '2026-08-05T...'
  ```

`dist/` is gitignored (see `.gitignore` line 5), so nothing here
gets committed. The build products live locally only until you
upload them.

## 6. Upload

Two files must be uploaded to the release location. Both. In lockstep.

- **`dist\OrderHub Desktop Setup {version}.exe`** — the installer users
  download.
- **`dist\latest.yml`** — the update feed. `src/main/updater.js`
  points `electron-updater`'s generic provider at whatever
  `download_url` OrderHub's `/checkin` API returns; the generic
  provider then fetches `{download_url}/latest.yml` to decide
  whether an update is available. If `latest.yml` is missing or
  stale, **every existing install stops updating silently** — the
  updater logs an error to `%APPDATA%\OrderHub Downloader\logs\`
  but the operator sees no dialog and no banner.

Order of upload is safest: `.exe` first, `latest.yml` second. That
way an install that checks in during the upload window either
sees the old `latest.yml` (skips) or sees the new one and
downloads the fresh exe — it can never see a new `latest.yml`
pointing at an exe that hasn't finished uploading yet.

**Upload destination: TODO(richard)** — the OrderHub `/checkin`
API is the source of truth for the download URL; it's not
declared anywhere in this repo. `electron-builder.yml`'s
`publish.url` is a leftover placeholder (`https://your-s3-bucket…`)
and is not consumed at runtime.

The `.exe.blockmap` and `builder-debug.yml` files that
`electron-builder` also drops in `dist/` are for delta updates
and diagnostics respectively — not needed for uploads.

## 7. Unsigned installer — SmartScreen

The installer is unsigned. Windows SmartScreen shows one of two
warnings the first time an operator runs it:

- **"Windows protected your PC"** — click **More info** → **Run
  anyway**.
- **"Do you want to allow this app from an unknown publisher…?"**
  (UAC) — click **Yes**.

Pass this to operators when you send them the download link.
Signed releases (once Azure Trusted Signing is wired up — the hook
already exists at `scripts/sign.js`) will remove the SmartScreen
warning but not the UAC prompt.

---

## Post-release smoke test

If you have a staging OHD install pointed at the same
`/checkin` URL:

1. Wait for the next scheduled check-in (every 4 hours) or restart
   the app to force one.
2. In `%APPDATA%\OrderHub Downloader\logs\app.log`, look for
   `Update available: v{new}` followed by
   `Downloading update: N%` progress lines.
3. On download completion, the **Update Ready** dialog appears with
   Restart Now / Later buttons. `Restart Now` invokes
   `autoUpdater.quitAndInstall()` and the installer replaces the app
   in place; app relaunches at the new version.
