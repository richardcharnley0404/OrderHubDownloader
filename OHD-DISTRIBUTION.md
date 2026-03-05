# OHD Distribution, Versioning & Code Signing

## Overview

This document covers the interconnected systems for distributing and running OrderHub Downloader (OHD):

1. **Instance registration** — each OHD install registers itself with OrderHub (OH)
2. **Version control** — OH acts as the update server via API
3. **Auto-update flow** — background download, restart prompt when ready
4. **Secure file uploads** — OH issues pre-signed URLs so IBM S3 keys never live in OHD
5. **Code signing** — Azure Trusted Signing ensures Windows does not block the installer
6. **OH Dashboard** — live view of all OHD instances across all organisations

---

## 1. OHD Instance Registration

Each OHD installation has a **persistent unique instance ID** generated on first run and stored locally. This ID is sent with every check-in to OH, allowing OH to track multiple OHD installs per organisation.

### Local Storage of Instance ID

On first launch, OHD generates and saves a UUID:

```js
// src/instance.js
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')

const INSTANCE_FILE = path.join(app.getPath('userData'), 'instance.json')

function getInstanceId() {
  if (fs.existsSync(INSTANCE_FILE)) {
    const data = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8'))
    return data.instanceId
  }
  const instanceId = uuidv4()
  fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ instanceId }))
  return instanceId
}

module.exports = { getInstanceId }
```

---

## 2. Supabase Tables in OrderHub

### `ohd_instances` — tracks every OHD install

```sql
create table ohd_instances (
  id uuid primary key,                          -- the persistent instance ID from OHD
  organisation_id uuid references organisations(id),
  machine_name text,                            -- Windows hostname
  current_version text,                         -- e.g. "1.0.4"
  is_up_to_date boolean default false,
  last_seen_at timestamptz default now(),
  created_at timestamptz default now()
);
```

### `app_versions` — current released version

```sql
create table app_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null,                        -- e.g. "1.0.5"
  download_url text not null,                   -- S3 link to signed installer .exe
  release_notes text,
  is_mandatory boolean default false,
  released_at timestamptz default now()
);
```

---

## 3. OrderHub API Endpoint — Check-in

OH exposes a single check-in endpoint that handles both registration and version checking in one call.

**`POST /api/ohd/checkin`**

Request body from OHD:
```json
{
  "instance_id": "a1b2c3d4-...",
  "organisation_id": "org-uuid",
  "machine_name": "LAB-PC-01",
  "current_version": "1.0.4"
}
```

Response from OH:
```json
{
  "latest_version": "1.0.5",
  "download_url": "https://your-s3.amazonaws.com/ohd/OHD-Setup-1.0.5.exe",
  "release_notes": "Bug fixes and DPOF improvements",
  "is_mandatory": false,
  "is_up_to_date": false
}
```

### API Logic

```js
// Upsert the instance record (register or update on every check-in)
await supabase.from('ohd_instances').upsert({
  id: instance_id,
  organisation_id,
  machine_name,
  current_version,
  is_up_to_date: current_version === latest.version,
  last_seen_at: new Date().toISOString()
})

// Return the latest version info
return latest
```

---

## 4. OHD Auto-Update Flow

OHD checks in on startup and then every 4 hours. If a new version is available it downloads silently in the background. When the download is complete, a **"Restart to Update"** prompt appears — the user chooses when to restart, but is not blocked from working.

For mandatory updates (`is_mandatory: true`), the prompt does not offer a "Later" option.

### `src/updater.js`

```js
const { app, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const { getInstanceId } = require('./instance')
const os = require('os')

const CHECKIN_URL = 'https://your-oh-app.com/api/ohd/checkin'
const ORGANISATION_ID = 'stored-in-config-or-settings'

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('update-downloaded', (info) => {
  const isMandatory = info.isMandatory

  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: `OHD ${info.version} has been downloaded.`,
    detail: isMandatory
      ? 'This is a required update. OHD will restart now.'
      : 'Restart OHD to apply the update.',
    buttons: isMandatory ? ['Restart Now'] : ['Restart Now', 'Later'],
    defaultId: 0
  }).then(({ response }) => {
    if (response === 0 || isMandatory) autoUpdater.quitAndInstall()
  })
})

async function checkIn() {
  try {
    const res = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: getInstanceId(),
        organisation_id: ORGANISATION_ID,
        machine_name: os.hostname(),
        current_version: app.getVersion()
      })
    })

    const data = await res.json()

    if (!data.is_up_to_date) {
      autoUpdater.setFeedURL({ provider: 'generic', url: data.download_url })
      autoUpdater.checkForUpdates()
    }
  } catch (err) {
    console.error('Check-in failed:', err)
    // Always fail silently — never block startup
  }
}

function startUpdateSchedule() {
  checkIn()
  setInterval(checkIn, 4 * 60 * 60 * 1000)
}

module.exports = { startUpdateSchedule }
```

---

## 5. Secure File Uploads — Pre-signed URLs

### The Problem

