# OrderHub Desktop on macOS — feasibility investigation

**Status:** investigation only. Nothing built, nothing changed.
**Date:** 2026-08-06 · **Against:** `main` @ v1.8.0

---

## 1. Headline

The **application code** is in far better shape for a port than you'd expect
from a nine-year-old-feeling Windows lab tool. The whole of `src/` contains
**exactly one `process.platform` branch**, and it's in a dev script, not the
app. There is no Windows binary being shelled out to, no registry access, no
PowerShell, no COM. Every print controller writes files into a folder.

The work is therefore almost entirely **outside** the business logic:
packaging, signing, native binaries, macOS window/tray idioms, and a handful
of filesystem-behaviour differences. Plus one strategic question (§9) that is
probably more important than any of the engineering.

Rough shape: **a working unsigned dev build is a few days. A distributable,
notarised, auto-updating Mac release is 2–3 weeks of work plus an ongoing
doubling of the release and QA burden.**

---

## 2. What is already portable (verified)

| Area | Finding |
|---|---|
| Platform branching | `grep process.platform src/` → 1 hit, in `scripts/rebuild-missing-manifests.js`. None in the app. |
| Shelling out | No `child_process.spawn`/`exec` of external binaries anywhere in `src/main`. The only subprocess is `utilityProcess.fork()` of the app's own `ai-inference-host.js`. |
| Print controllers | All seven types (`noritsu`/DPOF, `epson`, `darkroompro`, `folder_copy`, `pdf_copy`, `frontline`, `fujijobmaker`, `fujipicpro`) dispatch by **writing files to a hot folder**. None launch or link against Windows software. |
| Enhancement providers | Topaz = HTTPS API. Perfectly Clear QuickServer = hot folder. Local = ONNX in-process. No Windows binaries. |
| File watching | `folder-monitor.js` and `order-xml-watch-service.js` already run chokidar with `usePolling: true`. This sidesteps the classic macOS problem where FSEvents doesn't fire for SMB-mounted network volumes — you're accidentally already correct here. |
| Path handling | `path.join` throughout; no `path.win32`, no `path.sep` splitting, no hardcoded drive letters in logic (only in UI placeholder strings and comments). |
| Transport | `basic-ftp`, `@aws-sdk/client-s3`, `https` — all pure JS. |

---

## 3. Native dependencies — the first real gate

Two native modules, and they behave differently.

### sharp
Installed today is only `@img/sharp-win32-x64`. sharp publishes prebuilt
macOS packages (`@img/sharp-darwin-arm64`, `@img/sharp-darwin-x64`), so this
is a packaging problem, not a porting problem: either install on the Mac that
builds, or use npm's `--os=darwin --cpu=arm64` cross-install so
electron-builder can pack the right binary.

**Carry-over risk:** the `sharp.cache(false)` landmine (set in both
`src/main/index.js` and `ai-inference-host.js` to stop libvips holding file
descriptors and throwing EPERM on SMB shares) was found empirically on
Windows/SMB. macOS SMB is a different client with different locking; the
setting should stay, but the underlying behaviour needs re-testing against a
real Synology/NAS share on a Mac before you trust it.

### onnxruntime-node — **Apple Silicon only**
The installed package (`onnxruntime-node` resolving to ORT 1.24.3) ships:

```
bin/napi-v6/darwin/arm64/    ← libonnxruntime.1.24.3.dylib, 35 MB
bin/napi-v6/linux/{arm64,x64}
bin/napi-v6/win32/{arm64,x64}
```

There is **no `darwin/x64`**. So on an Intel Mac the AI features
(orientation detection, MUSIQ quality scoring, Real-ESRGAN local
enhancement) have no runtime unless you build ORT from source yourself.

Practical consequence: **an Apple-Silicon-only Mac build**, or an Intel build
with AI degraded/disabled. Given Apple stopped shipping Intel Macs years ago,
arm64-only is the sane call — but it must be a deliberate, documented one,
not a surprise at a customer site.

