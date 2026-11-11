const { contextBridge, ipcRenderer, webFrame } = require('electron');

/**
 * Suppress navigator.webdriver in the main world and isolated world so that Cloudflare
 * Turnstile, managed challenges, and anti-bot verification run naturally for the user
 * without flagging the window as an automated browser.
 */
try {
  webFrame.executeJavaScript(`
    try {
      if (Object.getPrototypeOf(navigator)) {
        delete Object.getPrototypeOf(navigator).webdriver;
      }
    } catch (_) {}
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } catch (_) {}
  `);
} catch (_) {}

try {
  if (Object.getPrototypeOf(navigator)) {
    delete Object.getPrototypeOf(navigator).webdriver;
  }
} catch (_) {}
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });
} catch (_) {}

/**
 * Preload for the Custom Website Wizard & Login window.
 * Exposes a minimal IPC bridge so injected toolbar / selector JS can
 * communicate with the main process.
 */
contextBridge.exposeInMainWorld('unsocial', {
  /** Send a message from the wizard page → main process */
  send: (channel, data) => {
    ipcRenderer.send('custom-wizard-msg', channel, data);
  },

  /** Register a callback for messages from the main process → wizard page */
  onMessage: (callback) => {
    ipcRenderer.on('custom-wizard-cmd', (_e, channel, data) => {
      callback(channel, data);
    });
  },
});
