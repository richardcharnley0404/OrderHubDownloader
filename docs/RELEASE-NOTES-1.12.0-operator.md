# OrderHub Desktop v1.12.0 — what's changed

Download: **[paste S3 link here]**

A small update. Most of it you won't notice — one fix, and one new
capability that stays switched off until we turn it on with you.

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

## Fixed — Darkroom Pro controllers that wouldn't save

If you use a Darkroom Pro printer, you may have hit a point where the
controller refused to save, with a message about a **Paper Type Option
Key**. Once it started, nothing about that controller could be changed —
including the auto-print tick — and pressing **Save & Assign** on a job
failed with the same message even though the job itself was fine.

That's fixed, and there's now a way out if you're still stuck:

1. Go to **Settings → Routing** and edit the Darkroom Pro controller.
2. Next to **Paper Type Option Key** you'll see a new **Clear media
   translations** button. Click it.
3. Click **Save**.

Nothing is deleted until you press Save, and Cancel still discards.

**Which settings are correct?** If your lab doesn't sell a paper-type
choice (lustre, gloss, matte and so on), then the Paper Type Option Key
**and** the Media Translations list should both be empty. One without the
other doesn't do anything useful, and the app now stops you creating that
combination by accident.

While assigning a job, the option to save a media translation now only
appears when the controller actually has a Paper Type Option Key set —
previously it could be offered when there was nothing sensible to save,
which is how controllers got into the stuck state in the first place.

## New — sending a whole order as one job (Fuji PIC Pro)

**This is switched off. Nothing changes for you unless we turn it on
together.**

If you print on a Fuji PIC Pro, we can now send every job in an order to
the printer as a **single submission**, with different print sizes in the
same order, instead of one submission per job. That stops a customer's
order arriving at the printer as three or four separate pieces of work.

Two things to know before we enable it:

**Orders wait for all their jobs.** If one job in an order isn't ready —
still downloading, held for review, flagged by quality checking — the
whole order waits. The job row will say **"Waiting for order — 1 of 3
jobs missing"** and hovering it tells you which. Nothing is lost or stuck;
it's waiting on purpose.

If you don't want to wait, press **Process** on any job in that order and
whatever is ready goes immediately.

If a job stays unready for too long (30 minutes by default, and we can
change that), the rest of the order goes anyway and the straggler follows
on its own shortly after.

**A late job arrives as a separate order.** If a job turns up after its
order has already been sent, it goes to the printer on its own with a
number like **ORD-1234-2**. That's deliberate — it's the same order, just
a second delivery, and it's the only safe way to avoid overwriting the
first one.

If you'd like this turned on, just ask and we'll set it up with you while
you watch the first order go through.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab
is the quickest place to spot the cause.
