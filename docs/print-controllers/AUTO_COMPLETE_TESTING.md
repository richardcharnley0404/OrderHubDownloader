# Staging test runbook — gated DPOF hot-folder auto-completion

> Default state: flag is OFF. Until step 1, the handler is a complete no-op (no log, no write, no API call).

## 1. Flip `autoCompleteOnPrinterAccept` to `true`

**Method A — edit `config.json`.**
1. Quit OHD completely (Windows tray menu → Quit).
2. Open `%APPDATA%\orderhub-downloader\config.json` in an editor that preserves UTF-8 *without* BOM (VS Code is fine; **avoid** Notepad and PowerShell `Set-Content -Encoding UTF8` — both add a BOM that bricks config load).
3. Add/edit:
   ```json
   "autoCompleteOnPrinterAccept": true
   ```
4. Save. Restart OHD.

**Method B — DevTools (no restart needed).**
1. Open the main window's DevTools (`Ctrl+Shift+I`).
2. Run:
   ```js
   const cfg = await window.electronAPI.getConfig();
   cfg.autoCompleteOnPrinterAccept = true;
   await window.electronAPI.saveConfig(cfg);
   ```

**Confirm:**
```js
(await window.electronAPI.getConfig()).autoCompleteOnPrinterAccept   // → true
```
or file check the JSON.

## 2. Trigger an `o→e` "accepted" event

1. Send a job to the DPOF (Noritsu/Epson) controller as usual. A folder appears in the controller's hot folder named `o<jobId>_<jobNo>_<product>_<options>` (e.g. `o38461218_PXSTAGE-XYZ-1_4x6 Photo Print_lustre_full-bleed`).
2. Note the numeric `<jobId>` immediately after the `o`.
3. Simulate printer acceptance — rename `o…` → `e…`:
   ```powershell
   Rename-Item "<hotfolder>\o38461218_PXSTAGE-XYZ-1_..." "e38461218_PXSTAGE-XYZ-1_..."
   ```
   Allow ~2 s for chokidar's poll interval (`folder-monitor.js:36`) to pick it up.

## 3. Watch the logs

Log file: `%APPDATA%\orderhub-downloader\logs\app.log` (5 MB × 5 rotation). Errors mirror to `error.log`.

Tail it:
```powershell
Get-Content "$env:APPDATA\orderhub-downloader\logs\app.log" -Wait -Tail 50
```

**Success sequence** (all INFO, in order):
```
… [INFO]: Print job status changed {"jobId":"38461218","status":"accepted","controller":"<name>"}
… [INFO]: Job DPOF accepted by printer — auto-marking as completed {"jobId":38461218}
… [INFO]: Marking job as completed {"jobId":38461218,"url":"<baseUrl>/jobs/38461218/completed"}
… [INFO]: Job marked as completed {"jobId":38461218}
```

**HTTP-level API failure** (e.g. 500):
```
… [INFO]: Job DPOF accepted by printer — auto-marking as completed {"jobId":38461218}
… [INFO]: Marking job as completed {"jobId":38461218,"url":"…"}
… [WARNING]: Failed to mark job as completed {"jobId":38461218,"msg":"HTTP 500"}
… [WARNING]: DPOF auto-complete API call failed — job left uncompleted for manual retry {"jobId":38461218,"error":"HTTP 500"}
```

**Network / non-HTTP failure** (DNS, socket, JSON parse): the `Failed to mark job as completed` line is replaced by `Error marking job as completed` plus a stack trace, then the same `DPOF auto-complete API call failed…` warning:
```
… [ERROR]: Error marking job as completed {"jobId":38461218}
  <error stack>
… [WARNING]: DPOF auto-complete API call failed — job left uncompleted for manual retry {"jobId":38461218,"error":"<message>"}
```

**Unknown jobId** (renamed a folder for a job not in OHD's local cache): single info, no warning:
```
… [INFO]: Hot folder status change for job not in local cache — ignored {"controller":"<name>","jobId":"38461218","productCode":"PXSTAGE-XYZ-1_…","status":"accepted"}
```

## 4. Verify completion

**Locally (OHD):** the job's status badge should flip to completed within a second of the success log lines. Quick check via DevTools:
```js
const local = await window.electronAPI.getJobs();
local.jobs.find(j => j.id === 38461218);
// Expected on success:
//   _dpofAccepted: true, _dpofAcceptedAt: '2026-…', _status: 'completed'
```

**In OrderHub:** open the job in the OrderHub web UI (or `GET /jobs/38461218` against the same `baseUrl`). Status should be "completed".

## 5. Expected behaviour on API failure (not a bug)

If `POST /jobs/{jobId}/completed` returns non-2xx (other than the 400 "already completed" idempotency case, which `markCompleted` writes through locally as `_status: 'completed'`):

- Job is **not** force-marked completed locally; `_status` stays at its prior value.
- `_dpofAccepted` / `_dpofAcceptedAt` **are** still written (printer-accepted is a fact regardless of the API).
- No retry — the auto-completion fires exactly once per `o→e` rename.
- Recovery: mark the job completed manually via the OHD UI (re-issues the API call), or rename the folder `e→o` and then `o→e` again to re-trigger.

This dropped-fallback behaviour is pinned by the test `flag ON, accepted + markCompleted REJECTS → no force-complete, warning fires, renderer notified` (`polling-handle-folder-status.test.js`).

## 6. Turn the flag back OFF

**Method A (config.json):** quit OHD, set `"autoCompleteOnPrinterAccept": false` (or remove the key — schema default is `false`), restart.

**Method B (DevTools):**
```js
const cfg = await window.electronAPI.getConfig();
cfg.autoCompleteOnPrinterAccept = false;
await window.electronAPI.saveConfig(cfg);
```

**Confirm OFF:** trigger another `o→e` rename and tail the log. You should see **no** `Job DPOF accepted by printer — auto-marking as completed` line and **no** `Marking job as completed` POST — the handler exits immediately at the flag gate.
