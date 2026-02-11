const { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { startFeedServer, stopFeedServer } = require('./feed-server');

// Force a consistent userData path so data persists across exe replacements.
// For portable builds, electron-builder sets PORTABLE_EXECUTABLE_DIR.
// IMPORTANT: Must NOT be the same as portable.unpackDirName ('UnSocial-data')
// because the portable launcher wipes that directory on update.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir) {
  const newUserData = path.join(portableDir, 'UnSocial-userdata');
  const oldUserData = path.join(portableDir, 'UnSocial-data');

  // One-time migration: copy persisted data from the old location
  if (!fs.existsSync(newUserData) && fs.existsSync(oldUserData)) {
    try {
      fs.mkdirSync(newUserData, { recursive: true });
      // Copy electron-store config
      const oldConfig = path.join(oldUserData, 'config.json');
      if (fs.existsSync(oldConfig)) {
        fs.copyFileSync(oldConfig, path.join(newUserData, 'config.json'));
      }
      // Copy Local Storage, Session Storage, feeds (directories)
      const dirsToCopy = ['Local Storage', 'Session Storage', 'feeds', 'GPUCache', 'Network'];
      for (const dir of dirsToCopy) {
        const src = path.join(oldUserData, dir);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
          copyDirSync(src, path.join(newUserData, dir));
        }
      }
      // Copy cookie-related files and other Chromium DB files at root level
      const filesToCopy = ['Cookies', 'Cookies-journal', 'Preferences', 'Local State',
                           'TransportSecurity', 'Trust Tokens', 'QuotaManager',
                           'QuotaManager-journal', 'DIPS'];
      for (const f of filesToCopy) {
        const src = path.join(oldUserData, f);
        if (fs.existsSync(src) && !fs.statSync(src).isDirectory()) {
          fs.copyFileSync(src, path.join(newUserData, f));
        }
      }
      console.log('[Migration] Copied user data from UnSocial-data → UnSocial-userdata');
    } catch (err) {
      console.error('[Migration] Failed to migrate old data:', err.message);
    }
  }

  app.setPath('userData', newUserData);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
// ── Single Instance Lock ───────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const { scrapeInstagramProfile } = require('./scraper');
const { scrapeTwitterProfile } = require('./scraper-twitter');
const { scrapeFacebookProfile } = require('./scraper-facebook');
const { scrapeLinkedInProfile } = require('./scraper-linkedin');
const { generateFeed } = require('./rss-generator');
const tunnel = require('./tunnel');

const store = new Store({
  defaults: {
    feeds: [],       // Array of { url, username, alias, lastChecked }
    serverPort: 3845,
    checkIntervalMinutes: 30,
    tunnelDomain: '',
    tunnelName: 'unsocial-tunnel',
    tunnelAutoStart: false,
  }
});

let mainWindow = null;
let loginWindow = null;
let tray = null;
let isQuitting = false;
let autoRefreshInterval = null;

// ── Notification / Error Log ───────────────────────────────────────────────

const notificationLog = [];  // { id, timestamp, type, message, resolved }
let notifIdCounter = 0;
let hasActiveErrors = false; // tracks whether tray should show error icon

function addNotification(type, message) {
  const entry = {
    id: ++notifIdCounter,
    timestamp: new Date().toISOString(),
    type,       // 'error' | 'warning' | 'info'
    message,
    resolved: false,
  };
  notificationLog.unshift(entry); // newest first
  // Cap at 100 entries
  if (notificationLog.length > 100) notificationLog.pop();
  console.log(`[Notification] ${type}: ${message}`);
  sendNotificationsToRenderer();
  recalcTrayIcon();
  return entry.id;
}

function resolveNotification(id) {
  const n = notificationLog.find(n => n.id === id);
  if (n) n.resolved = true;
  sendNotificationsToRenderer();
  recalcTrayIcon();
}

function resolveNotificationsByType(type) {
  for (const n of notificationLog) {
    if (n.type === type && !n.resolved) n.resolved = true;
  }
  sendNotificationsToRenderer();
  recalcTrayIcon();
}

function resolveNotificationsBySubstring(substr) {
  for (const n of notificationLog) {
    if (!n.resolved && n.message.includes(substr)) n.resolved = true;
  }
  sendNotificationsToRenderer();
  recalcTrayIcon();
}

function sendNotificationsToRenderer() {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('notifications-updated', notificationLog);
    }
  } catch (err) {
    console.error('[sendNotificationsToRenderer] Error:', err.message);
  }
}

function recalcTrayIcon() {
  try {
    const tunnelState = tunnel.getTunnelState(store);
    const tunnelOk = tunnelState.status === 'running';
    const unresolvedErrors = notificationLog.some(n => !n.resolved && n.type === 'error');
    hasActiveErrors = unresolvedErrors;
    updateTrayIcon(tunnelOk && !unresolvedErrors);
  } catch (err) {
    console.error('[recalcTrayIcon] Error:', err.message);
  }
}

// ── Internet connectivity check ────────────────────────────────────────────

let internetDown = false;
let internetCheckInterval = null;

async function checkInternetConnectivity() {
  const { net } = require('electron');
  return new Promise((resolve) => {
    try {
      const request = net.request('https://www.google.com/generate_204');
      request.on('response', () => resolve(true));
      request.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 8000);
      request.end();
    } catch {
      resolve(false);
    }
  });
}

