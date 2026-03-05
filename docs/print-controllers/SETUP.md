# Print Controller Setup Guide

This guide walks through configuring print controllers, channels, and process mappings in OrderHub Downloader.

---

## Adding a Noritsu Controller

### Step 1: Open Print Controllers settings

Go to **Settings → Print Controllers** and click **Add Controller**.

### Step 2: Fill in the controller form

| Field | Value for Noritsu | Notes |
|-------|-------------------|-------|
| Name | e.g., `Noritsu QSS-3901` | Display name — your choice |
| Type | `noritsu` | Controls DPOF vendor fields |
| Vendor Name | `NORITSU KOKI` | Used in `VUQ VNM` DPOF field |
| Vendor Attribute | e.g., `QSS-3901` | Used in `-ATR` DPOF field; matches your model |
| Hot Folder Path | e.g., `C:\NoritsuHotFolder` | Directory the controller watches |
| Auto Correct | On / Off | Sets `AUTO CORRECT = 1` or `0` in DPOF |
| Active | Checked | Must be active to receive jobs |

### Step 3: Save the controller

Click **Save**. The controller will appear in the list.

### Step 4: Add channels

Each paper size/type combination needs a channel. Click **Add Channel** under the controller.

| Field | Example | Notes |
|-------|---------|-------|
| Channel Number | `145` | Physical paper channel on the Noritsu |
| Size | `6x4` | Must match image size from OrderHub manifest |
| Finish | `Gloss` | Optional — used for channel disambiguation |
| Print Style Code | `B` | Noritsu standard; maps to `PRT PSL` field |
| Active | Checked | Inactive channels are ignored during matching |

Repeat for each paper size the controller handles (e.g., `6x4`, `5x7`, `8x12`).

---

## Adding an Epson Controller

The process is identical to Noritsu. The key difference is the vendor metadata used in DPOF output.

| Field | Typical Value for Epson |
|-------|------------------------|
| Type | `epson` |
| Vendor Name | e.g., `EPSON` |
| Vendor Attribute | e.g., `SC-P900` |
| Print Style Code | Check your Epson controller documentation |

> **Note**: Epson controllers may use different channel numbering and print style codes. Consult your Epson hot folder software documentation for the correct values.

---

## Configuring Print Channels

Channels define which physical paper stock a job is routed to. The channel matching logic works as follows:

1. The first image in the job manifest is inspected for its `size` field (e.g., `"4x6"`).
2. All active channels on the controller are compared against that size (case-insensitive).
3. If a `Paper` or `Finish` job option is set, it is used to narrow down multiple size matches.
4. The first matching channel is used.

### Channel sizing convention

Sizes are stored as `{width}x{height}` strings. These must exactly match the size strings in your OrderHub manifests.

Examples: `4x6`, `5x7`, `6x4`, `8x10`, `8x12`

### Multiple channels for the same size

You can have multiple channels with the same size but different finishes:

| Channel | Size | Finish |
|---------|------|--------|
| 145 | `4x6` | `Gloss` |
| 146 | `4x6` | `Matt` |

If a job has a `Paper` option set to `Matt`, channel 146 will be selected. If the finish cannot be determined or there is only one size match, the first match is used.

---

## Hot Folder Setup and Permissions

### Creating the hot folder

Create a dedicated directory for the controller to watch. This can be:

- A local path: `C:\PrintControllers\Noritsu`
- A network share path: `\\printserver\noritsu-hot`

The directory must exist before starting the app. It is not created automatically.

### Windows permissions required

The user account running OrderHub Downloader needs:

- **Read** access to the hot folder (to monitor for renames)
- **Write** access to the hot folder (to create order subfolders)
- **Write** access to create subdirectories and files within the hot folder

If using a network share, ensure the share permissions match the NTFS permissions and that the network path is accessible when the app starts.

### Hot folder structure after submission

After a job is submitted:

```
C:\PrintControllers\Noritsu\
└── o100456_8x12GLOSS\          ← Created by this app (prefix: o)
    ├── DPOF.001                 ← DPOF specification
    └── IMAGES\
        ├── photo-001.jpg
        └── photo-002.jpg
```

After the controller accepts the job:

```
C:\PrintControllers\Noritsu\
└── e100456_8x12GLOSS\          ← Renamed by the controller (prefix: e)
    ├── DPOF.001
    └── IMAGES\
        └── ...
```

---

## Configuring Process Mappings

Process mappings link OrderHub job process types to either a print controller (DPOF pipeline) or a folder path (file-copy pipeline).

### Accessing process mappings

Go to **Settings → Downloads → Process Folder Mappings**.

### Mapping a process to a controller

To route the `Print` process type to a Noritsu controller:

1. Find the `Print` row in the mappings table (or add it)
2. Select the controller from the **Controller** dropdown instead of entering a folder path
3. Save settings

The internal storage format is:

```json
{
  "Print": {
    "controllerId": "uuid-of-your-noritsu-controller"
  },
  "Cut": {
    "folderPath": "C:\\PhotLab\\Cut"
  }
}
```

A mapping with a `controllerId` uses the DPOF pipeline. A mapping with only a `folderPath` uses the file-copy pipeline.

---

## Testing Your Configuration

### Using the built-in test

In **Settings → Print Controllers**, click the **Test** button next to a controller. This runs a full integration test that:

1. Creates a temporary controller and channel
2. Generates a test job with a dummy image
3. Writes the order folder to a temporary hot folder
4. Simulates a folder rename (as if the controller accepted the job)
5. Verifies the status change was detected
6. Cleans up all temporary files

The test output shows pass/fail for each step.

### Manual verification

After sending a real job:

1. Check that the order folder appears in the hot folder with an `o` prefix
2. Open the folder and verify `DPOF.001` exists and `IMAGES\` contains the correct files
3. Open `DPOF.001` in a text editor and check the channel number and image references
4. Confirm the controller's software picks up the folder (prefix changes to `e`)
5. Check the job status in the OrderHub Downloader job list — it should update to `accepted`

### Checking logs

Logs are written to `%APPDATA%\Electron\orderhub-downloader\logs\app.log`.

Relevant log messages:

```
[info] Job sent to print via DPOF { jobId, controller, channel, hotFolder, images }
[info] Job {orderNumber} status changed to accepted
[warn] Job sent but API status update failed { jobId, error }
```