**Also unproven:** the execution provider. `ai-inference-host.js` currently
reports `'cpu'` and has a TODO about DirectML detection. On macOS the
interesting EP is CoreML. Real-ESRGAN tiling on CPU-only Apple Silicon may
be acceptable (the M-series CPU is fast) or may be unusably slow at 500
rolls/day volumes. **This needs a measurement, not an estimate.**

---

## 4. Build, packaging and distribution

### electron-builder config
`electron-builder.yml` has a `win:` block only. A `mac:` block is needed:

- `target: [dmg, zip]` — the **zip is not optional** if you ever turn on
  auto-update; `electron-updater` cannot update from a `.dmg`.
- `arch: [arm64]` (see §3). A `universal` build would work for sharp but not
  for onnxruntime-node, and would inflate an already ~576 MB artifact.
- `icon: assets/icon.icns` — you have `icon.ico` and PNGs; an `.icns` has to
  be generated (`iconutil`/`electron-icon-builder`). `scripts/generate-icons.js`
  would need a macOS branch.
- `category: public.app-category.productivity` (LSApplicationCategoryType).
- `hardenedRuntime: true` + an `entitlements.mac.plist`. Electron needs
  `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory`; the ONNX/sharp
  dylibs will also need `disable-library-validation`.
- `asarUnpack` already covers `resources/models/**`, which is what
  onnxruntime-node needs — that part carries over unchanged.

### The build host
electron-builder **cannot produce a signed, notarised macOS app from
Windows**. Notarisation calls Apple's `notarytool`, which is macOS-only. So
you need either a Mac on the bench or a macOS CI runner. Given the release
process today is "Richard runs `npm run build` in PowerShell and uploads the
exe by hand", this is a genuine new piece of infrastructure, not a config line.

Note also that the v1.7.0 asar-corruption trap (never redirect build output
into the repo) applies identically on macOS — same two-pass packing, same
failure mode.

---

## 5. Code signing and notarisation — the hard requirement

This is the biggest behavioural difference from your current Windows practice.

On Windows you ship **unsigned** and tell operators to click through
SmartScreen. macOS has no equivalent escape hatch for a downloaded app:
Gatekeeper applies the quarantine attribute and an unsigned or un-notarised
app is **blocked outright**, not warned about. The workaround
(`xattr -d com.apple.quarantine`, or right-click → Open) is not something to
put in front of a lab operator.

So a Mac release requires, non-negotiably:

1. **Apple Developer Program** membership — $99/year.
2. A **Developer ID Application** certificate (and Installer cert if you ever
   want a `.pkg`).
3. **Hardened runtime** enabled with the entitlements above.
4. **Notarisation** — upload to Apple, wait for the scan, then **staple** the
   ticket so it works on machines with no internet at install time (relevant:
   lab back-office machines).
5. An app-specific password or App Store Connect API key held in the build
   environment.

Budget a day or two of pure frustration the first time. The classic failure
is "local `codesign` passes, notarisation rejects with invalid signature" —
almost always a nested native dylib (sharp's libvips, ORT's dylib) that
didn't get signed. Your `asarUnpack`'d models are inert data and fine; the
`.dylib`s are the ones that bite.

### Auto-update
Currently dormant in production (wired, never activated — `docs/RELEASE.md`).
If you activate it on Mac, note the extra constraints: mac updates require
the app to be **signed with the same Developer ID** across versions, and the
generic S3 provider needs a separate `latest-mac.yml` alongside the existing
`latest.yml`. Two channels, two artifact sets, one bucket.

---

## 6. UI and OS-integration changes

None of these are hard; all of them are visible if skipped.