function startInternetMonitor() {
  internetCheckInterval = setInterval(async () => {
    const online = await checkInternetConnectivity();
    if (!online && !internetDown) {
      internetDown = true;
      addNotification('error', 'Internet connection lost');
    } else if (online && internetDown) {
      internetDown = false;
      resolveNotificationsBySubstring('Internet connection');
      addNotification('info', 'Internet connection restored');
    }
  }, 30000); // check every 30s
}

// ── Stale Feed Notification Checker ────────────────────────────────────────

let staleFeedCheckInterval = null;

function checkStaleFeedsNotifications() {
  try {
    const feeds = store.get('feeds');
    const now = Date.now();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    for (const feed of feeds) {
      const lastChecked = feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0;
      const age = now - lastChecked;
      if (age > SIX_HOURS) {
        // Only add notification if there isn't already an unresolved one for this feed about staleness
        const existing = notificationLog.find(n =>
          !n.resolved && n.message.includes(`@${feed.username}`) && n.message.includes('stale')
        );
        if (!existing) {
          const hoursAgo = Math.floor(age / (60 * 60 * 1000));
          addNotification('warning', `@${feed.username} feed is stale (last updated ${hoursAgo}h ago)`);
        }
      }
    }
  } catch (err) {
    console.error('[StaleFeedCheck] Error:', err.message);
  }
}

function startStaleFeedMonitor() {
  checkStaleFeedsNotifications();
  staleFeedCheckInterval = setInterval(checkStaleFeedsNotifications, 15 * 60 * 1000);
}

// ── Smart Staggered Feed Refresher ─────────────────────────────────────────

let refreshTimeout = null;
let isRefreshing = false;

function getRandomInterval() {
  // Random interval between 25 and 65 minutes (in ms)
  const minMinutes = 25;
  const maxMinutes = 65;
  const minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return Math.round(minutes * 60 * 1000);
}

const MAX_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours hard cap

function scheduleNextRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);

  let interval = getRandomInterval();

  // Check the oldest feed's staleness and cap interval so it never exceeds 6 h
  try {
    const feeds = store.get('feeds');
    if (feeds.length > 0) {
      const sorted = [...feeds].sort((a, b) => {
        const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
        const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
        return ta - tb;
      });
      const oldestTime = sorted[0].lastChecked
        ? new Date(sorted[0].lastChecked).getTime()
        : 0;
      const age = Date.now() - oldestTime;
      const timeUntilStale = MAX_STALE_MS - age;

      if (timeUntilStale <= 0) {
        // Already over 6 h — refresh immediately (tiny delay to avoid tight loop)
        interval = 5 * 1000; // 5 seconds
      } else if (timeUntilStale < interval) {
        // Shorten wait so we refresh before the 6-h mark (with 2-min buffer)
        interval = Math.max(timeUntilStale - 2 * 60 * 1000, 5 * 1000);
      }
    }
  } catch (err) {
    console.error('[Smart-refresh] Error computing staleness cap:', err.message);
  }

  const mins = (interval / 60000).toFixed(1);
  console.log(`[Smart-refresh] Next feed refresh in ${mins} minutes`);
  refreshTimeout = setTimeout(() => refreshOldestFeed(), interval);
}

