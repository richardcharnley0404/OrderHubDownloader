# Fuji PIC Pro — live test script

Run once, on the PIC Pro machine, before any push. Everything below assumes a build
from the current `main` (23 commits ahead of `origin/main`).

---

## Before you start

Four things the code has placeholders for:

1. **The three paths** — Order Data, DIGIN, and (optionally) Merge Data, plus a staging
   root. The staging root must be a *sibling*, not inside any of the others: fix 14 now
   rejects overlapping paths at save time, so a bad combination fails with an explanatory
   message rather than silently breaking every order.
2. **"Container Path Use Subdirs"** in `OrderGateway.exe`. Only matters if you set Merge
   Data. The monitor checks both `{orderId}.con` and `{orderId}\` so either setting works —
   but knowing which lets you read the logs.
3. **Real `Code=` values** from the lab's print-code table. The golden fixture uses
   fabricated `64` / `65`.
4. **PIC Pro version** — behaviour differs at 2.5.56 (JBackprint) and 2.6.x (container
   subdirs).

Build with `npm run build`. Do not redirect the output into the repo.

---

## Setup

1. Settings → Routing → add controller, type **Fuji PIC Pro**. Fill the four paths.
   - Deliberately try setting staging = DIGIN first. It must refuse with a clear message
     (fix 14). Then set them properly.
2. Leave **Send [release] command** OFF for the first pass. You want to see the order
   appear in PIC Pro and print it by hand before letting OHD trigger it.
3. Leave **Auto Print** OFF. Dispatch manually with Process so you control timing.

## Pass 1 — build an order, no release

Use a job with a **mix of landscape and portrait** images, at least one with `quantity ≥ 2`.

1. Assign the job — the modal must require **Print Code**, **Print Size** and **Color**.
   Blank Print Size must block the save.
2. Open Job Review. The Target pill must show the real size, **not** `⚠ No size translation`.
   Crop boxes auto-orient per image.
3. Try the keyboard: press **Enter** on an image. It should approve normally now, and on a
   job with no size translation it should refuse (that was the fix-2 hole).
4. Send to Print. Watch, in order:
   - `{OrderId}.txt` appears in **Order Data**
   - it disappears (OrderGateway consumed it) — `.con` files appear in Merge Data
   - a folder named `{OrderId}` appears in **DIGIN** containing `0001.jpg`, `0002.jpg`…
   - both clear as PIC Pro builds the order
5. Open the order in PIC Pro. Check:
   - every image present, in the right order
   - **quantities correct** — this is where the Qty-vs-corrections bug lived
   - back-print shows the customer's real filename, not `0001`
   - images are cropped to the target size, not square

## Pass 2 — the failure paths

These are the ones that matter, because they're what happens on a bad day.

6. **Stop OrderGateway.exe.** Dispatch a job. The `.txt` should sit in Order Data, images
   should stay in staging, and after `gatewayTimeoutMs` the job goes to error and the
   `.txt` is cleaned up. Nothing should reach DIGIN.
7. **Restart OHD mid-handshake.** Dispatch, then kill OHD while the `.txt` is still in
   Order Data. Relaunch. The monitor should rehydrate and carry the order through — this
   is fix 4, and it's the one with no unit-test equivalent for the real electron-store path.
8. **Yank the network** (or disconnect the share) for a few seconds during the wait. The
   order must **not** advance. Pre-fix, an unreachable share read as "file gone" and pushed
   images into DIGIN early.

## Pass 3 — release and reprint

9. Turn **Send [release]** on. Dispatch. The order should print without you touching the
   PIC Pro console. Confirm the Autoprint Console is running first — `[release]` is a no-op
   without it.
10. Reprint two images from a completed job. A **new** order appears with the `-r1` suffix,
    containing only those two images, at the right quantities.

## Pass 4 — the JobMaker regression

M0 changed JobMaker too, so check it still works.

11. Open an existing Fuji JobMaker job in Manual Crop. The Target pill should now show a
    real size where it previously said `⚠ No size translation` — if the backfill found a
    `WxH` print code. If it still warns, that mapping's `printCode` isn't dimensional and
    needs a **Print Size** set by hand.
12. Dispatch a JobMaker job. It must still work with **blank** Print Size (fix 12 — the
    field is crop-only and must never block dispatch).
13. If you have both a Noritsu and a PIC Pro mapping at the same size, open the
    Crop-to-Size dropdown. You should see two distinct rows, and picking the Fuji one must
    **not** move the job to the Fuji printer.

---

## Residual risk worth knowing

**Fix 11 leaves a small window.** If OHD is killed between `writeOrderFile` returning and
`markCommitted`, the entry rehydrates with `txtCommitted: false`, OrderGateway consumes the
`.txt`, and the entry eventually times out as `failed` — images never delivered. That's a
surfaced failure rather than the silent one it replaced, so it's safe, but it's recoverable:
on rehydrate, if `txtCommitted` is false **and** the `.txt` is still on disk, the write
clearly succeeded and the flag can be set. Worth a follow-up commit; not a blocker.

**Two UI fixes have no test coverage** — the Approve gate (fix 2) and the Color input
(fix 13) are JSX/HTML with no unit-test harness in this repo. Steps 3 and 1 above are their
only verification.

**One flaky test.** `perfectlyClearClient.test.js` "stability polling" / "hard wall-clock
deadline" fail intermittently under full-suite load — a 30 ms write race, pre-existing,
untouched by this work. Re-run before believing a red suite.

---

## After the test passes

`main` is 23 commits ahead of `origin/main`, and the four docs commits from 2 Aug sit
underneath the PIC Pro work — so a plain `git push` publishes everything at once. That's
fine *if* the live test passed. If you want to push the docs sooner, move the PIC Pro
commits onto a branch first.

Then: version bump, CHANGELOG entry, `docs/print-controllers/FUJI-PIC-PRO-FORMAT.md` and an
operator guide (M8), and finally delete the old `folder_copy` "Fuji Pic Pro - Folders"
controller.