Storing IBM S3 credentials directly in the OHD project is a security risk. Electron apps can be decompiled, and anyone who gains access to the source or binary would have direct, permanent access to the S3 bucket.

### The Solution

**IBM S3 credentials live only in OH (server-side).** OHD never sees them. Instead, when OHD needs to upload files, it asks OH for **pre-signed URLs** — temporary, scoped upload tokens that expire after 15 minutes and only permit upload to specific file paths.

### Upload Flow

```
OHD                              OH                          IBM S3
 |                                |                             |
 |-- POST /ohd-api/uploads/presign|                             |
 |   (files[], X-Location-ID?)    |-- generate pre-signed URLs->|
 |                                |<-- pre-signed URLs ---------|
 |<-- [{ upload_url, s3_key }] ---|                             |
 |                                |                             |
 |-- PUT each file directly to S3 via pre-signed URL ---------->|
```

OHD uploads **directly to S3** for performance — files do not route through OH — but credentials never leave the server.

### OH API Endpoint (deployed)

**`POST /ohd-api/uploads/presign`**

Auth: existing API key (`x-api-key` header)

Optional header: `X-Location-ID` — when provided, film-scan paths are automatically scoped to that location.

Request body:
```json
{
  "files": [
    {
      "name": "scan-order-1234.zip",
      "folder": "film-scans",
      "sub_path": "optional/subfolder",
      "size": 2048000,
      "type": "application/zip"
    },
    {
      "name": "artwork-proof.pdf",
      "folder": "artwork"
    }
  ]
}
```

Allowed folders: `film-scans`, `file-uploads`, `artwork`, `production`, `production-tickets`

Response:
```json
{
  "files": [
    {
      "name": "scan-order-1234.zip",
      "upload_url": "https://s3.../film-scans/location-id/scan-order-1234.zip?X-Amz-Expires=900&...",
      "s3_key": "film-scans/location-id/scan-order-1234.zip",
      "expires_in": 900
    },
    {
      "name": "artwork-proof.pdf",
      "upload_url": "https://s3.../artwork/org-uuid/artwork-proof.pdf?X-Amz-Expires=900&...",
      "s3_key": "artwork/org-uuid/artwork-proof.pdf",
      "expires_in": 900
    }
  ]
}
```

### OHD Upload Logic (`src/uploader.js`)

```js
const fs = require('fs')
const path = require('path')

const PRESIGN_URL = 'https://your-oh-app.com/ohd-api/uploads/presign'
const API_KEY = 'stored-in-local-config'

/**
 * Request pre-signed URLs for an array of files, then upload each directly to S3.
 * Pass locationId for film-scan uploads to scope paths correctly.
 */
async function uploadFiles(files, locationId = null) {
  // Step 1 — request pre-signed URLs from OH
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY
  }
  if (locationId) headers['X-Location-ID'] = locationId

  const res = await fetch(PRESIGN_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      files: files.map(f => ({
        name: path.basename(f.filePath),
        folder: f.folder,
        sub_path: f.subPath,
        type: f.contentType || 'application/octet-stream'
      }))
    })
  })

  const { files: presigned } = await res.json()

  // Step 2 — upload each file directly to S3 using its pre-signed URL
  const results = []
  for (const item of presigned) {
    const match = files.find(f => path.basename(f.filePath) === item.name)
    if (!match) continue

    const fileBuffer = fs.readFileSync(match.filePath)

    await fetch(item.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': match.contentType || 'application/octet-stream' },
      body: fileBuffer
    })

    console.log(`Uploaded: ${item.s3_key}`)
    results.push({ name: item.name, s3_key: item.s3_key })
  }

  return results
}

module.exports = { uploadFiles }
```

### Example Usage — Film Scan Folder Upload

```js
const { uploadFiles } = require('./uploader')

// Upload all files in a film scan folder
const scanFiles = fs.readdirSync(scanFolderPath).map(filename => ({
  filePath: path.join(scanFolderPath, filename),
  folder: 'film-scans',
  contentType: 'application/octet-stream'
}))

const uploaded = await uploadFiles(scanFiles, locationId)
```

### Security Properties

- IBM S3 credentials exist **only** in OH environment variables — never in OHD
- Each pre-signed URL is scoped to **one specific file path**
- URLs expire after **15 minutes** — a leaked URL is quickly useless
- OH validates allowed folders before issuing any URL
- Film-scan paths are automatically scoped by location via `X-Location-ID`
- OHD source code contains **no cloud credentials of any kind**

---

## 6. Displaying Version in the OHD Interface

Show the current version in the OHD UI — recommended locations are the title bar, a footer, or a settings/about panel:

```js
const { app } = require('electron')
const version = app.getVersion() // reads from package.json
```

Display as **OHD v1.0.4**. When an update has downloaded and is pending restart, show **OHD v1.0.4 — 🔄 Update Ready**.

---

## 7. OH Dashboard — OHD Instance Monitor

In the OrderHub interface, display a table of all registered OHD instances.

### Columns to display