async function refreshOldestFeed() {
  if (isRefreshing) {
    scheduleNextRefresh();
    return;
  }
  isRefreshing = true;

  try {
    const feeds = store.get('feeds');
    if (feeds.length === 0) {
      scheduleNextRefresh();
      isRefreshing = false;
      return;
    }

    // Sort by lastChecked ascending — oldest first (never-checked = priority)
    const sorted = [...feeds].sort((a, b) => {
      const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return ta - tb;
    });

    const feed = sorted[0];
    const platform = feed.platform || 'instagram';
    console.log(`[Smart-refresh] Refreshing @${feed.username} (${platform}), last checked: ${feed.lastChecked || 'never'}`);

    let profileData;
    if (platform === 'twitter') profileData = await scrapeTwitterProfile(feed.username);
    else if (platform === 'facebook') profileData = await scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
    else if (platform === 'linkedin') profileData = await scrapeLinkedInProfile(feed.username);
    else profileData = await scrapeInstagramProfile(feed.username);

    const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
    await generateFeed(feedKey, profileData, store, platform);

    // Update only this entry
    const currentFeeds = store.get('feeds');
    const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === platform);
    if (idx !== -1) {
      currentFeeds[idx].lastChecked = new Date().toISOString();
      currentFeeds[idx].postCount = profileData.posts.length;
      const realPosts = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
      currentFeeds[idx].latestPostDate = realPosts.length > 0
        ? new Date(Math.max(...realPosts.map(p => new Date(p.timestamp).getTime()))).toISOString()
        : currentFeeds[idx].latestPostDate || null;
      store.set('feeds', currentFeeds);
    }

    // Resolve any previous error for this feed
    resolveNotificationsBySubstring(`@${feed.username}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('feeds-updated');
    }
    console.log(`[Smart-refresh] @${feed.username} done (${profileData.posts.length} posts)`);
  } catch (err) {
    const feed = store.get('feeds').sort((a, b) => {
      const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return ta - tb;
    })[0];
    const msg = `Failed to refresh @${feed?.username || 'unknown'}: ${err.message}`;
    console.error('[Smart-refresh]', msg);
    addNotification('error', msg);

    // Bump lastChecked by 30 min so a failing feed doesn't block others from refreshing
    if (feed) {
      try {
        const currentFeeds = store.get('feeds');
        const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === (feed.platform || 'instagram'));
        if (idx !== -1) {
          const prev = currentFeeds[idx].lastChecked ? new Date(currentFeeds[idx].lastChecked).getTime() : 0;
          currentFeeds[idx].lastChecked = new Date(prev + 30 * 60 * 1000).toISOString();
          store.set('feeds', currentFeeds);
          console.log(`[Smart-refresh] Bumped @${feed.username} lastChecked by 30 min to avoid blocking other feeds`);
        }
      } catch (e) {
        console.error('[Smart-refresh] Failed to bump lastChecked:', e.message);
      }
    }
  } finally {
    isRefreshing = false;
    scheduleNextRefresh();
  }
}

// ── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Persist cookies across restarts
  const ses = session.defaultSession;

  createMainWindow();
  createTray();
  startFeedServer(store);
  startInternetMonitor();
  startStaleFeedMonitor();
  scheduleNextRefresh();

  // Forward tunnel status changes to the renderer + update tray icon
  tunnel.onTunnelStatusChange((data) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel-status', data);
      }
      if (data.status === 'error') {
        addNotification('error', 'Tunnel disconnected: ' + (data.message || 'unknown error'));
      } else if (data.status === 'running') {
        resolveNotificationsBySubstring('Tunnel');
      }
      recalcTrayIcon();
    } catch (err) {
      console.error('[TunnelCallback] Error:', err.message);
    }
  });

  // Auto-start tunnel — run through full setup chain automatically
  (async () => {
    // Kill any orphaned cloudflared.exe left over from a previous session
    tunnel.killOrphanedCloudflared();

    const sendStatus = (msg) => {
      console.log('[Tunnel] ' + msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel-status', { status: 'starting', message: msg });
      }
    };

    try {
      const installed = await tunnel.checkCloudflaredInstalled();
      if (!installed.installed) {
        console.log('[Tunnel] cloudflared not installed — skipping auto-start');
        return;
      }
      sendStatus('cloudflared found (' + installed.version + ')');

      // Check authentication (cert.pem)
      if (!tunnel.checkAuthenticated()) {
        sendStatus('Not authenticated — opening login...');
        const loginResult = await tunnel.runSetupCommand(['tunnel', 'login']);
        if (!loginResult.success) {
          console.log('[Tunnel] Login failed:', loginResult.output);
          return;
        }
        sendStatus('Authentication complete');
      }

      // Check if tunnel exists, create if needed
      const tunnelName = store.get('tunnelName');
      const domain = store.get('tunnelDomain');
      const setup = await tunnel.checkTunnelSetup(store);
      if (!setup.exists) {
        sendStatus('Creating tunnel "' + tunnelName + '"...');
        const createResult = await tunnel.runSetupCommand(['tunnel', 'create', tunnelName]);
        if (!createResult.success && !createResult.output.includes('already exists')) {
          console.log('[Tunnel] Create failed:', createResult.output);
          return;
        }
        sendStatus('Tunnel created');
      }

      // Route DNS (idempotent — safe to re-run)
      sendStatus('Routing DNS for ' + domain + '...');
      await tunnel.runSetupCommand(['tunnel', 'route', 'dns', tunnelName, domain]);

      // Start tunnel
      sendStatus('Starting tunnel...');
      tunnel.startTunnel(store);

      // Wait for tunnel to connect, then refresh all feeds
      let tunnelPollAttempts = 0;
      const tunnelPollInterval = setInterval(async () => {
        tunnelPollAttempts++;
        const tState = tunnel.getTunnelState(store);
        if (tState.status === 'running') {
          clearInterval(tunnelPollInterval);
          console.log('[Tunnel] Connected — refreshing all feeds');
          const feedsSnapshot = store.get('feeds');
          for (const feed of feedsSnapshot) {
            try {
              const plat = feed.platform || 'instagram';
              let profileData;
              if (plat === 'twitter') profileData = await scrapeTwitterProfile(feed.username);
              else if (plat === 'facebook') profileData = await scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
              else if (plat === 'linkedin') profileData = await scrapeLinkedInProfile(feed.username);
              else profileData = await scrapeInstagramProfile(feed.username);
              const fk = (feed.feedKey || feed.username).replace(/\//g, '-');
              await generateFeed(fk, profileData, store, plat);

              // Re-read store and update only this entry to avoid overwriting concurrent additions
              const currentFeeds = store.get('feeds');
              const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === (plat));
              if (idx !== -1) {
                currentFeeds[idx].lastChecked = new Date().toISOString();
                currentFeeds[idx].postCount = profileData.posts.length;
                const realPostsT = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
                currentFeeds[idx].latestPostDate = realPostsT.length > 0
                  ? new Date(Math.max(...realPostsT.map(p => new Date(p.timestamp).getTime()))).toISOString()
                  : currentFeeds[idx].latestPostDate || null;
                store.set('feeds', currentFeeds);
              }

            } catch (err) {
              console.error('[Post-tunnel refresh] Failed @' + feed.username + ':', err.message);
              addNotification('error', 'Post-tunnel refresh failed @' + feed.username + ': ' + err.message);
            }
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('feeds-updated');
          }
          console.log('[Post-tunnel refresh] Done.');
        }
        if (tunnelPollAttempts > 60) { // give up after ~60s
          clearInterval(tunnelPollInterval);
        }
      }, 1000);
    } catch (err) {
      console.error('[Tunnel] Auto-start failed:', err.message);
    }
  })();

  // Smart staggered refresh is handled by scheduleNextRefresh() above
});

app.on('before-quit', () => {
  isQuitting = true;
  // Ensure cloudflared is fully killed before the app exits
  tunnel.stopTunnel();
});

app.on('window-all-closed', () => {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  if (internetCheckInterval) clearInterval(internetCheckInterval);
  if (staleFeedCheckInterval) clearInterval(staleFeedCheckInterval);
  tunnel.stopTunnel();
  stopFeedServer();
  app.quit();
});

// ── Main Window ────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    show: false,
    title: 'UnSocial',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Minimize to tray instead of taskbar
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // Close button truly quits (default behavior)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      isQuitting = true;
      if (tray) { tray.destroy(); tray = null; }
    }
  });
}

// ── System Tray ────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('UnSocial');

  // Start with error icon since tunnel isn't connected yet
  updateTrayIcon(false);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayIcon(healthy) {
  if (!tray || tray.isDestroyed()) return;
  const iconFile = healthy ? 'icon.png' : 'icon_error.png';
  const iconPath = path.join(__dirname, '..', 'assets', iconFile);
  try {
    const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray.setImage(img);
    tray.setToolTip(healthy ? 'UnSocial' : 'UnSocial — issues detected');
  } catch (_) {}
}

// ── Instagram Login Window ─────────────────────────────────────────────────

let twitterLoginWindow = null;
let facebookLoginWindow = null;
let linkedinLoginWindow = null;

function openLoginWindow() {
  if (loginWindow) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 460,
    height: 720,
    parent: mainWindow,
    modal: true,
    title: 'Login to Instagram',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadURL('https://www.instagram.com/accounts/login/');

  loginWindow.webContents.on('did-navigate', (_e, url) => {
    if (
      url === 'https://www.instagram.com/' ||
      url === 'https://www.instagram.com'
    ) {
      mainWindow.webContents.send('login-status', { platform: 'instagram', loggedIn: true });
      loginWindow.close();
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
    checkLoginStatus();
  });
}

// ── Twitter / X Login Window ───────────────────────────────────────────────

function openTwitterLoginWindow() {
  if (twitterLoginWindow) {
    twitterLoginWindow.focus();
    return;
  }

  twitterLoginWindow = new BrowserWindow({
    width: 500,
    height: 720,
    parent: mainWindow,
    modal: true,
    title: 'Login to Twitter / X',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  twitterLoginWindow.setMenuBarVisibility(false);

  // Spoof a real Chrome user agent — Twitter/X blocks or misbehaves with
  // Electron's default UA that contains "Electron".  Set on the session so
  // it applies to all sub-requests (XHR, fetch) not just top-level navigation.
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  twitterLoginWindow.webContents.session.setUserAgent(chromeUA);
  twitterLoginWindow.webContents.setUserAgent(chromeUA);

  // Clear any stale Twitter cookies that might cause "wrong password" errors
  (async () => {
    const domains = ['x.com', 'twitter.com'];
    for (const domain of domains) {
      const cookies = await session.defaultSession.cookies.get({ domain });
      for (const cookie of cookies) {
        const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
        await session.defaultSession.cookies.remove(url, cookie.name).catch(() => {});
      }
    }
    twitterLoginWindow.loadURL('https://x.com/i/flow/login');
  })();

  twitterLoginWindow.webContents.on('did-navigate', (_e, url) => {
    if (url.startsWith('https://x.com/home') || url.startsWith('https://twitter.com/home')) {
      mainWindow.webContents.send('login-status', { platform: 'twitter', loggedIn: true });
      twitterLoginWindow.close();
    }
  });

  twitterLoginWindow.on('closed', () => {
    twitterLoginWindow = null;
    checkTwitterLoginStatus();
  });
}

// ── Facebook Login Window ──────────────────────────────────────────────────

function openFacebookLoginWindow() {
  if (facebookLoginWindow) {
    facebookLoginWindow.focus();
    return;
  }

  facebookLoginWindow = new BrowserWindow({
    width: 500,
    height: 720,
    parent: mainWindow,
    modal: true,
    title: 'Login to Facebook',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  facebookLoginWindow.setMenuBarVisibility(false);
  facebookLoginWindow.loadURL('https://www.facebook.com/login/');

  facebookLoginWindow.webContents.on('did-navigate', (_e, url) => {
    if (
      url === 'https://www.facebook.com/' ||
      url === 'https://www.facebook.com' ||
      url.startsWith('https://www.facebook.com/?') ||
      url.startsWith('https://www.facebook.com/home')
    ) {
      mainWindow.webContents.send('login-status', { platform: 'facebook', loggedIn: true });
      facebookLoginWindow.close();
    }
  });

  facebookLoginWindow.on('closed', () => {
    facebookLoginWindow = null;
    checkFacebookLoginStatus();
  });
}

// ── LinkedIn Login Window ──────────────────────────────────────────────────

function openLinkedInLoginWindow() {
  if (linkedinLoginWindow) {
    linkedinLoginWindow.focus();
    return;
  }

  linkedinLoginWindow = new BrowserWindow({
    width: 500,
    height: 720,
    parent: mainWindow,
    modal: true,
    title: 'Login to LinkedIn',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  linkedinLoginWindow.setMenuBarVisibility(false);
  linkedinLoginWindow.loadURL('https://www.linkedin.com/login');

  // LinkedIn redirects through various URLs after login.  Only close the
  // window when we can confirm the li_at session cookie is actually set.
  let linkedinLoginClosed = false;
  let linkedinPollTimer = null;

  const tryCloseIfLoggedIn = async () => {
    if (linkedinLoginClosed) return;
    try {
      // Search all cookies — li_at may be on .linkedin.com or .www.linkedin.com
      const allCookies = await session.defaultSession.cookies.get({});
      const authCookie = allCookies.find(c => c.name === 'li_at' && c.value.length > 0 && c.domain.includes('linkedin'));
      if (authCookie) {
        linkedinLoginClosed = true;
        if (linkedinPollTimer) { clearInterval(linkedinPollTimer); linkedinPollTimer = null; }
        mainWindow.webContents.send('login-status', { platform: 'linkedin', loggedIn: true });
        if (linkedinLoginWindow && !linkedinLoginWindow.isDestroyed()) linkedinLoginWindow.close();
        return true;
      }
    } catch (_) {}
    return false;
  };

  const checkLinkedInUrl = (url) => {
    return url.startsWith('https://www.linkedin.com/feed') ||
           url.startsWith('https://www.linkedin.com/mynetwork') ||
           url.startsWith('https://www.linkedin.com/in/') ||
           (url.startsWith('https://www.linkedin.com/') && !url.includes('/login') && !url.includes('/checkpoint'));
  };

  // When we navigate to a logged-in-looking URL, start polling for the cookie
  const startPolling = () => {
    if (linkedinPollTimer || linkedinLoginClosed) return;
    linkedinPollTimer = setInterval(tryCloseIfLoggedIn, 1500);
    // Also try immediately
    tryCloseIfLoggedIn();
  };

  linkedinLoginWindow.webContents.on('did-navigate', (_e, url) => {
    if (checkLinkedInUrl(url)) startPolling();
  });

  linkedinLoginWindow.webContents.on('will-redirect', (_e, url) => {
    if (checkLinkedInUrl(url)) startPolling();
  });

  linkedinLoginWindow.webContents.on('did-finish-load', () => {
    const url = linkedinLoginWindow.webContents.getURL();
    if (checkLinkedInUrl(url)) startPolling();
  });

  linkedinLoginWindow.on('closed', () => {
    if (linkedinPollTimer) { clearInterval(linkedinPollTimer); linkedinPollTimer = null; }
    linkedinLoginWindow = null;
    checkLinkedInLoginStatus();
  });
}

// ── Login Status Checks ────────────────────────────────────────────────────

async function checkLoginStatus() {
  try {
    const cookies = await session.defaultSession.cookies.get({
      domain: '.instagram.com',
      name: 'sessionid',
    });
    const loggedIn = cookies.length > 0 && cookies[0].value.length > 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'instagram', loggedIn });
    }
    if (!loggedIn) {
      // Only notify if there are Instagram feeds
      const feeds = store.get('feeds');
      if (feeds.some(f => (f.platform || 'instagram') === 'instagram')) {
        addNotification('warning', 'Instagram session expired — please log in again');
      }
    } else {
      resolveNotificationsBySubstring('Instagram session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

async function checkTwitterLoginStatus() {
  try {
    // Check both .x.com and x.com domains
    const cookies = await session.defaultSession.cookies.get({ domain: 'x.com' });
    const authCookie = cookies.find(c => (c.name === 'auth_token' || c.name === 'ct0') && c.value.length > 0);
    const loggedIn = !!authCookie;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'twitter', loggedIn });
    }
    if (!loggedIn) {
      const feeds = store.get('feeds');
      if (feeds.some(f => f.platform === 'twitter')) {
        addNotification('warning', 'Twitter/X session expired — please log in again');
      }
    } else {
      resolveNotificationsBySubstring('Twitter/X session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

async function checkFacebookLoginStatus() {
  try {
    const cookies = await session.defaultSession.cookies.get({
      domain: '.facebook.com',
      name: 'c_user',
    });
    const loggedIn = cookies.length > 0 && cookies[0].value.length > 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'facebook', loggedIn });
    }
    if (!loggedIn) {
      const feeds = store.get('feeds');
      if (feeds.some(f => f.platform === 'facebook')) {
        addNotification('warning', 'Facebook session expired — please log in again');
      }
    } else {
      resolveNotificationsBySubstring('Facebook session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

async function checkLinkedInLoginStatus() {
  try {
    // Search all cookies — li_at may be on .linkedin.com, www.linkedin.com, etc.
    const allCookies = await session.defaultSession.cookies.get({});
    const authCookie = allCookies.find(c => c.name === 'li_at' && c.value.length > 0 && c.domain.includes('linkedin'));
    const loggedIn = !!authCookie;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'linkedin', loggedIn });
    }
    if (!loggedIn) {
      const feeds = store.get('feeds');
      if (feeds.some(f => f.platform === 'linkedin')) {
        addNotification('warning', 'LinkedIn session expired — please log in again');
      }
    } else {
      resolveNotificationsBySubstring('LinkedIn session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

// Instagram auth
ipcMain.handle('open-login', () => openLoginWindow());
ipcMain.handle('check-login', () => checkLoginStatus());
ipcMain.handle('logout', async () => {
  await session.defaultSession.clearStorageData({
    origins: ['https://www.instagram.com', 'https://instagram.com'],
  });
  mainWindow.webContents.send('login-status', { platform: 'instagram', loggedIn: false });
});

// Twitter auth
ipcMain.handle('open-twitter-login', () => openTwitterLoginWindow());
ipcMain.handle('check-twitter-login', () => checkTwitterLoginStatus());
ipcMain.handle('logout-twitter', async () => {
  await session.defaultSession.clearStorageData({
    origins: ['https://x.com', 'https://twitter.com'],
  });
  mainWindow.webContents.send('login-status', { platform: 'twitter', loggedIn: false });
});

// Facebook auth
ipcMain.handle('open-facebook-login', () => openFacebookLoginWindow());
ipcMain.handle('check-facebook-login', () => checkFacebookLoginStatus());
ipcMain.handle('logout-facebook', async () => {
  await session.defaultSession.clearStorageData({
    origins: ['https://www.facebook.com', 'https://facebook.com'],
  });
  mainWindow.webContents.send('login-status', { platform: 'facebook', loggedIn: false });
});

// LinkedIn auth
ipcMain.handle('open-linkedin-login', () => openLinkedInLoginWindow());
ipcMain.handle('check-linkedin-login', () => checkLinkedInLoginStatus());
ipcMain.handle('logout-linkedin', async () => {
  await session.defaultSession.clearStorageData({
    origins: ['https://www.linkedin.com', 'https://linkedin.com'],
  });
  mainWindow.webContents.send('login-status', { platform: 'linkedin', loggedIn: false });
});

// Force reset: clear ALL cookies + storage for a platform (nuclear option)
ipcMain.handle('force-reset-platform', async (_e, platform) => {
  const domainMap = {
    instagram: ['https://www.instagram.com', 'https://instagram.com'],
    twitter: ['https://x.com', 'https://twitter.com', 'https://api.twitter.com'],
    facebook: ['https://www.facebook.com', 'https://facebook.com'],
    linkedin: ['https://www.linkedin.com', 'https://linkedin.com'],
  };
  const origins = domainMap[platform];
  if (!origins) return;

  // Clear all storage types for these origins
  for (const origin of origins) {
    await session.defaultSession.clearStorageData({ origin });
  }

  // Also nuke cookies by domain (catches subdomains the origin-based clear might miss)
  const domainParts = {
    instagram: ['instagram.com'],
    twitter: ['x.com', 'twitter.com'],
    facebook: ['facebook.com'],
    linkedin: ['linkedin.com'],
  };
  for (const domain of (domainParts[platform] || [])) {
    const cookies = await session.defaultSession.cookies.get({ domain });
    for (const cookie of cookies) {
      const url = `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      await session.defaultSession.cookies.remove(url, cookie.name).catch(() => {});
    }
  }

  mainWindow.webContents.send('login-status', { platform, loggedIn: false });
  return true;
});