| Item | Current | On macOS |
|---|---|---|
| Window chrome | `frame: false`, custom header with min/max/close | Removes traffic lights entirely. Want `titleBarStyle: 'hiddenInset'` + `trafficLightPosition`, and hide the custom buttons on darwin so you don't ship two sets. |
| Drag region | `.app-header { -webkit-app-region: drag }` with the drawer `no-drag` landmine | Same mechanism, carries over. Re-test drawers — macOS is fussier about overlapping drag regions. |
| Window icon | `icon: assets/icon.ico` | macOS ignores `BrowserWindow.icon`; it comes from the bundle `.icns`. Harmless but dead code on Mac. |
| Tray | `nativeImage.createFromPath('favicon hub.png').resize(16,16)` | Menu bar needs a **template image** (`favicon hubTemplate.png`, black + alpha, plus `@2x`) or it renders as a fuzzy coloured blob that ignores light/dark mode. |
| Minimise-to-tray | Windows idiom | macOS apps live in the Dock; a menu-bar-only app needs `app.dock.hide()`. Decide which model you want — "close hides to menu bar" reads as broken to Mac users if the Dock icon also stays. |
| Launch on startup | `app.setLoginItemSettings({ openAtLogin })` | Works, but modern macOS surfaces it in System Settings → General → Login Items where the user can silently revoke it. Worth a UI note. |
| Config folder | `%APPDATA%/OrderHub Downloader/` | `~/Library/Application Support/OrderHub Downloader/`. Derived from `productName`, so it lands correctly with no code change. `backup-service`'s hostname + machineId isolation is safe — it uses `os.hostname()` plus a persisted `_machineId` in config, both platform-neutral. |

---

## 7. Filesystem behaviour — the sleeper issues

### 7.1 `.DS_Store` and AppleDouble files (this one is real)

There is **no dot-file or hidden-file guard anywhere in `src/`** — no
`startsWith('.')` check at any `readdir` or watcher site.

macOS creates `.DS_Store` in every folder Finder touches, and on SMB/exFAT
volumes it writes AppleDouble sidecars named `._IMG_0001.JPG` alongside real
files. Two consequences:

- **Inbound:** `folder-watch-service.js` scans with
  `IMAGE_EXTS = ['.jpg','.jpeg','.png','.tif','.tiff']`. `._IMG_0001.JPG`
  matches. It's a ~4 KB resource-fork stub, not an image — sharp will throw
  on it, and worse, it may be counted as a frame in a film roll. This needs
  a filter at every enumeration site.
- **Outbound:** a Mac writing into a Noritsu / Darkroom Pro / Fuji JobMaker
  hot folder will leave `.DS_Store` in it. Whether the minilab software
  chokes on that is an empirical question per controller, and one you can't
  answer from the code.

`order-xml-watch-service.js` is already safe (filters `/\.xml$/i`), and
`folder-monitor.js` watches `addDir` only, so it's largely insulated. Film
scans and file uploads are the exposed paths.

