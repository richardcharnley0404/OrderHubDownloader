# Prompt for Lovable — Manual Film Scan Rotation in OrderHub

## Context

We have a Windows desktop companion app (OrderHub Downloader, Electron, system tray) that sits at the lab. It watches a local scan folder, converts TIFF → JPG, and uploads to IBM Cloud Object Storage. We're adding an on-device AI model (ONNX, EfficientNetV2-S) that predicts image orientation so we can auto-rotate film scans before upload.

The model will be confident on most images (>90%) and those get auto-rotated. But a non-trivial percentage will fall below the confidence threshold and need a human to look at them and pick the correct rotation.

## Why this belongs in OrderHub (and not the Downloader)

The Downloader is a single-instance desktop app tied to one scanner folder. Only one person can use it at a time, and only while the machine is on. OrderHub is our multi-user web app, always available, already authenticated, and already has the order context these scans belong to. It's the natural home for a review queue.

I considered a separate PWA just for film management, but that adds another app to maintain, another auth boundary, and splits the order ↔ scan relationship across two products. Keeping it in OrderHub is my strong preference unless you see a reason not to.

## What I want to build

1. **A review queue** — list of images flagged by the AI as "needs manual rotation." Filterable by order, film roll, date, and status (pending / reviewed).
2. **An image viewer per item** — shows the current image, with controls to rotate left 90°, rotate right 90°, flip 180°, and reset. Live preview of the rotation before saving.
3. **Save + mark reviewed** — records the chosen rotation, who reviewed, and when.
4. **A way for the Downloader to pick up the decision** and apply the rotation to the final file in S3 (re-upload the rotated version, or store the rotation as metadata that the Downloader applies during its next pass).
5. **Simple audit trail** — reviewer, timestamp, rotation applied, per image.

## Questions I need you to answer before we build

I don't want you to just start coding — I want to understand feasibility and the right shape first.

1. **Storage and display.** Where should flagged images live so OrderHub can render them? Options I see:
   - Downloader uploads low-confidence JPGs to a dedicated "pending-review" prefix in IBM S3. OrderHub reads them via signed URLs.
   - Downloader uploads to the normal location but writes a queue record into OrderHub's database pointing to the S3 object.
   - Something else you'd recommend given our existing patterns?

2. **Data model.** Does this need a new table (e.g. `film_rotation_reviews`), or can we extend an existing orders/scans table? What does the schema look like either way?

3. **Flow between Downloader and OrderHub.** Once a reviewer picks a rotation, how does the Downloader find out?
   - Downloader polls a REST endpoint for reviewed items?
   - OrderHub fires a webhook to the Downloader (harder — it's behind a LAN)?
   - A status column the Downloader polls on its existing interval?

4. **Performance and UX.** Film scans are big files. What's your approach for thumbnails vs. full-res in the reviewer? Any caching we should plan for?

5. **Auth / permissions.** Who should be allowed to review and approve rotations? Is there an existing role we can reuse or do we need a new one?

6. **Reusable patterns.** Is there anything already in OrderHub (image display, S3 integration, queues, review workflows) I should lean on rather than building fresh?

## What I'd like back from you

- A yes/no on feasibility given OrderHub's current architecture.
- Your recommended data model and flow (with reasoning).
- Any gotchas you see — especially around IBM S3 auth from the browser, image size, mobile responsiveness, and race conditions between the Downloader and reviewers.
- A rough scope/effort estimate and a suggested order of implementation.

Please don't start building yet — I want to review your plan first.
