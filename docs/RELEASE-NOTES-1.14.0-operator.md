# OrderHub Desktop v1.14.0 — what's changed

Download from **OrderHub → Settings → Info**.

This update rolls up everything since **v1.12.1**, so there's more in it than
usual. Most of it you won't notice. One item needs your attention if you use a
Darkroom Pro printer with a print limit set — that's first below.

## Installing

Windows will warn you that the publisher is unknown. That's expected — our
installer isn't code-signed.

1. **"Windows protected your PC"** → click **More info** → **Run anyway**
2. **"Do you want to allow this app…"** → click **Yes**

Close OrderHub Desktop before installing. Your settings, controllers and
channel mappings are all preserved.

---

## Please read — large jobs have not been waiting for review

If you set a **Maximum prints per job** limit on a Darkroom Pro controller, the
intention was that any job over that limit would be held for you to look at
before it went to the printer.

**That hold has not been working since 10 August.** Jobs over the limit were
still split into separate orders correctly, but they went straight to the
printer without waiting for you. Confusingly, the job row still showed a
"Large job — review required" flag, so on screen it looked like the job was
waiting when it had already gone.

This is fixed. From now on an over-limit job stays in Awaiting Processing until
you press **Process**.

**Worth doing once after you upgrade:** if you've had a print limit set at any
point since 10 August, have a look back through your printer queue for large
orders you didn't expect to see there. Nothing was lost or duplicated — they
were printed rather than held — but you may have had jobs go through that you'd
have wanted to schedule differently.

We're sorry about this one. The flag on screen said the job was waiting, which
is exactly the wrong thing to be wrong about.

---

## New — send large jobs automatically (Darkroom Pro)

If you'd rather *not* review large jobs, there's now a **Send batches
automatically** tick beside the Maximum prints per job box in
**Settings → Routing**.

With it ticked, an over-limit job is split and sent without waiting for you —
useful if you don't want to keep OrderHub Desktop in view all day. With it
unticked (the default), large jobs wait for you as described above.

Either way the job still arrives at the printer as several separate orders, so
you can still reorder them there.

## New — splitting large jobs on the Epson Order Controller

The Epson controller now has the same **Maximum prints per job** limit and
**Send batches automatically** tick that Darkroom Pro has. Set a limit and an
over-limit job is sent as several smaller orders instead of one large one.

**This changes the folder name for split jobs only.** A normal job's folder
name is exactly what it has always been. A split job's folders gain a batch
marker so you can tell them apart at a glance:

```
o38461218_PXDEMO-5LGAKK-1_1of2_4x6 Photo Print
o38461218_PXDEMO-5LGAKK-1_2of2_4x6 Photo Print
```

Other things worth knowing:

- **Each batch gets its own banner sheet** if you have banner sheets switched
  on, and the banner shows which batch it is — e.g. *(2 of 5)*. Since batches
  can be printed at different times, a banner on the first one only would leave
  the rest unlabelled in the output stack.
- **The job is only marked complete when every batch has been accepted** by the
  printer. If one batch fails, the job is flagged with which one, and there's a
  **Resend batch** button that re-sends just that batch — not the whole job, so
  you don't get duplicate prints of the batches that already went.
- The print limit counts customer prints, not banner sheets, so a limit of 20
  puts 21 sheets through per batch when banners are on.

This is off by default. Nothing changes until you set a limit.

## New — collecting files from an FTP server

**Settings → Downloads** has a new **FTP Sources** section. This is for ad-hoc
files that have nothing to do with print jobs — Labworks XML and similar.

Each source has a name, its own FTP login (separate from the connection on the
Connection tab), a folder on the server, a folder to put the files in (local or
a network share), and how often to check in minutes.

Files are **moved**, not copied — once a file is safely on your disk it's
removed from the server. You can turn that off per source if something else
needs the file too.

Two things to know:

- There's a **Test connection** button. Use it when setting a source up — most
  problems are a wrong password or a wrong folder, and it's much better to find
  that out now than to wonder later why nothing arrived.
- If a file with the same name is already at the destination, it is **left
  alone** and the new one is skipped rather than overwriting it.

These files never become print jobs and never appear in the Jobs list. They're
just moved.

## Shorter order numbers on the printer (Fuji PIC Pro)

Order numbers arrive with a prefix — `DIVPRINTS-`, `PXDEMO-` and so on — and PIC
Pro's order column often isn't wide enough to show the whole thing.

There's now a **Strip order number prefix** box on the Fuji PIC Pro controller
in **Settings → Routing**. Type your prefix into it and orders appear on the
printer as `Q22WT9` instead of `DIVPRINTS-Q22WT9`. Leave it empty and nothing
changes.

Orders already in the printer queue keep the name they were sent with, so for a
short while you may see both forms.

## Tidier screens

- The **Order XML** tab is now hidden unless you actually use Order XML hot
  folders. You can still switch the feature on under **Settings → Order XML**.
- Tick boxes throughout the settings screens now line up properly with their
  labels, and the flags on the Jobs list stack instead of pushing the table
  sideways.

## Anything looks wrong?

Send us a screenshot and roughly when it happened — the Activity Log tab is the
quickest place to spot the cause.