### 7.2 Network shares
Your config today is full of UNC paths (`\\MASTER\Pixfizz\Artwork\`,
`X:\Templates\border.crd`). macOS has no UNC and no drive letters — shares
mount at `/Volumes/<name>`. Three knock-ons:

- UI placeholders and any path validation need platform-aware text.
- **A stored config is not portable between a Windows and a Mac install.**
  That matters for `backup-service` restore: restoring a Windows backup onto
  a Mac would produce a config full of unreachable paths. Worth a guard.
- macOS mounts are **per-login-session**. A share mounted by the logged-in
  user disappears if the session ends; there's no Windows-service-style
  persistent mapping. For an app that must survive reboots unattended in a
  lab, this needs a documented mount strategy (Login Items + `autofs`, or a
  keychain-backed automount).

### 7.3 Case sensitivity
Default macOS (APFS, case-insensitive) matches Windows behaviour, so no
change. But APFS *can* be formatted case-sensitive, and SMB shares expose the
server's semantics. Any loose filename matching would break on such a volume.
Low probability, worth one line in the release notes.

### 7.4 Permissions / TCC
macOS will prompt for Files & Folders access and, on recent versions, network
volume access. A tray app that starts at login and immediately begins
scanning a network share can hit these prompts before anyone is looking at
the screen, and silently do nothing if denied. Needs explicit handling and
operator documentation.

---

## 8. Tests and release process

- **15 of 88 test files** contain hardcoded Windows paths (`C:\...`).
  `CLAUDE.md` already states the suite only runs on Windows. Making the suite
  cross-platform is a bounded, mechanical job (`path.join` in fixtures) but
  it's a prerequisite for anyone developing the Mac build on a Mac.
- `docs/RELEASE.md` is PowerShell-specific end to end. A Mac release needs
  its own section: different build command, `notarytool` step, two artifacts
  (`.dmg` + `.zip`), a second upload, and a second updater manifest.
- **QA doubles.** Every controller type, every dispatch path, every hot
  folder integration would need re-verification on the new platform, against
  real hardware. Given that Fuji PIC Pro is still waiting on a lab test on
  *Windows*, this is the cost that keeps on costing.

---

## 9. The question worth asking before any of the above

**Who is the Mac user?**

Every piece of software OHD talks to at the far end — Noritsu QSS, Darkroom
Pro, Fuji MS01 JobMaker / PIC Pro, Photo Finale, Perfectly Clear QuickServer
— is Windows software. In the normal deployment, OHD runs on or beside the
lab PC that's already running one of them. On that machine, a Mac build is
worth nothing.

A Mac build is only valuable in two scenarios:

1. **A lab whose only computers are Macs**, reaching the minilab's hot folder
   over SMB. Possible, and it does happen in photography businesses, but the
   minilab still needs a Windows box somewhere.
2. **Scan-station / upload-only deployments** — Mode 2 (film scans) and
   Mode 3 (file uploads). These have **no Windows dependency at all**: watch
   a folder, transcode with sharp, push to S3. This is the deployment that
   genuinely could be a Mac, and it's already supported by the
   `pollingEnabled: false` check-in gate you added for multi-PC sites.

That second case suggests a much cheaper first step than a full port: a
**Mac scan-station build** that ships Modes 2 and 3 and hides the print
controller UI entirely. It removes the hot-folder/`.DS_Store`/UNC risk
surface almost completely, needs no minilab QA matrix, and still requires the
same signing/notarisation work — so it's a real test of appetite for the
ongoing cost, at a fraction of the scope.

---

## 10. Suggested sequencing

| Tier | Scope | Effort | Answers |
|---|---|---|---|
| **0 — Spike** | `git clone` on a Mac, `npm i`, `npm start`. Prove sharp + onnxruntime-node load, run one Real-ESRGAN enhancement, screenshot the UI. | 1–2 days | Kills or confirms the two biggest unknowns (native deps, AI perf) for almost nothing. **Do this before deciding anything.** |
| **1 — Internal build** | `mac:` target, `.icns`, tray template icon, traffic lights, dot-file filtering, path/UI fixes, cross-platform tests. Ad-hoc signed, runs on your own Macs. | 1–2 weeks | Is the app usable and correct on macOS? |
| **2 — Distributable** | Apple Developer account, Developer ID cert, hardened runtime + entitlements, notarisation + stapling, dmg/zip, `latest-mac.yml`, Mac release docs. | ~1 week + $99/yr + a build Mac | Can a customer install it? |
| **3 — Ongoing** | Doubled release cadence, doubled QA matrix, second support surface. | Permanent | Is it worth it? (see §9) |

---

## Appendix — evidence

Verified by inspection of the working tree at `C:\Dev\OrderHubDownloader` on
2026-08-06:

- `grep -rn "process\.platform" src/ scripts/` → 1 hit, `scripts/rebuild-missing-manifests.js:59`
- `grep -rn "child_process|execSync|spawn(" src/` → only `scripts/sign.js` (build-time) and `utilityProcess.fork` in `ai-inference-client.js:192`
- `print-service.js:212–227, 735–750` — all controller branches are file writers
- `folder-monitor.js:35`, `order-xml-watch-service.js:205` — `usePolling: true`
- `node_modules/onnxruntime-node/bin/napi-v6/` → `darwin/arm64` only; no `darwin/x64`
- `node_modules/@img/` → `sharp-win32-x64` only (installed set, not a limitation)
- `window-manager.js:20,27` — `frame: false`, `icon: assets/icon.ico`
- `tray-manager.js:23–26` — PNG resized to 16×16, no template image
- `ipc-handlers.js:152` — `app.setLoginItemSettings`
- `folder-watch-service.js:1220` — `IMAGE_EXTS` with no dot-file guard
- No `startsWith('.')` / hidden-file filter anywhere in `src/`
- 15 of 88 test files contain `C:\` literals
- `electron-builder.yml` — `win:` block only; `publish.provider: generic`
- `docs/RELEASE.md` — unsigned Windows distribution, auto-update dormant
