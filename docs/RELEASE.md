# Release process

The only artifact this repo produces is a single Windows NSIS installer:

- **File**: `OrderHub Desktop Setup {version}.exe`
- **Size**: ~576 MB (Electron + Chromium + bundled AI models). Recorded
  as exact bytes per release (see below) so verification compares like
  with like — PowerShell's `Length / 1MB` reports **MiB** (base-1024,
  1,048,576-byte units), not decimal MB. A 576,000,000-byte file reads
  as `~549.3 MB` in PowerShell but `576 MB` in the AWS console and in
  a `du --si` listing; both are correct, they are different units.
  When investigating a size delta always compare byte counts, not
  displayed unit strings.
  - `1.12.0` — 576,578,602 bytes (`Get-Item | Select Length`)
  - `1.12.1` — 576,578,833 bytes (+231 vs 1.12.0 — renderer.js fix only)
  - `1.12.2` — 576,581,873 bytes (+3,040 vs 1.12.1 — Strip Order Number Prefix feature: new field + wiring across shared/main/renderer)
  - `1.13.0` — 576,586,887 bytes (+5,014 vs 1.12.2 — auto-batch-and-ui-tidy release: modal-tick layout fix, Darkroom Pro autoSendBatches opt-in, Order XML tab visibility, plus the critical fix for the batch-splitting hold that had been silently broken in auto-print since v1.10.0)
  - `1.14.0` — 576,623,107 bytes (+36,220 vs 1.13.0 — Epson DPOF batch-splitting release: per-batch folder naming (`_NofM_` marker), per-batch banner sheets, completion roll-up (job completes only when every batch reaches `e`), batch-attributed failure with a resend-one-batch job-row action, epson Settings for the cap + auto-send tick, and the reprint-attribution fix. Includes the fix for order-folder-writer dropping `nameOpts.batch` — every batch of a split job produced the same folder name and batch 2 hit EPERM on p→o rename)
  - `1.15.0` — 576,656,166 bytes (+33,059 vs 1.14.0 — Folder Copy filename templates release: 4-arg `resolveTemplate` with 11 new tokens (`{option:NAME}`, `{indexPadded}`, dispatch-time `{date}` fix that also unblocks the Fuji back-print seeded default), per-controller filename template + destination layout (per-job vs root) on Folder Copy, live preview in Settings with clickable option chips and honest `{options}` warnings, order-number prefix rules widened from single string → list → `{from,to}` pairs with optional REPLACEMENT (helper renamed `applyOrderNumberPrefixRules`) on both PIC Pro and Folder Copy, PIC Pro co-location requirement — Image Staging Root and DIGIN Path must be on the same volume, with the cross-volume EXDEV fallback removed (the ".ohdtmp blank duplicate" fix), and PhotoFinale XML imports now land unpaid (ROES still follows `<PaymentStatus>`))
  - `1.15.1` — 576,658,085 bytes (+1,919 vs 1.15.0 — Fuji PIC Pro save-time volume check softened from hard reject to advisory warning after 1.15.0 hard-blocked a real lab from saving a valid controller: their two UNC paths `\\labserver1\Pixfizz Digin Staging` and `\\labserver1\Digin` are same-server different-share, very likely one physical volume, but the string check called them cross-volume. `isSameVolume` returns a three-state verdict (`certain-same` / `certain-different` / `indeterminate`); only `certain-same` suppresses a warning, no verdict rejects a save. Containment checks (staging inside DIGIN etc.) stay hard rejects. Dispatch-time EXDEV throw in `deliverToDigin` is the authoritative check and unchanged. No other functional changes.) [BUILT NOT DISTRIBUTED — 1.15.1's changes reach labs via 1.15.2.]
  - `1.15.2` — 576,660,736 bytes (+2,651 vs 1.15.1 — Shipping Methods release: ROES parser reads `<ShippingMethod>` and `<ShippingTotal>` mirroring PhotoFinale, blank-vs-zero distinction preserved via numField+setIfPresent so blank `<ShippingTotal>` lets OrderHub apply the matched method's price while an explicit `0` states free shipping. ROES `total_amount` now includes stated shipping via a deliberate divergence from PhotoFinale (which stays wholesale + retail split, unchanged). Also carries the 1.15.1 Fuji PIC Pro advisory-warning fix — first release with that change to reach labs. Verified against XML-ROES068883 (shipping 5 was silently dropped, now reaches OrderHub) and XML-ROES068884 (order total was line-items-only at 11.90 alongside shipping 5, now sums to 16.90).)
  - `1.15.3` (2026-09-01) — 576,669,838 bytes (+9,102 vs 1.15.2 — Fuji PIC Pro cross-volume delivery hotfix: N-lite variant targets the four-share single-server config that 1.15.0 broke and 1.15.1/1.15.2 left broken, by copying staging into `.ohd-inbox-...` inside DIGIN then intra-DIGIN atomic rename to `{orderId}`, only after OrderGateway consumes the .txt. Safety of the cross-volume path rests on two unverified hypotheses about PIC Pro / OrderGateway (name-shape ignored by DIGIN watcher, OrderGateway patient with DIGIN-folder gap); see docs/picpro-cross-volume-investigation.md — the confirming tests have not yet been run at the lab. Independently, an async delivery-failure visibility fix stamps `_status:'error'` on jobs whose delivery failed after dispatch (previously silent — job sat at "in production" indefinitely). Plus an age-based inbox sweep that cleans up its own scratch folders — reaps `.ohd-inbox-*` older than 6h (configurable per controller, clamped [1, 168]) plus own-instance orphans. Save-time volume warning reshaped: `certain-different` warns about slower cross-volume, `indeterminate` (the exact 1.15.0 hard-block config) now silent — the runtime handles either case. Hotfix cut from bcc195e (`chore(release): 1.15.2`) via hotfix/1.15.3 branch; NOT cut from main, which carries unreleased M1–M10 imposition work.)
- **Signing**: none (see [Unsigned installer — SmartScreen](#unsigned-installer--smartscreen))
- **Distribution**: Richard uploads the `.exe` to S3 by hand and pastes
  the link into OrderHub. Labs download from that link and install it
  themselves. There is no CI pipeline and no auto-update in production
  — see [Auto-update is dormant](#auto-update-is-dormant) for the
  code-vs-practice gap.

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

`dist/` is gitignored (see `.gitignore` line 5), so nothing here
gets committed. The build products live locally only until you
upload them.

`electron-builder` also drops `dist\latest.yml`,
`dist\OrderHub Desktop Setup {version}.exe.blockmap`, and
`dist\builder-debug.yml`. None of these are needed for the manual
S3 upload — see [Auto-update is dormant](#auto-update-is-dormant)
for why `latest.yml` is not shipped and how you'd wire it up if you
ever wanted to.

## 6. Upload

One file, one destination.

1. Upload `dist\OrderHub Desktop Setup {version}.exe` to **S3**.
   **TODO(richard):** exact bucket + path prefix — not declared in
   this repo. `electron-builder.yml`'s `publish.url` is a leftover
   placeholder (`https://your-s3-bucket…`) that isn't consumed by
   the release process; ignore it.
2. Paste the resulting object URL into OrderHub (admin console →
   the same location the previous release's link went into).
3. That's the release. Labs download from the OrderHub link and
   install by hand.

Do **not** upload `latest.yml`. It's an artifact of `electron-builder`
that would only matter if runtime auto-updates were on — they
aren't. See below.

## Auto-update is dormant

The code implies auto-updates work; the practice is that they don't.
Both are true — the gap is worth reading before touching either.

`src/main/updater.js` runs on a 4-hour schedule (gated on
`pollingEnabled`). Each check-in:

1. `POST {baseUrl}/checkin` against the OrderHub API with the
   current app version + machine identity.
2. If the response includes `is_up_to_date: false` **and** a
   `download_url`, OHD calls
   `autoUpdater.setFeedURL({ provider: 'generic', url: data.download_url })`
   and then `autoUpdater.checkForUpdates()`.
3. `electron-updater`'s generic provider then fetches
   `{download_url}/latest.yml` — a manifest file that would tell
   it whether a newer version exists and where to download it.

**No `latest.yml` has ever been published**, so step 3 has never
found anything to update to and the in-app "Update Ready" dialog
has never fired in the field.

If auto-update is ever wanted, it's an operational change, not a
code one:

1. Publish `dist\latest.yml` to the same S3 location as the `.exe`
   on every release. Order matters — `.exe` first, then
   `latest.yml`. That way an install that checks in during the
   upload window either sees the old manifest (skips) or sees the
   new one pointing at an exe that has already finished uploading.
   Reversed order leaves a race where the manifest points at a
   half-uploaded exe and the download fails partway through.
2. Make sure the `download_url` field in the `/checkin` API
   response points at the S3 directory the `.exe` and `latest.yml`
   live under (not at the exe itself — the generic provider
   expects a directory URL and appends `latest.yml` under the
   hood).

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

Auto-updates are dormant (see above), so the check is a manual
install:

1. On a staging box or VM, download the installer from the S3 link
   you pasted into OrderHub.
2. Run through the SmartScreen + UAC prompts and complete the
   install.
3. Launch the app and confirm the About dialog / title bar reads
   the new version.
4. Do a smoke pass on the changed area — for a controller-type
   release, dispatch one job of that type end-to-end.
