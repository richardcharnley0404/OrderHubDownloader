# Lovable Prompts — OHD API

These are the principle-led prompts to use when instructing Lovable to build OHD-related API functionality in OrderHub. Paste the relevant section directly into Lovable.

---

## Prompt 1 — OHD Check-in API & Instance Tracking

We need to extend OrderHub to support a check-in system for OrderHub Downloader (OHD), which is a Windows desktop Electron app used by our lab clients.

**Background**

OHD already communicates with OrderHub using an API key. Organisations already exist in the database. We are not changing any existing auth or organisation structure.

**What we need**

A new API endpoint that OHD calls on startup and every 4 hours. The purpose of this single endpoint is twofold — it tells OH that this OHD instance is alive and what version it is running, and it tells OHD whether a newer version is available and where to download it.

The endpoint should accept a POST request containing the instance's unique ID (a UUID that OHD generates and stores permanently on first run), the organisation ID, the machine name (Windows hostname), and the current OHD version number.

OH should upsert a record for this instance into a table that tracks all known OHD instances — updating the last seen time and version on every check-in. If the instance ID has never been seen before it should be created.

The response should tell OHD the latest available version, the download URL for the installer, any release notes, whether the update is mandatory, and whether the calling instance is already up to date.

**Supporting data**

We also need a simple way to manage the current release — a table or mechanism where we (Pixfizz) can record the latest OHD version number, the download URL (an S3 link to the signed installer), release notes, and whether the update is mandatory. This does not need a complex UI right now — just the underlying structure so the API can read from it.

**Principles to follow**

Keep the endpoint simple and stateless from OHD's perspective — OHD just posts its status and reads the response, it has no other responsibilities. The endpoint should fail gracefully and never cause OHD to crash or block on startup if OH is unreachable. Use whatever API approach best fits the existing OH architecture. Secure the endpoint using the existing OHD API key pattern already in place.

**Not in scope for now**

A dashboard UI for viewing OHD instances, any push or notification system, and per-organisation version pinning. These will come later once the API foundation is in place.

---

## Prompt 2 — Secure File Uploads via Pre-signed URLs

We need to remove IBM Cloud Object Storage (S3-compatible) credentials from the OHD desktop app. Storing cloud credentials in an Electron app is a security risk as the app can be decompiled.

**Background**

OHD currently uploads film scan folders and files directly to IBM COS using keys stored in the app. We want to move to a pattern where OH holds the credentials securely and OHD never sees them.

**What we need**

A new API endpoint in OH that OHD calls before each upload. OHD tells OH what it wants to upload (filename, folder/type, organisation), and OH responds with a temporary pre-signed URL that allows OHD to upload that specific file directly to IBM COS. The pre-signed URL should expire after a short window (around 15 minutes) and should be scoped to the exact file path being uploaded.

OHD then uses the pre-signed URL to PUT the file directly to IBM COS — the file does not pass through OH, only the URL request does. This keeps upload performance high while keeping credentials secure.

**Principles to follow**

IBM COS credentials should exist only in OH's server-side environment variables — never in OHD. Each pre-signed URL should be scoped to one specific upload and expire quickly. OH should validate that the requesting organisation is legitimate before issuing a URL. The endpoint should use the existing OHD API key pattern for authentication. Use whatever IBM COS or S3-compatible SDK approach best fits the existing OH architecture — IBM COS is S3-compatible so standard S3 pre-signed URL generation applies.

**Not in scope for now**

Upload progress reporting back to OH, quotas or storage limits per organisation, and any UI changes. Just the API endpoint that issues pre-signed URLs.

---

*Last updated: February 2026*