| Column | Source | Notes |
|---|---|---|
| Machine Name | `ohd_instances.machine_name` | Windows hostname |
| Current Version | `ohd_instances.current_version` | e.g. "1.0.4" |
| Up to Date | `ohd_instances.is_up_to_date` | ✅ green / ⚠️ amber |
| Last Seen | `ohd_instances.last_seen_at` | e.g. "2 hours ago" |
| Status | derived | 🟢 Online / 🔴 Offline |
| Organisation | via `organisation_id` join | lab name |

### Status logic

- **Online** — `last_seen_at` within the last 8 hours (two check-in cycles)
- **Offline** — `last_seen_at` more than 8 hours ago
- **Out of date** — `is_up_to_date` is false

---

## 8. Code Signing with Azure Trusted Signing

### Why Azure Trusted Signing

- ~$9.99/month — much cheaper than EV certificates (~£300+/yr)
- Microsoft's own service — SmartScreen trust is built in from day one
- Cloud-based — no USB token, works in CI/CD pipelines
- Private key never leaves Azure

### Setup Steps

#### 8.1 Azure Portal Setup

1. Create an Azure account if you don't have one
2. Search for **Trusted Signing** in the Azure Portal
3. Create a **Trusted Signing Account**
4. Create a **Certificate Profile** (choose "Public Trust" for production)
5. Complete identity verification — Microsoft verifies Pixfizz as an organisation (allow a few days — start this early)
6. Note your **Account Name**, **Endpoint URI**, and **Certificate Profile Name**

#### 8.2 Azure App Registration (for signing pipeline)

1. Go to **Azure Active Directory > App Registrations > New Registration**
2. Name it `OHD-Signing`
3. Note the **Application (client) ID** and **Directory (tenant) ID**
4. Create a **Client Secret** under Certificates & Secrets
5. Assign the **Trusted Signing Certificate Profile Signer** role to this app on your Trusted Signing Account

#### 8.3 Environment Variables

Store these securely — never commit to git:

```env
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-app-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_TRUSTED_SIGNING_ACCOUNT=your-account-name
AZURE_TRUSTED_SIGNING_ENDPOINT=https://eus.codesigning.azure.net
AZURE_CERTIFICATE_PROFILE=your-profile-name
```

#### 8.4 Signing Script (`scripts/sign.js`)

```js
const { execSync } = require('child_process')

exports.default = async function(configuration) {
  const filePath = configuration.path
  if (!filePath.endsWith('.exe')) return

  execSync([
    'sign code',
    `--file-list "${filePath}"`,
    `--publisher-name "Pixfizz"`,
    `--description "OrderHub Downloader"`,
    `--description-url "https://your-oh-app.com"`,
    `--azure-key-vault-tenant-id "${process.env.AZURE_TENANT_ID}"`,
    `--azure-key-vault-client-id "${process.env.AZURE_CLIENT_ID}"`,
    `--azure-key-vault-client-secret "${process.env.AZURE_CLIENT_SECRET}"`,
    `--trusted-signing-account "${process.env.AZURE_TRUSTED_SIGNING_ACCOUNT}"`,
    `--trusted-signing-endpoint "${process.env.AZURE_TRUSTED_SIGNING_ENDPOINT}"`,
    `--trusted-signing-certificate-profile "${process.env.AZURE_CERTIFICATE_PROFILE}"`,
  ].join(' '), { stdio: 'inherit' })
}
```

#### 8.5 electron-builder Config (`electron-builder.yml`)

```yaml
appId: com.pixfizz.ohd
productName: OrderHub Downloader

win:
  target:
    - target: nsis
      arch: x64
  sign: scripts/sign.js

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  installerIcon: assets/icon.ico
  uninstallerIcon: assets/icon.ico

publish:
  provider: generic
  url: https://your-s3-bucket.s3.amazonaws.com/ohd/
```

---

## 9. Release Workflow

1. **Bump version** in `package.json`
2. **Build and sign:** `npm run build`
3. **Upload** signed `.exe` to S3
4. **Update** `app_versions` table in Supabase with new version, S3 URL, release notes, and mandatory flag
5. OHD instances pick up the update on their next check-in
6. OH dashboard reflects updated versions as each instance checks in after restarting

---

## 10. Future Improvements

- **GitHub Actions CI/CD** — automate build, sign, S3 upload, and Supabase record update on every tagged release
- **Per-organisation version pinning** — hold specific labs on an older version if needed
- **OH alerts** — notify Pixfizz when an instance has been offline for more than X days
- **Rollback** — keep previous versions in S3 with a rollback flag in Supabase
- **Upload progress reporting** — OHD reports upload status back to OH after completing a file upload

---

## 11. Key Dependencies

| Package | Purpose |
|---|---|
| `electron-builder` | Packaging and installer creation |
| `electron-updater` | Background download and restart prompt |
| `uuid` | Generating persistent instance IDs |
| `ibm-cos-sdk` / `aws-sdk` | Generating pre-signed URLs on OH server |
| Azure Trusted Signing | Code signing service |

---

*Last updated: February 2026*
