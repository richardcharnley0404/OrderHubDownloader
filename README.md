# OrderHub Downloader

A Windows desktop application that automatically downloads files from an FTP server based on jobs retrieved from the OrderHub API. Runs continuously in the background as a system tray application.

## Features

- 🚀 **Automatic Polling**: Checks OrderHub API every 60 seconds for new jobs
- 📥 **FTP Downloads**: Downloads files from FTP server to local directory
- 🎯 **System Tray**: Runs quietly in the system tray
- ⚙️ **Easy Configuration**: Simple GUI for all settings
- 📝 **Comprehensive Logging**: All operations logged with rotation
- 🔄 **Auto-Start**: Optional launch on Windows startup
- 🔒 **Single Instance**: Prevents multiple instances from running

## Installation

### Development

1. **Clone or extract the project**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the application**
   ```bash
   npm start
   ```

### Production Build

1. **Create installer**
   ```bash
   npm run build
   ```

2. **Find installer in**
   ```
   dist/OrderHub Downloader Setup X.X.X.exe
   ```

## Configuration

On first launch, configure the application:

### OrderHub API Settings
- **API URL**: Your OrderHub API endpoint
- **API Key**: Your API authentication key

### FTP Server Settings
- **Host**: FTP server hostname (e.g., ftp.example.com)
- **Port**: FTP port (default: 21)
- **Username**: FTP username
- **Password**: FTP password

### Download Settings
- **Download Directory**: Local directory where files will be saved

### Application Settings
- **Enable automatic polling**: Toggle automatic job checking
- **Launch on Windows startup**: Auto-start with Windows

## Usage

### First Time Setup

1. Launch the application
2. Fill in all configuration fields
3. Click "Test API Connection" to verify OrderHub API access
4. Click "Test FTP Connection" to verify FTP access
5. Select a download directory
6. Enable polling if desired
7. Click "Save Settings"

### Running

- The application runs in the system tray (bottom right corner)
- Click the tray icon to open settings
- Right-click the tray icon for menu:
  - **Show Settings**: Open configuration window
  - **Polling: ON/OFF**: Current polling status
  - **Last check**: Time of last API check
  - **Start/Stop Polling**: Toggle polling
  - **Quit**: Exit application

### System Tray Icon

The tray icon tooltip shows:
- Application name
- Last check time

### Logs

Logs are stored in:
```
%APPDATA%/orderhub-downloader/logs/
```

Files:
- `app.log` - All application logs
- `error.log` - Error logs only

Log rotation: 5MB per file, 5 files maximum

## Project Structure

```
OrderHubDownloader/
├── src/
│   ├── main/               # Main process (Node.js)
│   │   ├── index.js        # Application entry point
│   │   ├── window-manager.js
│   │   ├── tray-manager.js
│   │   ├── ipc-handlers.js
│   │   └── services/
│   │       ├── polling-service.js
│   │       ├── ftp-service.js
│   │       ├── config-service.js
│   │       └── logger.js
│   ├── preload/            # Security bridge
│   │   └── preload.js
│   └── renderer/           # UI (HTML/CSS/JS)
│       ├── index.html
│       ├── styles.css
│       └── renderer.js
├── assets/
│   └── icons/
├── package.json
└── electron-builder.yml
```

## Development

### Scripts

- `npm start` - Run in development mode
- `npm run dev` - Run with dev flag
- `npm run build` - Create production installer
- `npm run build:dir` - Build unpacked (faster testing)

### Adding Features

1. **Main Process**: Add logic to `src/main/`
2. **UI**: Modify `src/renderer/`
3. **IPC**: Add handlers in `src/main/ipc-handlers.js`
4. **Security Bridge**: Expose in `src/preload/preload.js`

## Technologies

- **Electron** (v32) - Desktop application framework
- **basic-ftp** (v5) - FTP client
- **electron-store** (v10) - Configuration persistence
- **winston** (v3.11) - Logging
- **electron-builder** (v25) - Packaging

## Troubleshooting

### Application won't start
- Check logs in `%APPDATA%/orderhub-downloader/logs/`
- Ensure no other instance is running

### FTP connection fails
- Verify FTP credentials
- Check firewall settings
- Ensure FTP server is accessible

### API connection fails
- Verify API URL and key
- Check network connectivity
- Review API endpoint availability

### Downloads not working
- Ensure download directory exists and is writable
- Check FTP credentials
- Review logs for specific errors

### Polling not running
- Enable polling in settings
- Ensure all configuration is complete
- Check "Polling: ON" in tray menu

## Security Notes

**Phase 1 Implementation:**
- Passwords stored in plain text
- Basic authentication only
- No encryption

**Future Enhancements:**
- Password encryption using Electron's safeStorage API
- Secure credential storage
- Enhanced authentication

## License

MIT

## Support

For issues or questions, check the logs first:
```
%APPDATA%/orderhub-downloader/logs/app.log
```
