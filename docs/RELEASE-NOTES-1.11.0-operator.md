# OrderHub Desktop v1.11.0 — what's changed

Download: **[paste S3 link here]**

This update covers several releases at once, so there's a bit more in it than
usual. Nothing needs configuring — everything below either happens
automatically or is switched off until you turn it on.

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

## Two things you'll notice straight away

**A red banner when you launch, if any of your channel mappings are missing a
Print Size.** Mappings created before July 2025 may not have one, and jobs
routed through them fail at dispatch. The banner tells you how many are
affected; click through to Settings → Routing, and each one has an **Edit**
button to add the missing size. Fix them and the banner stops appearing.

If you don't see the banner, nothing's wrong — you have nothing to fix.

**The Polling Interval box in Settings is now greyed out.** It's set centrally
by OrderHub now rather than per-PC. If you need it changed, contact us and we
can do it without you reinstalling anything.

## What's new

**A Retry button on failed jobs.** Previously a job that failed to dispatch was
stuck for good. Now you can fix whatever caused it — a printer offline, a
network drop, a missing setting — and click **Retry** to put it back in the
queue.

**Fix mapping.** When a job fails because its channel mapping is incomplete,
the job row now offers a button that takes you straight to the mapping that
needs correcting, instead of hunting for it in Settings.

**Splitting large jobs (Darkroom Pro).** You can now set a maximum number of
prints per job on a Darkroom Pro controller. Anything larger is held for you to
release, and when you press Process it's sent as several smaller orders instead
of one big one — so an urgent job isn't stuck behind a 600-print order.

This is **off by default**. Nothing changes until you set a limit under
Settings → Routing → your Darkroom Pro controller. If you'd like it set up,
just ask.

**Lighter on the network.** OrderHub Desktop now talks to the server far less
often, which makes everything a bit quicker and steadier. You shouldn't notice
anything except that it feels snappier.

One consequence worth knowing: when a job is completed or cancelled in
OrderHub, it can take up to five minutes to disappear from Awaiting Processing,
rather than one. That's deliberate.

## If you import orders from XML

Ship-to names now come through properly. Previously the delivery address on
marketplace orders (Etsy and similar) showed the marketplace name rather than
the person receiving the parcel. The recipient's name is now passed to
OrderHub, so delivery addresses, packing slips and carrier labels all show the
right person.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab is the
quickest place to spot the cause.
