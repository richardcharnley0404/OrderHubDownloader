# Quick Start Guide

## Running the Application

### Development Mode
```bash
npm start
```

The application will:
1. Open a configuration window
2. Create a system tray icon (look in bottom-right corner near the clock)
3. Start logging to: `%APPDATA%\orderhub-downloader\logs\`

## Initial Configuration

### 1. Fill in OrderHub API Settings
- **API URL**: Your OrderHub API endpoint
  - Example: `https://api.orderhub.com/jobs`
- **API Key**: Your API authentication key
- Click "Test API Connection" to verify

### 2. Configure FTP Server
- **Host**: FTP server address (e.g., `ftp.example.com`)
- **Port**: Usually `21`
- **Username**: Your FTP username
- **Password**: Your FTP password
- Click "Test FTP Connection" to verify

### 3. Select Download Directory
- Click "Browse..." button
- Choose where files should be downloaded
- Example: `C:\Downloads\OrderHub`

### 4. Application Settings
- ☑ **Enable automatic polling**: Check this to start automatic checking
- ☑ **Launch on Windows startup**: Check to auto-start with Windows

### 5. Save Configuration
- Click "Save Settings" button
- If polling is enabled, it will start immediately

## Using the System Tray

### Tray Icon Location
Look for the application icon in the system tray (bottom-right corner of Windows taskbar, near the clock).

### Click Actions
- **Single Click**: Show/hide settings window
- **Right Click**: Show context menu

### Context Menu Options
- **Show Settings**: Open configuration window
- **Polling: ON/OFF**: Current polling status
- **Last check**: Time of last API check
- **Start/Stop Polling**: Toggle automatic polling
- **Quit**: Exit the application completely

## How It Works

1. **Polling Cycle (Every 60 seconds)**
   - Connects to OrderHub API
   - Fetches available jobs
   - Processes each job

2. **For Each Job**
   - Extracts FTP file path from job data
   - Connects to FTP server
   - Downloads file to local directory
   - Logs the operation

3. **Logging**
   - All operations logged to files
   - Location: `%APPDATA%\orderhub-downloader\logs\`
   - Files: `app.log` (all logs) and `error.log` (errors only)

## Testing the Setup

### Test FTP Connection
1. Fill in FTP credentials
2. Click "Test FTP Connection"
3. Should see "FTP connection successful!" message

### Test API Connection
1. Fill in API URL and key
2. Click "Test API Connection"
3. Should see "API connection successful!" message

### Test Full Workflow
1. Save configuration with polling enabled
2. Watch the logs: `%APPDATA%\orderhub-downloader\logs\app.log`
3. Every 60 seconds, you'll see:
   ```
   [INFO]: Checking for new jobs
   [INFO]: Found X job(s) to process
   [INFO]: Downloading file from FTP
   [INFO]: FTP download successful
   ```

## Common Issues

### "Configuration incomplete" error
- Ensure all required fields are filled in
- All fields except checkboxes are required

### FTP connection fails
- Verify credentials are correct
- Check FTP server is accessible
- Try port 21 (standard FTP port)
- Check firewall settings

### API connection fails
- Verify API URL is correct and accessible
- Check API key is valid
- Ensure network connection is working

### No files downloading
- Check polling is enabled (right-click tray icon)
- Verify download directory is writable
- Check logs for errors: `%APPDATA%\orderhub-downloader\logs\error.log`

### Application not in tray
- Check if app is running (Task Manager)
- Look carefully in system tray (may be hidden)
- Click the up arrow (^) in tray area to show hidden icons

## Viewing Logs

### Windows File Explorer
1. Press `Win + R`
2. Type: `%APPDATA%\orderhub-downloader\logs`
3. Press Enter
4. Open `app.log` with Notepad

### Real-time Log Monitoring
```bash
# PowerShell
Get-Content "$env:APPDATA\orderhub-downloader\logs\app.log" -Wait -Tail 20
```

## Stopping the Application

### Option 1: System Tray
1. Right-click tray icon
2. Click "Quit"

### Option 2: Task Manager
1. Open Task Manager (Ctrl + Shift + Esc)
2. Find "OrderHub Downloader"
3. Click "End Task"

## Auto-Start Configuration

### Enable Auto-Start
1. Open settings
2. Check "Launch on Windows startup"
3. Click "Save Settings"

### Disable Auto-Start
1. Open settings
2. Uncheck "Launch on Windows startup"
3. Click "Save Settings"

## Next Steps

### After Initial Setup
1. Let the application run for several polling cycles
2. Verify files are downloading correctly
3. Check logs for any errors
4. Adjust settings as needed

### For Production Use
1. Enable "Launch on Windows startup"
2. Minimize settings window (app runs in tray)
3. Monitor periodically via logs
4. Application runs 24/7 automatically

## Building Installer

### Create Windows Installer
```bash
npm run build
```

Installer location: `dist\OrderHub Downloader Setup 1.0.0.exe`

### Quick Build Test (No Installer)
```bash
npm run build:dir
```

Output location: `dist\win-unpacked\`

## Support

### Log Files
All diagnostic information: `%APPDATA%\orderhub-downloader\logs\`

### Configuration File
Settings stored at: `%APPDATA%\orderhub-downloader\config.json`

### Resetting Configuration
1. Close application
2. Delete: `%APPDATA%\orderhub-downloader\config.json`
3. Restart application
4. Reconfigure from scratch
