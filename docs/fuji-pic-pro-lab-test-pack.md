# OrderHub Desktop 1.8.0 — Fuji PIC Pro test pack

**For the lab testing PIC Pro support. Please read the first page before installing.**

---

## What this is

OrderHub Desktop 1.8.0 adds support for sending print jobs to **Fuji PIC Pro**. Until now
OHD could only reach PIC Pro by dumping images into a folder — you had to build the order
in PIC Pro by hand. This version creates the order for you.

**This has never run against a real PIC Pro.** It was built from Fujifilm's own order.txt
specification and tested against simulated folders. You are the first real installation.
Nothing here will damage anything — worst case an order doesn't build and you do it the old
way — but please don't put it in front of live customer work until you've run the test order
below.

Two things are deliberately **off by default**, and we'd like them left off for the first
few orders:

- **Auto Print** — OHD won't send anything until you press Process on a job.
- **Send [release] command** — OHD builds the order in PIC Pro but doesn't print it. You
  print from the PIC Pro console as normal. This is the safety catch: it means you see the
  order before any paper moves.

### Installing

The installer isn't code-signed, so Windows will show a blue **"Windows protected your PC"**
box. Click **More info** → **Run anyway**. That warning is expected and not a sign of a
problem.

---

## Before you start — four things we need from you

Please send these back before or with your first report. Nothing can be configured without
the first three.

**1. Your three PIC Pro folder paths.** Open `OrderGateway.exe` on the labserver and note:

- the **Order Data** folder it's watching (often `D:\Order Data`, but it's configurable)
- your **DIGIN** folder (may be `DIGIN`, `DIGIN1`, `DIGIN2`…)
- your **Merge Data** folder

**2. Is "Container Path Use Subdirs" ticked** in OrderGateway? It's a checkbox in the same
config screen. Either answer is fine — we just need to know which.

**3. A few print codes from your code table.** These are the codes PIC Pro uses for print
sizes/packages — whatever you'd normally type as `Code=`. Two or three examples with what
size each one produces is plenty.

**4. Your PIC Pro version number.** From Help → About, or the title bar.

---

## Setting up

### Step 1 — Add the controller

Settings → Routing → **Add Controller**. Set **Type** to **Fuji PIC Pro**, then fill in:

| Field | What to put |
|---|---|
| **Name** | Anything you'll recognise, e.g. "PIC Pro" |
| **Image Staging Root** | A **new empty folder** you create for this — OHD's own workspace. Put it on the **same drive as DIGIN**. It must not be inside Order Data, DIGIN or Merge Data. |
| **Order Data Path** | Your Order Data folder from above |
| **DIGIN Path** | Your DIGIN folder |
| **Merge Data Path** | Optional — leave blank for the first test |
| **Back Print Mode** | None for now |
| **Gateway Timeout** | Leave at 120 seconds |
| **Build Timeout** | Leave at 30 minutes |
| **Send [release] command** | **Leave unticked** |
| **Include Customer Name** | Leave unticked |
| **Auto Print** | **Leave unticked** |

If it refuses to save saying paths overlap, that's deliberate — the staging folder must be
separate from the other three. Move it and try again.

### Step 2 — Map one product

Take a simple product you print often — a 6×4 or 5×7, single image, nothing fancy.

Find a job for that product in the Jobs list and click **Assign Channel**. Fill in:

- **Print Code** — the code from your table for that size
- **Print Size** — the physical size as `6x4` or `5x7`. This is *not* sent to PIC Pro; it
  only tells OHD what shape to crop to.
- **Colour** — leave as C unless it's a black-and-white product
- **Surface** — your paper surface name

Save.

---

## The test order

Use a **small order — two or three images**. Ideally one with a quantity of 2 or more, and a
mix of portrait and landscape.

Press **Process** on the job, then watch the three folders. You should see, over a few
seconds:

