# OHD Backup & Restore — Claude Code Implementation Brief

## Overview

Implement a backup-and-restore system for OrderHub Desktop (OHD) so that when a lab's PC fails and OHD has to be reinstalled, the operator can restore non-sensitive configuration from a single JSON file rather than re-entering every setting by hand. Backups run automatically once per day to a network share configured by the operator, plus a manual "Backup Now" button.

This brief was produced from a design discussion with the lead developer. The decisions below are locked in — do not relitigate them, but flag if implementation reveals one to be infeasible.

---

## Goals

1. Operator configures a network/UNC path once (e.g. `\\NAS\OHD-Backups\`). OHD writes timestamped backups there.
2. After a wipe + reinstall, operator points OHD at the same path, picks a backup file, and the lab is back online with one click + a forced relaunch.
3. Credentials are **never** written to the backup file. Operator re-enters API keys + FTP password after restore.
4. Customer PII is included by default but opt-out via Settings checkbox.

## Non-goals

- No cloud sync, no encryption. Plain JSON on a share.
- No cross-machine backup pooling. Each PC writes into its own hostname-named subfolder.
- No runtime state in backups (jobs, frame metadata, ingestion records, logs).
- No incremental/diff backups. Full snapshot every time.

---

## What gets backed up

The data lives across several `electron-store` files in `%APPDATA%\Electron\orderhub-downloader\`. The backup file consolidates all of them into one document.

### Included

| Source file | Notes |
|---|---|
| `config.json` (the `config-service` schema) | Sanitized — secret keys stripped before write. |
| `routing.json` | `orderControllers`, `processControllerMappings`, `channelMappings`, `processFolderExceptions`, `processFolderPath`, `_migrated_v1`. |
| `print-controllers.json` | Full file — controller definitions + product mappings. |
| `app-prefs.json` | Theme. |
| `film-review-prefs.json` | Density, theme, kbd hint. |

### Excluded — secrets (stripped before write)

```
SECRET_KEYS = [
  'orderhubApiKey',
  'ftpPassword',
  's3SecretAccessKey',
  'topazApiKey',
]
```

Stripped values are written as `null` and an array `_redactedKeys: ['orderhubApiKey', ...]` is added to the backup metadata so restore can prompt the operator to re-enter them.

### Excluded — runtime state (never written)

- `jobs.json` / `jobs-cache.json`
- `frame-metadata.json`
- `order-xml-ingestion.json`
- `logs/`
- Any `_migration*At` timestamps — restore should let the post-restore launch run migrations naturally.

### PII — opt-out

`orderXmlCustomers` is included by default. A new boolean config key `backupIncludeCustomerDirectory` (default `true`) controls whether it's written. When excluded, the backup carries `customerDirectoryExcluded: true` so restore reports it.

---

## File format

Single JSON file, schema-versioned.

```json
{
  "backupSchemaVersion": 1,
  "appVersion": "1.5.0",
  "createdAt": "2026-05-14T14:30:22.456Z",
  "createdBy": {
    "hostname": "LAB-PC-01",
    "user": "lab-pc",
    "machineId": "9b1c2e8f-7d3a-4f6e-b2c1-8a5d4e3f7c91"
  },
  "redactedKeys": ["orderhubApiKey", "ftpPassword", "s3SecretAccessKey", "topazApiKey"],
  "customerDirectoryExcluded": false,
  "stores": {
    "config":           { /* sanitized config.json */ },
    "routing":          { /* routing.json */ },
    "printControllers": { /* print-controllers.json */ },
    "appPrefs":         { /* app-prefs.json */ },
    "filmReviewPrefs":  { /* film-review-prefs.json */ }
  }
}
```

### Filename

```
ohd-backup_<hostname>_<YYYY-MM-DD>_<HH-MM-SS>.json
```

Plus a `latest` copy that's overwritten every time:

```
ohd-backup_<hostname>_latest.json
```

### Folder layout on the share

```
\\NAS\OHD-Backups\
  LAB-PC-01\
    ohd-backup_LAB-PC-01_latest.json
    ohd-backup_LAB-PC-01_2026-05-14_14-30-22.json
    ohd-backup_LAB-PC-01_2026-05-13_09-12-04.json
    ...
```

Per-machine subfolder is created on first run if absent. Keep the last 30 timestamped backups; older ones get pruned at end of every successful backup.

---

## Config schema additions

Add to `src/main/services/config-service.js` schema:

```javascript
backupEnabled: {
  type: 'boolean',
  default: false
},
backupFolderPath: {
  type: 'string',
  default: ''   // empty until operator configures; UNC or local path accepted
},
backupIncludeCustomerDirectory: {
  type: 'boolean',
  default: true
},
backupLastRunAt: {
  type: ['string', 'null'],
  default: null   // ISO 8601 of last successful backup, used by daily-trigger logic
},
backupLastError: {
  type: ['string', 'null'],
  default: null   // last error message, cleared on next successful run; surfaced in UI
},
_machineId: {
  type: 'string',
  default: ''   // UUID generated on first launch; identifies this install across hostname changes.
                // Set once by ensureMachineId() in config-service constructor; never overwritten.
                // Survives PC rename, intentionally does NOT survive reinstall.
}
```

These six must also be added to `getAll()` and `save()` (with `_machineId` being read-only — save() ignores incoming changes to it).

### `_machineId` initialisation

In the `ConfigService` constructor, after the migration calls:

```javascript
_ensureMachineId() {
  if (this.store.get('_machineId')) return;
  this.store.set('_machineId', crypto.randomUUID());
}
```

Call from the constructor alongside `_migrateReviewMode()` and `_migrateReplicateProvider()`.

---

## Implementation

### New service — `src/main/services/backup-service.js`

Public surface:

```javascript
class BackupService {
  constructor({ configService, printControllerStore, routingStore, appPrefsStore, filmReviewPrefsStore, logger, app })

  // Returns { success, filePath, sizeBytes, error? }
  async runBackup({ trigger })   // trigger: 'manual' | 'launch-stale' | 'first-save-of-day'

  // Returns array of { path, hostname, createdAt, appVersion, sizeBytes } newest-first
  async listBackups(folderPath)

  // Reads a backup file and returns the parsed envelope without applying it.
  // Used for the restore preview dialog.
  async readBackup(filePath)

  // Applies a backup. `selections` is { config, routing, printControllers, appPrefs, filmReviewPrefs } booleans.
  // Returns { success, requiresRelaunch: true, restoredSections, skippedSections, migrationNotes[] }
  async restore({ filePath, selections })

  // Internal — called by runBackup on trigger 'launch-stale' / 'first-save-of-day'
  _shouldRunDailyBackup()   // true if backupLastRunAt is null or > 24h ago
}
```

Key behaviours:

- **Atomic writes:** write to `*.tmp` in the same folder, fsync, rename. Never leave a partial file.
- **Errors never propagate:** backup failures log + store `backupLastError` in config + return `{success:false, error}`. They must not break `config-service.save()`.
- **Sanitization:** clone the config object, replace each secret key with `null`, attach the `redactedKeys` list to the envelope. Never deep-merge secrets back in.
- **Schema versioning:** read `backupSchemaVersion` on restore. If it's higher than this build supports, refuse with a clear message. If it's lower, run a migration shim (see "Restore migration shim" below).
- **Pruning:** after a successful write, list backups for this hostname, keep newest 30, delete the rest. Never delete the `latest.json` file. Errors during prune are logged but non-fatal.

### Daily-trigger logic

In `src/main/index.js` (or the equivalent app-ready handler):

```javascript
// On app ready, after services initialise:
if (configService.get('backupEnabled') && configService.get('backupFolderPath')) {
  // Defer 30s so network share has time to come back online if PC just resumed
  setTimeout(() => {
    if (backupService._shouldRunDailyBackup()) {
      backupService.runBackup({ trigger: 'launch-stale' });
    }
  }, 30_000);
}
```

In `config-service.save()`, after a successful save, fire-and-forget:

```javascript
if (this.get('backupEnabled') && backupService._shouldRunDailyBackup()) {
  backupService.runBackup({ trigger: 'first-save-of-day' });
}
```

Do not block the save on this.

### Restore migration shim

Restore reads `backupSchemaVersion` + `appVersion` from the envelope. Even at v1 there's a real need:

- An older backup may have keys that no longer exist in current schema → silently drop them and add a note to `migrationNotes`.
- Older backups may use legacy keys (e.g. `filmScanManualReview` instead of `filmScanReviewMode`) → existing `_migrateReviewMode` and `_migrateReplicateProvider` patterns in `config-service.js` handle this on next launch. Don't duplicate that logic in the shim; let restore write whatever the backup contains and let the next launch run the migrations.
- New keys not present in the backup → leave them at schema default, mention in `migrationNotes`.

### Force relaunch after restore

In-memory services hold the old config. After a successful restore:

1. Show a modal: "Restore complete. OHD needs to restart to apply the new settings."
2. On confirm: `app.relaunch(); app.exit(0);`

---

## IPC contract

Add to `src/main/ipc-handlers.js` and expose via `src/preload/preload.js`:

| Channel | Args | Returns |
|---|---|---|
| `ohd:backup:run-now` | `{}` | `{success, filePath, sizeBytes, error?}` |
| `ohd:backup:list` | `{folderPath?: string}` (defaults to configured path) | `Array<{path, hostname, createdAt, appVersion, sizeBytes}>` |
| `ohd:backup:read` | `{filePath}` | `{envelope, error?}` |
| `ohd:backup:restore` | `{filePath, selections}` | `{success, requiresRelaunch, restoredSections, skippedSections, migrationNotes, error?}` |
| `ohd:backup:relaunch` | `{}` | (does not return — calls `app.relaunch()`) |
| `ohd:backup:choose-folder` | `{}` | `{path}` (opens native folder picker, accepts UNC) |
| `ohd:backup:choose-file` | `{}` | `{path}` (opens native file picker for restore, filters `*.json`) |

All channels validate input shape and reject with descriptive errors. Restore is gated behind a confirmation dialog driven by the renderer — main does not show its own confirm.

---

## UI — Settings panel section

Add a "Backup & Restore" section to the Settings panel. Wire it to the IPC channels above.

```
┌─ Backup & Restore ────────────────────────────────────────┐
│                                                            │
│  [✓] Enable automatic daily backups                        │
│                                                            │
│  Backup folder:  \\NAS\OHD-Backups\           [ Browse ]   │
│                                                            │
│  [✓] Include Order XML customer directory                  │
│      (contains customer names and email addresses)         │
│                                                            │
│  Last backup:  14 May 2026, 14:30   ✓ Success              │
│  ── or ──                                                   │
│  Last backup:  12 May 2026, 09:12   ⚠ 2 days ago           │
│  ── or ──                                                   │
│  Last backup:  Failed — "Network path not found"           │
│                                                            │
│  [ Backup Now ]      [ Restore from Backup… ]              │
│                                                            │
│  ⓘ Backups never contain passwords or API keys.            │
│    You'll need to re-enter those after a restore.          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The "Last backup" line goes amber at > 48h, red at > 7d.

### Restore flow

1. Click "Restore from Backup…" → either pick from configured folder (list view) or browse to a file.
2. Selected file is parsed and a preview dialog shows:
   - Source hostname, app version, backup date.
   - `redactedKeys` list ("These will need to be re-entered: OrderHub API Key, FTP Password, …")
   - Checkbox tree of sections (all checked by default): Config, Routing, Print Controllers, App Prefs, Film Review Prefs.
   - If `customerDirectoryExcluded`, show "Customer directory was excluded from this backup — you'll need to rebuild it manually."
3. On confirm, IPC `ohd:backup:restore` → success → modal "Restart now to apply." → IPC `ohd:backup:relaunch`.

---

## Tests

Add `src/main/services/__tests__/backup-service.test.js`. Cover:

- **Sanitization:** every secret key is `null` in the written envelope; the `redactedKeys` array matches.
- **Customer directory opt-out:** when `backupIncludeCustomerDirectory=false`, `orderXmlCustomers` is absent and `customerDirectoryExcluded=true`.
- **Atomic write:** kill mid-write doesn't leave the destination file corrupted (simulate by stubbing fs.rename to throw — assert `*.tmp` is cleaned up, original is unchanged).
- **Daily trigger:** `_shouldRunDailyBackup()` returns true when `backupLastRunAt` is null, > 24h ago; false when < 24h ago.
- **Prune:** retention drops everything older than the newest 30; `*_latest.json` is never deleted.
- **Restore round-trip:** backup → wipe stores → restore → all settings except secrets match the originals.
- **Restore version skew:** envelope with higher `backupSchemaVersion` is refused; envelope with lower runs migrations on next launch (verify migration shim populates `migrationNotes`).
- **Restore selections:** unchecking "Print Controllers" leaves `print-controllers.json` untouched.

Match the existing test style in `__tests__/config-service-*.test.js` — `node --test`, no Jest.

---

## Multi-machine isolation

Two or more OHD installs are expected to share the same `backupFolderPath` root (a single lab NAS folder for all PCs). The design isolates them in two layers:

### Layer 1 — hostname subfolder

Every PC writes into `<backupFolderPath>/<hostname>/`. Hostname comes from `os.hostname()`. Created on demand, never deleted by OHD.

```
\\NAS\OHD-Backups\
  LAB-PC-01\
    ohd-backup_LAB-PC-01_latest.json
    ohd-backup_LAB-PC-01_2026-05-14_14-30-22.json
  RECEPTION\
    ohd-backup_RECEPTION_latest.json
    ohd-backup_RECEPTION_2026-05-14_09-12-04.json
  PRODUCTION-NAS\
    ...
```

This handles the common case — different machine names, no collisions, no operator intervention.

### Layer 2 — `machineId` collision check

Hostnames alone are not sufficient. Two PCs can end up with the same hostname when:
- A Windows image was cloned without sysprep.
- Two new PCs were both named `LAB-PC` by default.
- A replacement PC was given the same name as the failed one (which is actually *desirable* for restore — see "After reinstall" below).

So every backup envelope carries `createdBy.machineId` (the persistent UUID from `_machineId` in config). Before writing a new backup:

```javascript
async function checkMachineIdCollision(hostFolder, currentMachineId, currentHostname) {
  const latestPath = path.join(hostFolder, `ohd-backup_${currentHostname}_latest.json`);
  if (!await exists(latestPath)) return { ok: true };  // first backup for this host

  const existing = await readJson(latestPath);
  const existingId = existing.createdBy?.machineId;

  if (!existingId) return { ok: true };               // pre-machineId backup, allow overwrite
  if (existingId === currentMachineId) return { ok: true };  // same machine, normal

  // Different machineId in this folder under the same hostname
  return {
    ok: false,
    reason: 'hostname-collision',
    existingMachineId: existingId,
    existingCreatedAt: existing.createdAt,
    existingAppVersion: existing.appVersion,
  };
}
```

On collision:
- Refuse to write.
- Set `backupLastError` to: *"Another machine with hostname `<hostname>` is already using this backup folder (last backup `<createdAt>`). Rename one of the PCs or use a different backup folder."*
- Surface the same message in the Settings UI in red.

This is a loud failure rather than auto-suffixing, because silently writing to `LAB-PC-01-9b1c2e8f/` would leave operators unable to find their backups after a reinstall.

### After reinstall — what restore sees

The reinstalled PC is a fresh OHD install, so its `_machineId` is a brand new UUID. The hostname is whatever the operator named it during Windows setup:

- **Same hostname as before** (recommended workflow): the old subfolder is still there. Restore Settings UI defaults to listing `<backupFolderPath>/<hostname>/` and shows the previous machine's backups. The `machineId` mismatch is *expected* here — restore is an explicit operator action, not an automatic write, so the collision check does not apply on restore. The first post-restore backup write triggers the collision check above; the operator sees the error, recognises the machineId mismatch is from the old install they're recovering from, and clicks "Take over this folder" in the UI which deletes the existing `latest.json` and proceeds.
- **Different hostname** (replacement PC was renamed): the operator uses the "Restore from Backup..." dialog's "Browse other machines" option, which lists all sibling subfolders under `<backupFolderPath>/`, picks the old hostname's folder, and picks a file from it. No collision will occur because they're writing into the new hostname's folder going forward.

### Settings UI affordances

- The Settings panel shows the current machine identity: *"This PC: `LAB-PC-01` (id: `9b1c2e…`)"*. Useful for support diagnostics; click-to-copy.
- When listing restorable backups, default to this hostname's subfolder. Provide a "Browse backups from other machines" link that opens a list of sibling subfolders.
- On collision error, the resolution UI offers two buttons:
  - **"Take over this folder"** — deletes the existing `latest.json` and timestamped backups, writes a fresh one. Confirm dialog warns that the previous machine's backups in this folder will be lost. Use this when the existing backups are from a PC that no longer exists.
  - **"Choose a different folder"** — opens the folder picker. Use this when both PCs are still alive.

### Tests for multi-machine isolation

Add to `backup-service.test.js`:

- Two simulated machines (different `machineId`, different hostname) writing to the same root: both succeed, each in its own subfolder.
- Two simulated machines with same hostname, different `machineId`: second write returns `{ok:false, reason:'hostname-collision'}`.
- Same hostname, same `machineId` (same PC re-running): overwrites cleanly.
- Restore from a backup whose `machineId` differs from current install: succeeds (no collision check on restore path).
- "Take over folder" action: deletes prior backups for that hostname, then write succeeds.

---

## Network drives — explicit handling

The primary deployment target for `backupFolderPath` is a UNC share on a NAS or file server (`\\NAS\OHD-Backups\`). Local paths and mapped drive letters work too, but with caveats.

### Accept three path shapes

- **UNC** (`\\server\share\path`) — preferred, works in all sessions including launch-on-startup.
- **Local** (`D:\Backups\OHD`) — works; same code path.
- **Mapped drive letter** (`Z:\Backups`) — works *if* the drive is mounted in the current session. Risky for launch-on-startup configs.

In the Settings UI, when the configured path matches `/^[A-Za-z]:[\\\/]/` and the resolved path's volume is a remote drive (`fs.statfs` or `os.networkInterfaces` heuristic — or just always show the hint for any drive letter that isn't `C:`), surface a non-blocking hint:

> "This looks like a mapped network drive. UNC paths (`\\server\share\...`) are more reliable, especially if OHD is set to launch on startup."

### Path validation on save

Before persisting `backupFolderPath`, the IPC handler must:

1. Resolve the path (`path.resolve`).
2. Recursively create the hostname subfolder (`fs.mkdir({recursive: true})`).
3. Write a probe file (`.ohd-write-test` containing a UUID), `fs.fsync`, read it back, delete it.
4. Surface specific errors:
   - `ENOENT` → "Path not found. If this is a UNC path, check the share is accessible."
   - `EACCES` / `EPERM` → "Permission denied. Check share permissions for this PC's user account."
   - `EROFS` → "Share is read-only."
   - Anything else → raw error message.

Do not save the path if probe fails. Settings UI shows the error inline next to the field.

### Atomic write — SMB rename fallback

The base path is `.tmp` + `fs.rename`. SMB occasionally throws `EPERM`/`EBUSY` on rename even when nothing has the file open (same family as the historical libvips/sharp EPERM bug on Synology shares).

```javascript
async function atomicWrite(destPath, contents) {
  const tmpPath = destPath + '.tmp';
  await fs.writeFile(tmpPath, contents);
  try {
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    if (['EPERM', 'EBUSY', 'EXDEV'].includes(err.code)) {
      // SMB rename flake or cross-volume — fall back to copy + unlink
      await fs.copyFile(tmpPath, destPath);
      await fs.unlink(tmpPath).catch(() => {});  // best-effort cleanup
    } else {
      // EACCES, ENOENT, etc — clean up and re-throw
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
```

### Orphan `.tmp` cleanup

If the PC loses power or the network drops mid-write, a `.tmp` file is left on the share. At the **start** of every `runBackup`, scan the hostname subfolder for `*.tmp` files older than 1 hour and unlink them. Idempotent; errors logged but non-fatal.

### IPC timeout

`runBackup` must complete within 60 seconds. Writing 150KB to a saturated VPN share can take 10+ seconds in the wild; 60s gives generous headroom without hanging the UI forever. On timeout: cancel the in-flight write, clean up the `.tmp`, return `{success:false, error:"Backup timed out — share may be slow or unreachable"}`.

### Credentials on the share — out of scope

OHD inherits the current Windows user's credentials. If the share requires explicit auth, the operator handles it via Windows Credential Manager. Do **not** add a username/password field to the backup settings UI. If we ever need this it'll be a separate piece of work.

### Folder picker

Electron's `dialog.showOpenDialog({properties: ['openDirectory']})` on Windows accepts UNC paths typed into the location bar but you can't click-pick them from the tree. So:

- Provide a **manual text input** for `backupFolderPath` (operator can paste a UNC).
- Provide a **Browse** button that opens the native picker (for local + mapped drives).

Either path goes through the same validation logic above.

---

## Edge cases worth handling

- **Network share unreachable at backup time:** retry once after 5s, then log + set `backupLastError`. Don't keep retrying — the next trigger (launch or first-save-of-day) will pick it up.
- **Network share unreachable at restore time:** error surfaces in the file picker; nothing else to do.
- **Backup folder is a local path** (operator picks `D:\Backups\` instead of UNC): works the same way. Hostname subfolder still applies.
- **Two PCs misconfigured to the same folder:** hostname subfolders prevent collision. The list-backups view should still only show the current host's subfolder by default.
- **Empty `backupFolderPath` but `backupEnabled=true`:** treat as disabled; do not crash. Surface "Configure backup folder to enable" in the UI.
- **Disk full on local path:** atomic write fails → error captured in `backupLastError`.
- **Operator hand-edits the backup file:** restore validates the envelope shape (`backupSchemaVersion` is a number, `stores.config` is an object, etc.) and refuses with a clear error if it's malformed.

---

## Out of scope for v1

These are good follow-ups but not part of this PR:

- Encrypted backups with a user passphrase (to safely include secrets).
- Backup history viewer with diff between snapshots.
- One-click "promote this backup to all other PCs in the lab".
- CLI `--restore <path>` flag for installer scripting.
- Scheduled time-of-day picker (the current "first launch when stale" logic is intentional).

---

## Acceptance checklist

- [ ] Settings panel section renders, checkboxes persist, "Backup Now" produces a file.
- [ ] Backup file written atomically to `\\share\<hostname>\ohd-backup_<host>_<ts>.json` plus `latest.json`.
- [ ] Secrets are `null` and `redactedKeys` is populated.
- [ ] Customer directory opt-out works both directions.
- [ ] Daily trigger fires on app launch when last backup > 24h.
- [ ] Retention keeps newest 30, never deletes `latest.json`.
- [ ] Restore preview shows source metadata, redacted keys, and section checkboxes.
- [ ] Restore writes only to selected store files, forces relaunch.
- [ ] Backup failures never break `config-service.save()`.
- [ ] All tests in the test plan pass.

---

## Files touched

```
src/main/services/backup-service.js                    NEW
src/main/services/__tests__/backup-service.test.js     NEW
src/main/services/config-service.js                    MODIFIED (schema + save())
src/main/index.js                                      MODIFIED (launch trigger)
src/main/ipc-handlers.js                               MODIFIED (new channels)
src/preload/preload.js                                 MODIFIED (expose channels)
src/renderer/settings/backup-panel.js                  NEW (or wherever Settings UI lives)
src/renderer/settings/restore-dialog.js                NEW
docs/backup-restore.md                                 NEW (operator-facing how-to)
```
