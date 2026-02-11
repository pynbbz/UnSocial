const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Instagram Auth
  openLogin: () => ipcRenderer.invoke('open-login'),
  checkLogin: () => ipcRenderer.invoke('check-login'),
  logout: () => ipcRenderer.invoke('logout'),

  // Twitter Auth
  openTwitterLogin: () => ipcRenderer.invoke('open-twitter-login'),
  checkTwitterLogin: () => ipcRenderer.invoke('check-twitter-login'),
  logoutTwitter: () => ipcRenderer.invoke('logout-twitter'),

  // Facebook Auth
  openFacebookLogin: () => ipcRenderer.invoke('open-facebook-login'),
  checkFacebookLogin: () => ipcRenderer.invoke('check-facebook-login'),
  logoutFacebook: () => ipcRenderer.invoke('logout-facebook'),

  // LinkedIn Auth
  openLinkedInLogin: () => ipcRenderer.invoke('open-linkedin-login'),
  checkLinkedInLogin: () => ipcRenderer.invoke('check-linkedin-login'),
  logoutLinkedIn: () => ipcRenderer.invoke('logout-linkedin'),

  // Force reset (nuclear option — clears ALL data for a platform)
  forceResetPlatform: (platform) => ipcRenderer.invoke('force-reset-platform', platform),

  // Feeds
  getFeeds: () => ipcRenderer.invoke('get-feeds'),
  addFeed: (url) => ipcRenderer.invoke('add-feed', url),
  renameFeed: (username, platform, newAlias) => ipcRenderer.invoke('rename-feed', username, platform, newAlias),
  removeFeed: (username, platform) => ipcRenderer.invoke('remove-feed', username, platform),
  refreshFeed: (username, platform) => ipcRenderer.invoke('refresh-feed', username, platform),
  refreshAll: () => ipcRenderer.invoke('refresh-all'),
  exportOpml: (groups, tunnelDomain) => ipcRenderer.invoke('export-opml', groups, tunnelDomain),

  // Server
  getServerPort: () => ipcRenderer.invoke('get-server-port'),

  // Tunnel
  tunnelCheckInstalled: () => ipcRenderer.invoke('tunnel-check-installed'),
  tunnelCheckAuthenticated: () => ipcRenderer.invoke('tunnel-check-authenticated'),
  tunnelCheckSetup: () => ipcRenderer.invoke('tunnel-check-setup'),
  tunnelRunSetup: (step) => ipcRenderer.invoke('tunnel-run-setup', step),
  tunnelStart: () => ipcRenderer.invoke('tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel-stop'),
  tunnelState: () => ipcRenderer.invoke('tunnel-state'),
  tunnelGetSettings: () => ipcRenderer.invoke('tunnel-get-settings'),
  tunnelSaveSettings: (s) => ipcRenderer.invoke('tunnel-save-settings', s),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Events from main process
  onLoginStatus: (callback) => {
    ipcRenderer.on('login-status', (_e, data) => callback(data));
  },
  onTunnelStatus: (callback) => {
    ipcRenderer.on('tunnel-status', (_e, data) => callback(data));
  },
  onFeedsUpdated: (callback) => {
    ipcRenderer.on('feeds-updated', () => callback());
  },
  onNotificationsUpdated: (callback) => {
    ipcRenderer.on('notifications-updated', (_e, data) => callback(data));
  },

  // Notifications
  getNotifications: () => ipcRenderer.invoke('get-notifications'),
  resolveNotification: (id) => ipcRenderer.invoke('resolve-notification', id),
  clearNotifications: () => ipcRenderer.invoke('clear-notifications'),
});