1. A file called something like `ORD-XXXXXX-1.txt` appears in **Order Data**
2. It **disappears** (OrderGateway has read it)
3. A folder with that same name appears in **DIGIN**, containing `0001.jpg`, `0002.jpg`…
4. Both clear as PIC Pro builds the order

Then open the order in PIC Pro and check it against the list below.

### What we need you to check

Please tick or cross each one — this is the most useful thing you can send back.

- [ ] The order appeared in PIC Pro at all
- [ ] The order number looks right / is acceptable to PIC Pro
- [ ] Every image is there, in the right order
- [ ] **Quantities are correct** (the one with qty 2 shows as 2, not 1)
- [ ] Images are cropped to the right shape — not squares, not squashed
- [ ] The print code came through and the size is right
- [ ] Nothing was left behind in the staging folder

Then, if it all looks right, **print it from the PIC Pro console** and check the physical
prints.

---

## If something goes wrong

Nothing here is dangerous, and none of it affects your existing printers or workflows. The
useful thing is to tell us *where* it stopped.

**The `.txt` never appeared in Order Data** — OHD didn't get that far. Check the job in OHD;
it'll show an error message.

**The `.txt` appeared but never disappeared** — OrderGateway isn't running, or it's watching
a different folder than the one you gave us. After two minutes OHD gives up, tidies the file
away, and flags the job. This is the single most likely thing to go wrong, and it's a
configuration issue rather than a bug.

**The `.txt` disappeared but no images arrived in DIGIN** — this one we'd want to know about
urgently. Please send the logs.

**The order built but something's wrong with it** — wrong sizes, wrong quantities, missing
back print, images in the wrong order. Please describe exactly what you see and send the
logs.

### Sending logs

Zip this folder and send it:

```
%APPDATA%\OrderHub Downloader\logs\
```

(Paste that into a File Explorer address bar.) It contains `app.log` and `error.log`. Please
also say roughly what time you ran the test so we can find it.

Screenshots of the PIC Pro order screen are very helpful too.

---

## Feedback form

Copy this, fill it in, send it back.

```
LAB NAME:
DATE OF TEST:
PIC PRO VERSION:
CONTAINER PATH USE SUBDIRS:   ticked / not ticked

FOLDER PATHS USED
  Order Data:
  DIGIN:
  Merge Data:
  Image Staging Root:

PRINT CODES TESTED (code = what size)

DID THE ORDER BUILD IN PIC PRO?   yes / no / partly

IF IT STOPPED, WHERE?
  [ ] .txt never appeared in Order Data
  [ ] .txt appeared but never disappeared
  [ ] .txt disappeared but no images in DIGIN
  [ ] images arrived but the order didn't build
  [ ] order built but was wrong

CHECKS
  Images all present, right order      yes / no
  Quantities correct                   yes / no
  Cropping correct (not square)        yes / no
  Print size correct                   yes / no
  Staging folder emptied               yes / no

DID YOU PRINT IT?   yes / no
IF YES, WERE THE PRINTS CORRECT?

ANYTHING ELSE — anything that looked odd, confusing, or that you had to
work around. Wording in the setup screens that didn't make sense is
useful too.


LOGS ATTACHED?   yes / no
```

---

## Later tests, once the basics work

Only worth doing after a plain order has gone through cleanly:

1. **Back print** — set Back Print Mode to Text, put something in line 1, and check it
   appears on the back of the prints.
2. **A larger order** — 20+ images, to check nothing times out.
3. **A reprint** — reprint two images from a completed job. It should appear as a *new*
   order with `-r1` on the end, containing only those two.
4. **`[release]`** — tick Send [release] command and confirm the order prints without anyone
   touching the PIC Pro console. Your Autoprint Console needs to be running for this.
5. **Auto Print** — tick it and let jobs flow through without pressing Process.

Take these one at a time and tell us how each goes. There's no hurry — we'd rather have one
clean result than five uncertain ones.

Thank you — genuinely. Testing something nobody has run before is the hard part, and
detailed feedback here saves every other lab the same trouble.
