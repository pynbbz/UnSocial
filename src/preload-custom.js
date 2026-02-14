const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the Custom Website Wizard window.
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
