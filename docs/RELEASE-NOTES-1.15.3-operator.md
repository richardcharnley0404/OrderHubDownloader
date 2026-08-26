# OrderHub Desktop v1.15.3 — what's changed

Download from **OrderHub → Settings → Info**.

This is a **hotfix release for Fuji PIC Pro labs**. If you don't use
Fuji PIC Pro, nothing in this release changes anything for you, and
you can install or skip at leisure.

If you do use Fuji PIC Pro — especially if you upgraded to 1.15.0
or 1.15.2 and found that orders stopped delivering — **please install
this release**.

## Installing

Windows will warn you that the publisher is unknown. That's expected —
our installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers
and channel mappings are all preserved.

---

## Fixed — Fuji PIC Pro delivers orders again when Image Staging Root and DIGIN Path are on different shares

Version 1.15.0 removed cross-volume delivery for Fuji PIC Pro entirely —
the change was in response to a customer bug where a mid-copy temp
folder inside DIGIN was being picked up by PIC Pro as a blank
duplicate order. The fix at the time was to require Image Staging
Root and DIGIN Path on the same volume. That worked for most labs,
but not all — and the specific case that surfaced this hotfix was a
lab with **four separate UNC shares on one server**, both DIGIN and
Image Staging Root as share roots (so no way to move Image Staging
Root "onto the same volume as DIGIN" — DIGIN is at the top of its
share). From 1.15.0 onwards their orders stalled with a "same-volume
required" error, and 1.15.1 softened the save-time check but didn't
restore delivery.

**1.15.3 supports cross-volume delivery again**, but via a different
mechanism than the one removed in 1.15.0. When Image Staging Root and
DIGIN are on different volumes, OHD now copies the staged folder into
a scratch folder inside DIGIN with a name that PIC Pro is never
going to mistake for a real order (starts with `.ohd-inbox-`, does
not contain the order code) — then atomically renames it to the
correct order id **only after** OrderGateway has consumed the `.txt`.
PIC Pro never sees the scratch folder as an order, and the delivered
folder appears atomically under the correct name matching its merge
container. No mid-copy race, no blank duplicate, no manual cleanup.

**What you should see.**

- Labs whose Image Staging Root and DIGIN Path are on the same
  volume: **no change from before 1.15.0**, delivery is a single
  atomic rename as it always was.
- Labs whose two paths are on different volumes (typical for a
  multi-share lab server): **delivery works again**. The copy is
  slower than the same-volume rename by the time it takes to move
  the images once across the network, but the folder that appears
  in DIGIN is the correct complete folder — no `.ohdtmp`, no blank
  duplicates. Save-time UI: OHD still shows the volume warning if
  it can tell for certain your two paths are on different drive
  letters or different servers (so you know delivery will be
  slower). If it can't tell — two shares on one server — save
  proceeds silently, and dispatch figures it out at run time.

**Where scratch folders go and how they clean up.** OHD writes its
scratch folder inside DIGIN itself with a distinctive name pattern —
`.ohd-inbox-{controller-id}-{instance-id}-{timestamp}-{random}`.
Once the copy completes and the order is delivered, the folder is
renamed away and gone. If a copy is interrupted mid-way (network
drop, OHD crash, whatever), the scratch folder can be left behind.
OHD sweeps its own DIGIN folder every hour and removes any
`.ohd-inbox-*` folder older than **6 hours** automatically — nothing
for you to do. If you ever need a longer window (very large orders
over a very slow link), you can override it per controller by
setting `staleInboxThresholdHours` in the controller's config
between 1 and 168.

**Confirming this works on your setup.** If you'd like to see the
scratch folder before it gets renamed away, watch the DIGIN folder
while dispatching a small test order. On cross-volume paths you'll
see an `.ohd-inbox-...` folder appear briefly during the copy, then
disappear (renamed away) as the delivered `{orderId}` folder
appears. That's the intended shape.

---

## Fixed — Fuji PIC Pro delivery failures now show as red jobs with an actionable error

Independent of the cross-volume fix above: every kind of async
PIC Pro delivery failure — the cross-volume issue from 1.15.0
onwards, permission errors on DIGIN, the DIGIN share going
unreachable mid-order, OrderGateway not consuming the `.txt`
because it isn't running, PIC Pro stalling on the build — used to
log quietly to the Activity Log while the Jobs grid kept showing
the job as "in production". If you spent hours wondering why an
order wasn't coming through with nothing telling you why, this fix
is for you.

**From 1.15.3 onwards**, an async delivery failure marks the job as
red with the specific error message: the path that failed, the
timeout that fired, what to check. You still get the full details
in the Activity Log, but you don't need to look there to know
something went wrong.

This is orthogonal to the cross-volume fix and would still be
worth doing even if cross-volume delivery weren't affected. Every
other kind of PIC Pro delivery failure benefits from it.

---

## Nothing else in this release

No changes for any other controller type. No changes for Folder
Copy, Darkroom Pro, Fuji JobMaker, DPOF, or Film Scans. XML hot
folders unchanged from 1.15.2. Everything works exactly as it did
last week — unless you're the lab whose orders had stopped
delivering, in which case you should be back in business.

---

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity
Log tab is the quickest place to spot the cause. If a PIC Pro job
goes red with the new error message, the message itself tells you
what to check — try that first, and let us know if the message
was unclear.