ipcMain.handle('get-feeds', () => {
  return store.get('feeds');
});

ipcMain.handle('add-feed', async (_e, url) => {
  const parsed = parseProfileInput(url);
  if (!parsed) throw new Error('Invalid URL or username. Supported: Instagram, Twitter/X, Facebook');

  const { username, platform } = parsed;
  const feeds = store.get('feeds');

  // Use platform+username as unique key so same username on different platforms is allowed
  if (feeds.find((f) => f.username === username && f.platform === platform)) {
    throw new Error(`Already tracking @${username} on ${platform}`);
  }

  let profileData;
  if (platform === 'twitter') {
    profileData = await scrapeTwitterProfile(username);
  } else if (platform === 'facebook') {
    profileData = await scrapeFacebookProfile(username, parsed.subTab, parsed.fullUrl);
  } else if (platform === 'linkedin') {
    profileData = await scrapeLinkedInProfile(username);
  } else {
    profileData = await scrapeInstagramProfile(username);
  }

  if (profileData.posts.length < 1) {
    throw new Error(
      `Found no posts for @${username} on ${platform}. ` +
      'Make sure you are logged in and the profile is accessible.'
    );
  }

  // Re-focus main window after hidden scraper window was destroyed
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

  const profileUrls = {
    twitter: `https://x.com/${username}`,
    facebook: `https://www.facebook.com/${username}`,
    instagram: `https://www.instagram.com/${username}/`,
    linkedin: `https://www.linkedin.com/in/${username}`,
  };

  // For group/event identifiers with slashes, use a sanitized key for the feed filename
  const feedKey = username.replace(/\//g, '-');

  const realPostsAdd = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
  const latestPostDate = realPostsAdd.length > 0
    ? new Date(Math.max(...realPostsAdd.map(p => new Date(p.timestamp).getTime()))).toISOString()
    : null;

  const entry = {
    url: profileUrls[platform] || profileUrls.instagram,
    username,
    feedKey,
    platform,
    subTab: parsed.subTab || null,
    fullUrl: parsed.fullUrl || null,
    alias: username,
    lastChecked: new Date().toISOString(),
    postCount: profileData.posts.length,
    latestPostDate,
  };

  feeds.push(entry);
  store.set('feeds', feeds);

  await generateFeed(feedKey, profileData, store, platform);
  return entry;
});

ipcMain.handle('rename-feed', (_e, username, platform, newAlias) => {
  const fs = require('fs');
  const feedDir = require('./rss-generator').getFeedDir();
  const feeds = store.get('feeds').map((f) => {
    if (f.username === username && (f.platform || 'instagram') === (platform || 'instagram')) {
      const oldFeedKey = (f.feedKey || f.username).replace(/\//g, '-');
      // Sanitize alias to create a URL-safe feed key
      const newFeedKey = newAlias.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      // Rename existing RSS/Atom files on disk
      const oldRss = path.join(feedDir, `${oldFeedKey}.rss.xml`);
      const oldAtom = path.join(feedDir, `${oldFeedKey}.atom.xml`);
      const newRss = path.join(feedDir, `${newFeedKey}.rss.xml`);
      const newAtom = path.join(feedDir, `${newFeedKey}.atom.xml`);
      try { if (fs.existsSync(oldRss)) fs.renameSync(oldRss, newRss); } catch (_) {}
      try { if (fs.existsSync(oldAtom)) fs.renameSync(oldAtom, newAtom); } catch (_) {}
      return { ...f, alias: newAlias, feedKey: newFeedKey };
    }
    return f;
  });
  store.set('feeds', feeds);
  return feeds;
});

ipcMain.handle('remove-feed', (_e, username, platform) => {
  const feeds = store.get('feeds').filter((f) =>
    !(f.username === username && (f.platform || 'instagram') === (platform || 'instagram'))
  );
  store.set('feeds', feeds);
  return feeds;
});

ipcMain.handle('refresh-feed', async (_e, username, platform) => {
  platform = platform || 'instagram';
  let profileData;
  try {
    if (platform === 'twitter') {
      profileData = await scrapeTwitterProfile(username);
    } else if (platform === 'facebook') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'facebook');
      profileData = await scrapeFacebookProfile(username, feedEntry?.subTab, feedEntry?.fullUrl);
    } else if (platform === 'linkedin') {
      profileData = await scrapeLinkedInProfile(username);
    } else {
      profileData = await scrapeInstagramProfile(username);
    }
  } catch (err) {
    addNotification('error', `Failed to refresh @${username}: ${err.message}`);
    throw err;
  }

  const storedFeed = store.get('feeds').find((f) => f.username === username && (f.platform || 'instagram') === platform);
  const feedKey = (storedFeed?.feedKey || username).replace(/\//g, '-');
  await generateFeed(feedKey, profileData, store, platform);

  // Re-focus main window after hidden scraper window was destroyed
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

  // Resolve any previous errors for this feed
  resolveNotificationsBySubstring(`@${username}`);

  const realPostsRefresh = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
  const latestPostDate = realPostsRefresh.length > 0
    ? new Date(Math.max(...realPostsRefresh.map(p => new Date(p.timestamp).getTime()))).toISOString()
    : null;

  const feeds = store.get('feeds').map((f) => {
    if (f.username === username && (f.platform || 'instagram') === platform) {
      return {
        ...f,
        lastChecked: new Date().toISOString(),
        postCount: profileData.posts.length,
        latestPostDate: latestPostDate || f.latestPostDate || null,
      };
    }
    return f;
  });
  store.set('feeds', feeds);
  return feeds.find((f) => f.username === username && (f.platform || 'instagram') === platform);
});

ipcMain.handle('refresh-all', async () => {
  const feedsSnapshot = store.get('feeds');
  const results = [];

  for (const feed of feedsSnapshot) {
    try {
      const platform = feed.platform || 'instagram';
      let profileData;
      if (platform === 'twitter') {
        profileData = await scrapeTwitterProfile(feed.username);
      } else if (platform === 'facebook') {
        profileData = await scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
      } else if (platform === 'linkedin') {
        profileData = await scrapeLinkedInProfile(feed.username);
      } else {
        profileData = await scrapeInstagramProfile(feed.username);
      }
      await generateFeed((feed.feedKey || feed.username).replace(/\//g, '-'), profileData, store, platform);

      // Re-read store and update only this entry to avoid overwriting concurrent additions
      const currentFeeds = store.get('feeds');
      const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === platform);
      if (idx !== -1) {
        currentFeeds[idx].lastChecked = new Date().toISOString();
        currentFeeds[idx].postCount = profileData.posts.length;
        const realPostsRA = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
        currentFeeds[idx].latestPostDate = realPostsRA.length > 0
          ? new Date(Math.max(...realPostsRA.map(p => new Date(p.timestamp).getTime()))).toISOString()
          : currentFeeds[idx].latestPostDate || null;
        store.set('feeds', currentFeeds);
      }
      results.push({ username: feed.username, success: true });
    } catch (err) {
      results.push({ username: feed.username, success: false, error: err.message });
      addNotification('error', `Refresh failed @${feed.username}: ${err.message}`);
    }
  }

  return results;
});

ipcMain.handle('get-server-port', () => {
  return store.get('serverPort');
});

ipcMain.handle('open-external', (_e, url) => {
  shell.openExternal(url);
});

ipcMain.handle('export-opml', (_e, groups, tunnelDomain) => {
  try {
    // Determine export directory: beside the exe for portable, or app path
    const exportDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    let fileCount = 0;

    for (const [category, feeds] of Object.entries(groups)) {
      const platformMap = { 'Instagram': 'instagram', 'Twitter': 'twitter', 'Facebook': 'facebook', 'LinkedIn': 'linkedin' };
      const platformUrlBase = {
        'Instagram': 'https://www.instagram.com/',
        'Twitter': 'https://x.com/',
        'Facebook': 'https://www.facebook.com/',
        'LinkedIn': 'https://www.linkedin.com/in/',
      };

      let outlines = '';
      for (const feed of feeds) {
        const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
        const xmlUrl = `https://${tunnelDomain}/feed/${feedKey}`;
        const htmlUrl = `${platformUrlBase[category] || ''}${feed.username}/`;
        const title = escapeXml(feed.alias || feed.username);
        outlines += `      <outline text="${title}" title="${title}" type="rss" xmlUrl="${escapeXml(xmlUrl)}" htmlUrl="${escapeXml(htmlUrl)}"/>\n`;
      }

      const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head>\n    <title>${category} feeds from UnSocial</title>\n  </head>\n  <body>\n    <outline text="${category}" title="${category}">\n${outlines}    </outline>\n  </body>\n</opml>\n`;

      const filePath = path.join(exportDir, `${category}.xml`);
      fs.writeFileSync(filePath, opml, 'utf-8');
      fileCount++;
    }

    return { success: true, fileCount };
  } catch (err) {
    console.error('[Export OPML] Error:', err.message);
    return { success: false, error: err.message };
  }
});

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── Tunnel IPC Handlers ────────────────────────────────────────────────────

ipcMain.handle('tunnel-check-installed', async () => {
  return tunnel.checkCloudflaredInstalled();
});

ipcMain.handle('tunnel-check-authenticated', () => {
  return { authenticated: tunnel.checkAuthenticated() };
});

ipcMain.handle('tunnel-check-setup', async () => {
  return tunnel.checkTunnelSetup(store);
});

ipcMain.handle('tunnel-run-setup', async (_e, step) => {
  const tunnelName = store.get('tunnelName');
  const domain = store.get('tunnelDomain');

  switch (step) {
    case 'login':
      return tunnel.runSetupCommand(['tunnel', 'login']);
    case 'create':
      return tunnel.runSetupCommand(['tunnel', 'create', tunnelName]);
    case 'dns':
      return tunnel.runSetupCommand(['tunnel', 'route', 'dns', tunnelName, domain]);
    default:
      throw new Error(`Unknown setup step: ${step}`);
  }
});

ipcMain.handle('tunnel-start', () => {
  return tunnel.startTunnel(store);
});

ipcMain.handle('tunnel-stop', () => {
  tunnel.stopTunnel();
  return { status: 'stopped' };
});

ipcMain.handle('tunnel-state', () => {
  return tunnel.getTunnelState(store);
});

ipcMain.handle('tunnel-get-settings', () => {
  return {
    domain: store.get('tunnelDomain'),
    tunnelName: store.get('tunnelName'),
    autoStart: store.get('tunnelAutoStart'),
  };
});

ipcMain.handle('tunnel-save-settings', (_e, settings) => {
  if (settings.domain) store.set('tunnelDomain', settings.domain);
  if (settings.tunnelName) store.set('tunnelName', settings.tunnelName);
  if (typeof settings.autoStart === 'boolean') store.set('tunnelAutoStart', settings.autoStart);
  return true;
});

// ── Notification IPC Handlers ─────────────────────────────────────────────

ipcMain.handle('get-notifications', () => {
  return notificationLog;
});

ipcMain.handle('resolve-notification', (_e, id) => {
  resolveNotification(id);
  return notificationLog;
});

ipcMain.handle('clear-notifications', () => {
  notificationLog.length = 0;
  hasActiveErrors = false;
  recalcTrayIcon();
  sendNotificationsToRenderer();
  return [];
});

// ── Helpers ────────────────────────────────────────────────────────────────

function parseProfileInput(input) {
  input = input.trim().replace(/\/+$/, '');

  // Facebook group URL: https://www.facebook.com/groups/groupname
  // Also handles sub-pages: /groups/groupname/events, /groups/groupname/discussion, etc.
  const fbGroupMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(groups\/[a-zA-Z0-9._-]+)(?:\/(events|discussion|members|about|media|buy_sell_discussion))?/
  );
  if (fbGroupMatch) {
    const groupPath = fbGroupMatch[1]; // e.g. "groups/CalgaryMetalSceneEvents"
    const subTab = fbGroupMatch[2] || null; // e.g. "events" or null
    return { username: groupPath, platform: 'facebook', subTab };
  }

  // Facebook "My Events" page (bare /events with optional query params)
  //  e.g. https://www.facebook.com/events/?date_filter_option=ANY_DATE&...
  const fbMyEventsMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/events\/?(?:\?.*)?$/
  );
  if (fbMyEventsMatch) {
    const fullUrl = input.startsWith('http') ? input : 'https://www.facebook.com/events/';
    return { username: 'events', platform: 'facebook', subTab: 'my_events', fullUrl };
  }

  // Facebook event URL: https://www.facebook.com/events/123456789
  const fbEventMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(events\/[a-zA-Z0-9._-]+)/
  );
  if (fbEventMatch) return { username: fbEventMatch[1], platform: 'facebook' };

  // Facebook page URL: https://www.facebook.com/pagename
  const fbMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]+)/
  );
  if (fbMatch) {
    const page = fbMatch[1];
    if (['login', 'groups', 'events', 'watch', 'marketplace', 'gaming', 'pages', 'profile.php'].includes(page)) return null;
    return { username: page, platform: 'facebook' };
  }

  // Twitter / X URL: https://x.com/username or https://twitter.com/username
  const twitterMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?(x|twitter)\.com\/([a-zA-Z0-9_]+)/
  );
  if (twitterMatch) {
    const user = twitterMatch[2];
    if (['i', 'home', 'explore', 'search', 'settings', 'messages'].includes(user)) return null;
    return { username: user, platform: 'twitter' };
  }

  // LinkedIn profile URL: https://www.linkedin.com/in/username/ or company page
  const liProfileMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9._-]+)/
  );
  if (liProfileMatch) return { username: liProfileMatch[1], platform: 'linkedin' };

  // LinkedIn company URL: https://www.linkedin.com/company/companyname/
  const liCompanyMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(company\/[a-zA-Z0-9._-]+)/
  );
  if (liCompanyMatch) return { username: liCompanyMatch[1], platform: 'linkedin' };

  // Instagram URL: https://www.instagram.com/username/
  const igMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/
  );
  if (igMatch) return { username: igMatch[1], platform: 'instagram' };

  // Bare @username or username — default to Instagram
  const bare = input.replace(/^@/, '');
  if (/^[a-zA-Z0-9._]{1,30}$/.test(bare)) return { username: bare, platform: 'instagram' };

  return null;
}
