# Two Checkpoints Between Upload and Print

*Marketing copy for OrderHub's DPI Check and AI Quality Inspection — draft for review.*

---

## Tagline options

- *Two checkpoints between upload and print.*
- *Resolution is one thing. Quality is another.*
- *Every photo gets a second look — before the paper does.*
- *Pixels meet perception.*
- *From file size to fit-for-print.*

---

## Sell-sheet paragraph (short)

Resolution and quality are not the same thing, and they fail in different ways. OrderHub gives you two checkpoints between the customer's upload and the printer. **At upload**, DPI checks make sure the image has enough pixels for the print size — a phone snap won't quietly become a blurry 16×20. **Before print**, our AI Quality Inspection takes a second look at every image and scores it the way a person would: sharpness, exposure, noise, focus. It catches the photos that have plenty of pixels but still look bad — the soft-focus shots, the motion blur, the heavy compression, the underexposed indoor pics. Together, they stop the prints nobody wants to pay for, refund, or reprint.

---

## The two-layer comparison

Good for a slide, a web page, or a one-pager.

### Layer 1 — DPI Check (at upload)

- **Asks:** *Are there enough pixels for this print size?*
- **Catches:** A 1000×750 phone snap routed to a canvas wrap.
- **Misses:** Anything about how the photo actually looks.
- **The catch:** customers in a hurry dismiss warnings. Some don't understand them. Some ignore them on purpose.

### Layer 2 — AI Quality Inspection (before print)

- **Asks:** *Does this image actually look good?*
- **Uses:** a perceptual quality model trained on tens of thousands of real photos.
- **Catches:** motion blur, soft focus, bad exposure, heavy noise, JPEG mush.
- **Doesn't argue with the customer** — just scores every file and holds back the ones that won't make a good print, so your operator can decide before ink and paper get committed.

---

## The "why this matters" angle (longer-form)

For a blog post, customer education page, or onboarding doc.

Most quality problems in print fulfilment fall into one of two buckets, and they have nothing to do with each other.

The first is **resolution**. You need a certain number of pixels per inch to print sharp. A 1500×1000 image looks great on a phone screen and gets blown up into a 16×20 wall print at around 75 PPI — soft, pixelated, disappointing. This is the classic problem, and it's been solved at upload time for years: every modern storefront warns the customer when their file is too small for the size they picked.

The problem is the warning isn't always heeded. Customers click through. They're in a hurry, they want the gift to ship by Friday, the message gets dismissed before it's read. By the time the order lands in your queue, you have no idea whether it was checked or just steamrolled.

The second bucket is **perceptual quality**. A photo can have all the resolution in the world and still look terrible. Out-of-focus group shots. Phone photos taken in low light, full of noise. A blurry action shot that captured the moment but not the sharpness. Selfies dominated by lens flare. None of these get caught by a DPI check, because the pixels are all there — they just don't add up to a photo anyone wants on their wall.

This is where AI Quality Inspection earns its keep. Every image that hits OrderHub gets scored before it reaches the printer. The score reflects what a person would see if they looked at it: focus, exposure, noise, contrast, overall aesthetic. Files that fall below your threshold get held for operator review instead of silently going to print. You set the bar, and the gate enforces it consistently across every order, every shift, every weekend.

The two layers together cover what neither one can cover alone. DPI is about whether the file *fits* the print. AI Inspection is about whether the file *deserves* the print. Customers will keep ignoring warnings — they always have. Now there's a backstop.

---

## Quick FAQ (optional add-on for product pages)

**Does the AI know what size we're printing?**
No — and it doesn't need to. AI Quality Inspection scores the image itself: sharpness, exposure, noise, focus. Print size is the DPI check's job. The two work together.

**What if a customer's photo scores low but they actually want it printed?**
Operators can review held jobs and approve any image as-is with one click. The system never overrides human judgment — it just makes sure a human gets the chance.

**Can we tune the threshold?**
Yes. The score runs 0–100 and the cutoff is configurable. Start permissive, tighten as you see your real-world distribution.

**Does it slow down our pipeline?**
Scoring runs after download and before routing, on the same machine that's already handling the job. For typical job sizes, the added latency is measured in seconds, not minutes.
