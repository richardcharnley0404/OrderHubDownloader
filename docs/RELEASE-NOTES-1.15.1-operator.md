# OrderHub Desktop v1.15.1 — what's changed

Download from **OrderHub → Settings → Info**.

**Only one thing changed in this release**, and it only matters if you use a
**Fuji PIC Pro** printer. Everything else in 1.15.0 is exactly as before —
see `docs/RELEASE-NOTES-1.15.0-operator.md` for what that release added.

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

---

## Fixed — Fuji PIC Pro save no longer blocked when OHD can't confirm same-volume

In **1.15.0**, saving a Fuji PIC Pro controller was blocked with an error
message if OHD couldn't confirm from the paths that Image Staging Root and
DIGIN Path were on the same volume. That was a mistake on our part: for two
UNC paths on the same server — for example `\\labserver1\Pixfizz Digin
Staging` alongside `\\labserver1\Digin` — OHD looks at the share names,
sees they're different, and calls it cross-volume even when the two shares
are in fact the same physical storage. A real lab with that configuration
couldn't save their controller at all, and there was no workaround (their
DIGIN path was the root of a share, so there was no other folder on that
share to move staging into).

**From 1.15.1, the save-time check is a warning, not a block.**

- If OHD can see the two paths are on the same volume — same drive letter, or
  same `\\server\share` — save is silent as before.
- Otherwise OHD warns you at save time, in a dialog you have to acknowledge,
  saying the two paths **may** be on different volumes and if they are,
  dispatch will stop with an error. The save then proceeds.

The dispatch-time check hasn't changed: if the two paths turn out to be on
different volumes when OHD tries to move a real order into DIGIN, dispatch
stops with an error naming both paths and the job stays in Awaiting
Processing until you fix them. So the flow is:

- **Save-time warning** — a heads-up if OHD can't confirm, so you can fix
  the paths before any order is dispatched.
- **Run-time enforcement** — the authoritative check; catches the case OHD
  couldn't tell from the paths alone.

**If you saw the save-time error in 1.15.0**, install 1.15.1 and try Save
again. If the warning appears, that's the heads-up — check whether your two
paths really are the same volume in practice. If they are (typical for two
shares on the same lab server), acknowledge the warning and dispatch will
work fine.

**If you're upgrading straight from 1.14.0 or earlier** and haven't
installed 1.15.0 yet, you can install 1.15.1 instead — it includes
everything 1.15.0 did, with this one behaviour softened. See
`docs/RELEASE-NOTES-1.15.0-operator.md` for the rest of the 1.15.0 content.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab is
the quickest place to spot the cause.
