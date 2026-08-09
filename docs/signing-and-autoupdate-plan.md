# Signed releases + live auto-update — what it takes

**Status:** investigation / plan. Nothing built.
**Date:** 2026-08-06 · **Against:** `main` @ v1.8.0

---

## Headline

These are two separate things and they're worth very different amounts.

**Auto-update is the real prize, and it's about 90% built already.** The code
path in `src/main/updater.js` is complete and correct. What's missing is
operational: no `latest.yml` has ever been uploaded, and the `/checkin`
`download_url` points at the exe rather than the directory containing it. That
is roughly **a day of work** to switch on — plus a few days of safety guards
you genuinely want before pointing it at live labs (§3).

**Signing is worth doing, but it is not the "approved" switch you're
picturing.** Microsoft changed the rules in 2024: **EV certificates no longer
grant instant SmartScreen bypass**, and every non-Store option now works on a
reputation-accrual model. There is no certificate you can buy that makes the
warning disappear on day one.

But here's the part that makes it worth doing anyway, and it's the single most
important fact in this document:

> "Signing files using a trusted certificate can allow certificate reputation
> to build, potentially avoiding warnings on new files signed by the same
> trusted certificate. **Unsigned files must build reputation anew with every
> update.**"
> — [Microsoft, SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

Right now you are in the worst possible state: **every release starts from zero
reputation, forever.** v1.8.0 is as untrusted as v1.0 was. Signing consistently
with one Pixfizz certificate is what lets trust accumulate across releases
instead of resetting every time.

**And the two interact in your favour:** once auto-update is live, SmartScreen
largely stops mattering. SmartScreen fires on *browser* downloads via Mark-of-
the-Web. `electron-updater` fetches the installer programmatically — no MOTW,
no SmartScreen prompt. Signing then only matters for the **first** install at a
**new** lab.

**Recommended order: auto-update first, signing second.**

---

## 1. Auto-update — what already exists

`src/main/updater.js` is in better shape than the release docs imply:

- Runs on startup, then every **4 hours** (`startUpdateSchedule`), gated on
  `pollingEnabled` so upload-only boxes stay quiet.
- `POST {baseUrl}/checkin` sends `instance_id`, `organisation_id`,
  `location_id`, `machine_name`, `current_version`.
- If the response has `is_up_to_date: false` **and** a `download_url`, it calls
  `autoUpdater.setFeedURL({ provider: 'generic', url })` then
  `checkForUpdates()`.
- `autoDownload = true`, `autoInstallOnAppQuit = true`.
- On `update-downloaded`: pushes `app:updateReady` to the renderer (header
  badge) **and** shows a modal dialog — "Restart Now" / "Later", or forced
  restart when `info.isMandatory`.
- All failures are non-fatal and logged. Never blocks startup.

There's even an `isMandatory` path already wired, which is the hook you'd want
for a forced security release.

**What's missing is entirely on the ops side.**

---

## 2. Switching auto-update on — the actual steps

### 2.1 Upload three files, not one

Today `docs/RELEASE.md` §6 says upload the `.exe` only, and explicitly says
*don't* upload `latest.yml`. That flips. Every release now publishes:

| File | Why |
|---|---|
| `OrderHub Desktop Setup {version}.exe` | the payload |
| `OrderHub Desktop Setup {version}.exe.blockmap` | **differential updates** — without it every lab re-downloads all 576 MB every release |
| `latest.yml` | the manifest the generic provider actually reads |

**Order matters: exe → blockmap → `latest.yml` last.** A lab checking in
mid-upload then either sees the old manifest (skips) or a new manifest pointing
at a file that has finished uploading. The reverse order leaves a window where
the manifest points at a half-uploaded exe.

The blockmap is the difference between a ~576 MB download per lab per release
and typically a few tens of MB. At any meaningful number of labs this is also
your S3 egress bill.

### 2.2 Fix `download_url` (OrderHub server side)

The generic provider appends `/latest.yml` itself. `download_url` must be the
**directory** the artifacts live in, not the exe. This is a change in the
OrderHub `/checkin` response, not in OHD.

### 2.3 Nail down the S3 location

`docs/RELEASE.md` §6 carries a `TODO(richard)` for the exact bucket and prefix,
and `electron-builder.yml`'s `publish.url` is still the placeholder
`https://your-s3-bucket.s3.amazonaws.com/ohd/`. Both want resolving so the
manifest, the upload target and the check-in response can't drift apart.

### 2.4 Check the logs first

From `docs/BACKLOG.md` — if `/checkin` is *already* returning
`is_up_to_date: false` plus a `download_url`, then every install has been
fetching a 404 `latest.yml` and logging `Auto-updater error` every 4 hours,
possibly for months. **Grep the lab's `app.log` for that string before you
change anything** — it tells you whether the server side is already half-wired.

---

## 3. The five things that will bite you

These are why I'd budget a few days beyond "upload three files", not because
the wiring is hard but because auto-updating a **production print lab** is a
different risk class from auto-updating a text editor.

### 3.1 Restarting mid-job (the one I'd worry about most)

`quitAndInstall()` will happily restart the app during an active dispatch or a
film-scan upload. You already have history here: the half-open-socket bug that
pinned a roll at `uploading` forever. An update-triggered restart mid-upload is
the same failure shape, self-inflicted, at every lab simultaneously.

**Guard needed:** refuse to prompt or restart while jobs are in flight or a
film-scan upload is running. Defer to the next quiet window. This is new code —
and it's the piece I'd least want to skip.

### 3.2 Per-machine installs mean a UAC prompt nobody clicks

`electron-builder.yml`'s `nsis` block sets `oneClick: false` and
`allowToChangeInstallationDirectory: true` but doesn't set `perMachine` — and
`RELEASE.md` §7 tells operators to expect a UAC prompt on install, which
suggests at least some labs installed for all users into Program Files.

If so, `quitAndInstall` needs elevation, and an unattended lab PC gets a UAC
dialog nobody is there to accept. The update silently never applies.

**Verify what install mode the existing labs actually used before switching
anything on.** Per-user installs (`%LOCALAPPDATA%\Programs`) update silently;
per-machine ones don't.

### 3.3 Lab PCs never quit

`autoInstallOnAppQuit = true` assumes the app quits. A lab machine runs for
weeks. The current dialog needs a human to click "Restart Now". If nobody's at
the screen, the modal just sits there — arguably worse than not updating, since
it's a modal over the UI.

Options: a scheduled quiet-hours restart, or lean on the existing `isMandatory`
flag for releases you actually need everywhere.

### 3.4 Every lab at once, with no rollback

Today a bad build reaches one lab at a time, at their pace. With auto-update it
reaches all of them within 4 hours, and **there is no downgrade path** — the
updater only goes forwards.

The good news: your architecture already solves this better than most. Because
`/checkin` is server-side and per-install (it knows `organisation_id`,
`location_id`, `instance_id`), **OrderHub can decide per lab whether to return
`is_up_to_date: false`.** That's a staged-rollout lever most auto-update setups
don't have. Use it: one canary lab, then the rest.

### 3.5 The 4-hour window

A `/checkin` at 09:00 in a busy lab that then downloads 576 MB (or a diff) will
compete with artwork downloads on the same connection. Worth confirming
`autoDownload = true` is what you want, or whether download should also respect
a quiet window.

---

## 4. Signing — what it actually buys in 2026

### What changed

| Option | Cost | SmartScreen |
|---|---|---|
| Microsoft Store (MSIX) | free | **No warnings, ever** |
| Azure Artifact Signing | ~$9.99/mo | Reputation builds over time |
| OV certificate | $150–300/yr | Reputation builds over time |
| EV certificate | $400+/yr | **Same as OV since 2024** — no longer worth the premium |
| Unsigned (today) | £0 | Resets to zero **every release** |

The Store is the only zero-warning path, and it isn't realistic here — a B2B
lab tool that writes to SMB hot folders is not a Store app.

So the honest position is: **signing doesn't remove the warning, it stops the
warning from resetting.** Combined with auto-update (which skips SmartScreen
entirely), that's enough.

### What signing changes immediately, on day one

Even before reputation accrues:

- The **UAC prompt** flips from orange *"unknown publisher"* to blue
  *"Verified publisher: Pixfizz Ltd"*.
- The SmartScreen prompt, when it appears, **names you** rather than saying
  unknown.

For a lab operator being asked to install software that talks to their
production minilab, that difference is not cosmetic — it's most of the trust
conversation.

### Azure Artifact Signing (formerly Trusted Signing)

`scripts/sign.js` is **already written for this exact service** and already
referenced from `electron-builder.yml` as `win.signtoolOptions.sign`. It reads
six `AZURE_*` env vars and skips cleanly when they're absent — which is why
every build to date logs `[sign.js] Azure Trusted Signing env vars not set`
four times and succeeds unsigned.

So the code work is close to zero. The work is account setup:

1. **Paid Azure subscription** — pay-as-you-go or EA. Free/trial/sponsored
   subscriptions are explicitly not supported.
2. **Organisation identity validation.** Pixfizz Ltd being UK-based is fine —
   orgs in the US, Canada, EU and UK are eligible.
3. **⚠ The likely blocker: the business must be older than three years**, with
   documentation to prove it. Worth confirming Pixfizz Ltd clears this before
   spending time on anything else — it's the most common rejection.
4. Create the signing account + certificate profile, note the endpoint region,
   assign roles, then populate the six env vars locally (or in CI).
5. `npm install --save-dev @azure/trusted-signing-cli`.

Practical notes: signing takes roughly 5 seconds per file with no
parallelisation, and there are four files per build (main exe, `elevate.exe`,
uninstaller, installer) — so ~20 seconds added to a build that already takes
minutes. Certificates are short-lived (3 days) but signatures are timestamped
and remain valid indefinitely.

### One thing to be careful about

Reputation attaches to the **publisher identity**. If you ever change signing
identity — different CA, different account, a renewed cert under a different
subject — **reputation resets**. Pick one route and stay on it. That's an
argument for Azure over a cheap OV cert you might not renew.

---

## 5. Suggested sequencing

| Step | Work | Why first |
|---|---|---|
| **0** | Grep lab `app.log` for `Auto-updater error` | Free. Tells you whether `/checkin` is already half-wired and spamming 404s. |
| **1** | Confirm per-user vs per-machine install mode at existing labs | Free, and it determines whether §3.2 is a blocker or a non-issue. |
| **2** | Start Azure Artifact Signing onboarding | Validation has a lead time and may fail on the 3-year rule. Start it early, in parallel, then forget about it until it lands. |
| **3** | Build the mid-job restart guard (§3.1) | The one genuinely new piece of code, and the one that protects production. |
| **4** | Publish exe + blockmap + `latest.yml`; fix `download_url` to a directory | The actual switch-on. ~1 day. |
| **5** | Canary one lab via `/checkin`, then widen | Uses the per-install lever you already have. |
| **6** | Wire the `AZURE_*` env vars, ship the first signed release | Reputation starts accruing from here and never resets again. |

Steps 0–1 cost nothing and might change the plan. I'd do them before anything
else.

---

## 6. Corrections needed in `docs/RELEASE.md`

Two statements in §7 are now wrong and will mislead whoever reads them next:

> "Signed releases … will remove the SmartScreen warning but not the UAC
> prompt."

Both halves are off:

- Signing **will not** remove the SmartScreen warning — since the 2024 change,
  nothing does except the Store. It makes reputation *transferable across
  releases*, which is the actual benefit and a different claim.
- Signing **does** change the UAC prompt — not removing it, but flipping it
  from "unknown publisher" to "Verified publisher: Pixfizz Ltd".

§6's "Do not upload `latest.yml`" also inverts the moment auto-update goes
live, and the blockmap needs adding to the upload list.

---

## Appendix — evidence

Verified against the working tree on 2026-08-06:

- `src/main/updater.js` — full check-in + `setFeedURL` + `checkForUpdates` path; `autoDownload`/`autoInstallOnAppQuit` both true; `isMandatory` handling present
- `scripts/sign.js` — Azure Trusted Signing CLI hook, six env vars, skips silently when unset
- `electron-builder.yml` — `win.signtoolOptions.sign: scripts/sign.js`; `nsis` has no `perMachine`; `publish.url` still the `your-s3-bucket` placeholder
- `docs/RELEASE.md` §6, §7 and "Auto-update is dormant"; `TODO(richard)` for bucket/prefix
- `docs/BACKLOG.md:66–79` — dormant auto-update, the predicted 404 error-spam side effect, the `TODO(richard)`

External, current as of 2026-08-06:

- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) — publisher vs hash reputation; unsigned files rebuild reputation every update
- [Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) — pricing tiers; EV no longer bypasses SmartScreen since 2024
- [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) — paid-subscription requirement, identity validation, reputation behaviour
- [Fighting through Setting up Microsoft Trusted Signing](https://weblog.west-wind.com/posts/2025/Jul/20/Fighting-through-Setting-up-Microsoft-Trusted-Signing) — practical onboarding gotchas, ~5s per file signing time
