const { BrowserWindow } = require('electron');
const path = require('path');

class WindowManager {
  constructor() {
    this.mainWindow = null;
  }

  createWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      return this.mainWindow;
    }

    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 750,
      minWidth: 1000,
      minHeight: 600,
      frame: false,          // remove native OS title bar — custom header is used instead
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      },
      // icon.ico works in both dev and packaged builds (assets/ is in the build files array)
      icon: path.join(__dirname, '../../assets/icon.ico'),
      title: 'OrderHub Desktop',
      autoHideMenuBar: true
    });

    this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    this.mainWindow.on('close', (event) => {
      // Prevent window from closing, just hide it
      event.preventDefault();
      this.mainWindow.hide();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Push maximise/unmaximise state to the renderer so the button icon stays
    // in sync regardless of how the window state changed (button click, OS
    // title-bar double-click, keyboard shortcut, etc.).
    this.mainWindow.on('maximize', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('window:maximised', true);
      }
    });

    this.mainWindow.on('unmaximize', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('window:maximised', false);
      }
    });

    return this.mainWindow;
  }

  showWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
    } else {
      this.createWindow();
    }
  }

  hideWindow() {
    if (this.mainWindow) {
      this.mainWindow.hide();
    }
  }

  getWindow() {
    return this.mainWindow;
  }
}

module.exports = new WindowManager();
