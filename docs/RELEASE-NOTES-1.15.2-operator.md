# OrderHub Desktop v1.15.2 — what's changed

Download from **OrderHub → Settings → Info**.

The main news is that XML-imported orders now carry the shipping method
through to OrderHub, so the Shipping Methods you define there will match
what arrives. There's also one change carried forward from 1.15.1 that
matters if you use Fuji PIC Pro — read that section too.

## New — Shipping Methods match XML-imported orders

If you use PhotoFinale or ROES XML hot folders, and you use Shipping
Methods in OrderHub, this section is for you.

**Both hot folders now pass the shipping method through.** PhotoFinale has
sent `<ShippingMethod>` since day one — nothing changed on its side.
**ROES** now reads the tag too, so any ROES file with `<ShippingMethod>`
inside `<Order>` reaches OrderHub with `shipping_method` populated.

**What you need to do.** Define your Shipping Methods in OrderHub named
**exactly as they arrive in the XML** — for example `Mail`, `USPS Ground
Advantage`, `Expedited UPS (3 Day)`, `Pickup`. When an XML order arrives,
OrderHub matches the incoming string against your Shipping Methods and
attaches the matched method — no aliases needed and no per-hot-folder
mapping to keep in sync.

**Finding out what to name.** Anything that arrives without a match shows
up in OrderHub's **Unrecognised shipping names** card, so you can see the
list and add a matching method for each one. You don't need to know the
names ahead of time — process a batch and use the card.

### How the shipping cost is decided

Two behaviours, depending on whether the XML supplies a cost:

- **XML supplies no cost** (blank `<ShippingTotal>`, or the tag absent) →
  OrderHub applies the price from the matched Shipping Method and adds
  that price to the order's total. This is the ROES default and matches
  the PhotoFinale flow when no shipping total is emitted.
- **XML supplies a cost** (any number, including `0` for free shipping) →
  the XML's value wins. OrderHub does not override it.

**ROES orders now include stated shipping in the order total.** Before
this release, a ROES order with `<ShippingTotal>5</ShippingTotal>` on top
of £11.90 of prints imported as `total 11.90` alongside `shipping 5` —
two numbers, one order, and the total column read short by the shipping
figure. It now imports as `total 16.90` alongside `shipping 5`. No
action needed at your end; existing orders keep whatever total they had
at import.

**PhotoFinale is deliberately different — its order total does NOT
include shipping.** That's not an oversight, and please don't report it
as one. PhotoFinale's `total` field is a **wholesale** figure (what the
retailer owes the lab) while its shipping figure is the **retail**
amount the cardholder paid; adding one to the other would produce a
number that is neither wholesale nor retail. ROES has no
wholesale/retail split — its line prices and shipping both reflect what
the customer paid — so summing IS the right total there.

---

## Fixed — Fuji PIC Pro save no longer blocked when OHD can't confirm same-volume (from 1.15.1)

If you skipped 1.15.1, this fix is new to you and applies if you use a
**Fuji PIC Pro** printer.

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

**Since 1.15.1, the save-time check is a warning, not a block.**

- If OHD can see the two paths are on the same volume — same drive letter,
  or same `\\server\share` — save is silent as before.
- Otherwise OHD warns you at save time, in a dialog you have to acknowledge,
  saying the two paths **may** be on different volumes and if they are,
  dispatch will stop with an error. The save then proceeds.

The dispatch-time check hasn't changed: if the two paths turn out to be on
different volumes when OHD tries to move a real order into DIGIN, dispatch
stops with an error naming both paths and the job stays in Awaiting
Processing until you fix them.

**If you saw the save-time error in 1.15.0**, try Save again. If the
warning appears, that's the heads-up — check whether your two paths
really are the same volume in practice. If they are (typical for two
shares on the same lab server), acknowledge the warning and dispatch
will work fine.

---

## Coming from v1.15.0 or earlier?

If you skipped straight from 1.15.0 or 1.14.0 to 1.15.2, everything
1.15.0 added is in this release too — **Folder Copy filename templates**
with the live preview and option chips, the **destination-layout**
choice, and **order-number prefix rules** (a list, with optional
replacement, on both PIC Pro and Folder Copy). See
`docs/RELEASE-NOTES-1.15.0-operator.md` for the full write-up.

---

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab is
the quickest place to spot the cause.
