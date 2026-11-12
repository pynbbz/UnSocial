const { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, nativeImage, dialog } = require('electron');
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
} else if (process.platform === 'darwin') {
  // macOS portable mode: share the same UnSocial-userdata folder across platforms.
  // Note: Keeping UnSocial.app itself inside OneDrive causes OneDrive FileProvider on macOS
  // to strip symlinks inside Electron Framework.framework, breaking child renderer processes.
  // Supporting /Applications/UnSocial.app while pointing userData at the shared OneDrive folder
  // keeps the .app bundle safe from OneDrive symlink eviction.
  const os = require('os');
  const sharedOneDriveUserData = path.join(
    os.homedir(),
    'Library/CloudStorage/OneDrive-Personal/Documents/!Desktop/NoSocial/UnSocial-userdata'
  );
  const appBundlePath = app.getAppPath().replace(/\/Contents\/Resources\/app(\.asar)?$/, '');
  const appDir = path.dirname(appBundlePath);
  if (!appDir.startsWith('/Applications') && !appDir.endsWith('/Development/UnSocial')) {
    const newUserData = path.join(appDir, 'UnSocial-userdata');
    if (!fs.existsSync(newUserData)) {
      fs.mkdirSync(newUserData, { recursive: true });
    }
    app.setPath('userData', newUserData);
  } else if (fs.existsSync(sharedOneDriveUserData)) {
    app.setPath('userData', sharedOneDriveUserData);
  }
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
const { scrapeTxtFile } = require('./scraper-txt');
const { scrapeReddit, extractSubredditOrUser } = require('./scraper-reddit');
const { scrapeTelegramChannel, parseTelegramInput, listTelegramChannels } = require('./scraper-telegram');
const { scrapeCalendar, parseCalendarInput } = require('./scraper-calendar');
const { startCustomWizard, scrapeCustomSiteHeadless, getSiteCookies, clearSiteCookiesAndStorage, getDomainPartsFromUrl, detectLoginState, isStrictAuthCookieName, isPhpBBSite, isCloudflareChallenge, DETECT_LOGIN_STATE_JS } = require('./scraper-custom');
const { generateFeed, getFeedDir } = require('./rss-generator');
const { normalizeFeedPublicBaseUrlInput, resolveFeedBaseUrl } = require('./feed-url-base');
const { getRealisticUserAgent } = require('./user-agent');
const tunnel = require('./tunnel');

// Disable Blink AutomationControlled feature so Chromium does not expose automation
// flags (navigator.webdriver) to Cloudflare Turnstile / anti-bot challenges.
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Set realistic desktop Chrome UA fallback for Web Workers and sub-contexts (prevents Turnstile worker UA mismatch)
app.userAgentFallback = getRealisticUserAgent();

const crypto = require('crypto');

const store = new Store({
  defaults: {
    feeds: [],       // Array of { url, username, alias, lastChecked }
    serverPort: 3845,
    checkIntervalMinutes: 30,
    tunnelProvider: 'cloudflare', // 'cloudflare' | 'tailscale'
    tunnelDomain: '',
    tunnelName: 'unsocial-tunnel',
    tunnelAutoStart: false,
    feedToken: '',   // When non-empty, all feed-server requests require this token
    feedPublicBaseUrl: '', // Optional origin for RSS/Atom self-links (LAN / port proxy); empty = localhost
    remoteUsername: 'admin',
    remotePassword: '',
    remoteWebUrl: '',
    remoteWebEnabled: true,
    windowState: {
      width: 960,
      height: 700,
      x: null,
      y: null,
      isMaximized: true,
      hasSavedState: false,
    },
  }
});

if (!store.get('remotePassword')) {
  store.set('remotePassword', crypto.randomBytes(6).toString('hex'));
}
if (!store.get('remoteUsername')) {
  store.set('remoteUsername', 'admin');
}

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

function removeNotificationsBySubstring(substr) {
  for (let i = notificationLog.length - 1; i >= 0; i--) {
    if (notificationLog[i].message.includes(substr)) {
      notificationLog.splice(i, 1);
    }
  }
  sendNotificationsToRenderer();
  recalcTrayIcon();
}

function removeStaleNotificationsForFeed(username) {
  for (let i = notificationLog.length - 1; i >= 0; i--) {
    const n = notificationLog[i];
    if (n.message.includes(`@${username}`) && n.message.includes('stale')) {
      notificationLog.splice(i, 1);
    }
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

// Last known tunnel status, mirrored from provider callbacks so the tray
// icon can be recalculated synchronously.
let lastTunnelStatus = 'stopped';

function recalcTrayIcon() {
  try {
    const tunnelOk = lastTunnelStatus === 'running';
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
      removeNotificationsBySubstring('Internet connection');
    }
  }, 30000); // check every 30s
}

// ── Stale Feed Notification Checker ────────────────────────────────────────

let staleFeedCheckInterval = null;

const MAX_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours hard cap
const BOOST_MAX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours for boosted feeds
const BOOST_PRIORITY_MS = 45 * 60 * 1000; // boosted feeds sort ~45 min older

function getMaxStaleMs(feed) {
  return feed.boosted ? BOOST_MAX_STALE_MS : MAX_STALE_MS;
}

function checkStaleFeedsNotifications() {
  try {
    const feeds = store.get('feeds');
    const now = Date.now();
    for (const feed of feeds) {
      if (isCustomFeedPaused(feed)) continue; // paused feeds already show a login warning
      const lastChecked = feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0;
      const age = now - lastChecked;
      if (age > getMaxStaleMs(feed)) {
        // Only add notification if there isn't already an unresolved one for this feed about staleness
        const existing = notificationLog.find(n =>
          !n.resolved && n.message.includes(`@${feed.username}`) && n.message.includes('stale')
        );
        if (!existing) {
          const hoursAgo = Math.floor(age / (60 * 60 * 1000));
          addNotification('warning', `@${feed.username} feed is stale (last updated ${hoursAgo}h ago)`);
        }
      } else {
        // Feed is no longer stale — remove stale-only notifications for it.
        removeStaleNotificationsForFeed(feed.username);
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
let isCustomLoginWindowOpen = false;

const SCRAPE_TIMEOUT_MS = 180_000; // 3-minute hard cap per scrape

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function getFeedLastCheckedMs(feed) {
  return feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0;
}

function getEffectiveLastCheckedMs(feed) {
  const base = getFeedLastCheckedMs(feed);
  return feed.boosted ? base - BOOST_PRIORITY_MS : base;
}

function sortFeedsByRefreshPriority(feeds) {
  return [...feeds].sort((a, b) => getEffectiveLastCheckedMs(a) - getEffectiveLastCheckedMs(b));
}

function getRandomInterval(forBoosted = false) {
  const feeds = store.get('feeds');
  const feedCount = Math.max(feeds.length, 1);

  // If any feed is boosted, the whole queue must cycle within the tighter
  // boosted threshold (2 h) since we refresh one feed at a time.
  const hasBoosted = feeds.some(f => f.boosted);
  const tightestStaleMs = hasBoosted ? BOOST_MAX_STALE_MS : MAX_STALE_MS;
  const maxSafeMinutes = (tightestStaleMs / 60000) / feedCount * 0.7;

  const baseMax = forBoosted ? 20 : 65;
  const maxMinutes = Math.min(baseMax, Math.max(maxSafeMinutes, 1));
  const minMinutes = Math.max(1, maxMinutes * 0.4);

  const minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return Math.round(minutes * 60 * 1000);
}

function scheduleNextRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);

  let interval = getRandomInterval();

  try {
    const feeds = store.get('feeds');
    if (feeds.length > 0) {
      const nextFeed = sortFeedsByRefreshPriority(feeds)[0];
      interval = getRandomInterval(!!nextFeed.boosted);

      const oldestTime = getFeedLastCheckedMs(nextFeed);
      const age = Date.now() - oldestTime;
      const timeUntilStale = getMaxStaleMs(nextFeed) - age;

      const minGap = nextFeed.platform === 'facebook' ? 45 * 1000 : 5 * 1000;
      if (timeUntilStale <= 0) {
        interval = minGap;
      } else if (timeUntilStale < interval) {
        interval = Math.max(timeUntilStale - 2 * 60 * 1000, minGap);
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
  if (isRefreshing || isCustomLoginWindowOpen) {
    scheduleNextRefresh();
    return;
  }
  isRefreshing = true;
  let feed = null;

  try {
    // Feeds paused because of a login problem are skipped until the user re-logs in,
    // so we don't keep hitting the site (and trigger "too many attempts" lockouts).
    const feeds = store.get('feeds').filter(f => !isCustomFeedPaused(f));
    if (feeds.length === 0) {
      scheduleNextRefresh();
      isRefreshing = false;
      return;
    }

    feed = sortFeedsByRefreshPriority(feeds)[0];
    const platform = feed.platform || 'instagram';
    console.log(`[Smart-refresh] Refreshing @${feed.username} (${platform}), last checked: ${feed.lastChecked || 'never'}`);

    let profileData;
    const scrapeLabel = `Auto-refresh @${feed.username}`;
    if (platform === 'twitter') profileData = await withTimeout(scrapeTwitterProfile(feed.username), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'facebook') profileData = await withTimeout(scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'linkedin') profileData = await withTimeout(scrapeLinkedInProfile(feed.username), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'txt') profileData = await withTimeout(scrapeTxtFile(feed.fullUrl || feed.url), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'reddit') profileData = await withTimeout(scrapeReddit(feed.fullUrl || feed.url), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'telegram') profileData = await withTimeout(scrapeTelegramChannel(feed, { telegramLoggedIn: Boolean(store.get('telegramLoggedIn')) }), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'calendar') profileData = await withTimeout(scrapeCalendar(feed, { feedDir: getFeedDir() }), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else if (platform === 'custom') profileData = await withTimeout(scrapeCustomSiteHeadless(feed.fullUrl, feed.selector, feed.alias || feed.username, feed.scrollSelector, feed.scrollCount, { usesLogin: Boolean(feed.usesLogin) }), SCRAPE_TIMEOUT_MS, scrapeLabel);
    else profileData = await withTimeout(scrapeInstagramProfile(feed.username), SCRAPE_TIMEOUT_MS, scrapeLabel);

    const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
    profileData.feedKey = feedKey;
    profileData.alias = feed.alias;
    profileData.fullUrl = feed.fullUrl || feed.url;
    profileData.directExternalLink = Boolean(feed.directExternalLink);
    profileData.filterKeywords = feed.filterKeywords || [];
    const feedResult = await generateFeed(feedKey, profileData, store, platform);

    // Update only this entry
    const currentFeeds = store.get('feeds');
    const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === platform);
    if (idx !== -1) {
      currentFeeds[idx].lastChecked = new Date().toISOString();
      currentFeeds[idx].postCount = feedResult?.postCount ?? profileData.posts.length;
      const realPosts = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
      const postsWithTs = realPosts.length > 0 ? realPosts : profileData.posts.filter(p => p.timestamp);
      currentFeeds[idx].latestPostDate = postsWithTs.length > 0
        ? new Date(Math.max(...postsWithTs.map(p => new Date(p.timestamp).getTime()))).toISOString()
        : currentFeeds[idx].latestPostDate || null;
      store.set('feeds', currentFeeds);
    }
    if (platform === 'custom') recordCustomFeedSuccess(feed.username, profileData.loginState);

    // Resolve any previous error for this feed
    resolveNotificationsBySubstring(`@${feed.username}`);
    removeStaleNotificationsForFeed(feed.username);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('feeds-updated');
    }
    console.log(`[Smart-refresh] @${feed.username} done (${profileData.posts.length} posts)`);
  } catch (err) {
    const msg = `Failed to refresh @${feed?.username || 'unknown'}: ${err.message}`;
    console.error('[Smart-refresh]', msg);
    addNotification('error', msg);

    // Move the failing feed to the back of the queue so other feeds get
    // their turn.  Setting lastChecked to "now" means this feed won't be
    // retried until every other feed has been refreshed first.
    if (feed) {
      try {
        const currentFeeds = store.get('feeds');
        const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === (feed.platform || 'instagram'));
        if (idx !== -1) {
          currentFeeds[idx].lastChecked = new Date().toISOString();
          store.set('feeds', currentFeeds);
          console.log(`[Smart-refresh] Moved @${feed.username} to back of queue after failure`);
        }
        if ((feed.platform || 'instagram') === 'custom') recordCustomFeedFailure(feed.username, err);
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
  const realisticUA = getRealisticUserAgent();
  app.userAgentFallback = realisticUA;
  ses.setUserAgent(realisticUA);

  // Strip restrictive Content-Security-Policy on LinkedIn so embedded resources and subframes don't trigger ERR_BLOCKED_BY_CSP
  ses.webRequest.onHeadersReceived(
    { urls: ['*://*.linkedin.com/*', '*://*.licdn.com/*'] },
    (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['Content-Security-Policy'];
      delete responseHeaders['content-security-policy-report-only'];
      delete responseHeaders['Content-Security-Policy-Report-Only'];
      callback({ responseHeaders });
    }
  );

  createMainWindow();
  createTray();
  startFeedServer(store, {
    addFeed: (input) => addFeedCore(input),
    saveCustomFeed: (data) => saveCustomFeedCore(data),
    refreshFeed: (username, platform) => refreshFeedCore(username, platform),
    refreshAll: () => refreshAllCore(),
    checkPlatforms: () => checkAllPlatforms(),
    renameFeed: (username, platform, newAlias, filterKeywords, usesLogin) => renameFeedCore(username, platform, newAlias, filterKeywords, usesLogin),
    listTelegramChannels: () => listTelegramChannels(),
    confirmCustomLogin: (username) => confirmCustomLoginCore(username),
  });
  startInternetMonitor();
  startStaleFeedMonitor();
  scheduleNextRefresh();

  // Forward tunnel status changes to the renderer + update tray icon
  tunnel.onTunnelStatusChange((data) => {
    try {
      // Only track status updates from the currently active provider so a
      // backgrounded one doesn't clobber the tray icon.
      if (!data.provider || data.provider === tunnel.getProviderId(store)) {
        if (data.status) lastTunnelStatus = data.status;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel-status', data);
      }
      if (data.status === 'error') {
        addNotification('error', 'Tunnel disconnected: ' + (data.message || 'unknown error'));
        if (data.message) {
          const match = data.message.match(/https:\/\/login\.tailscale\.com\/f\/[^\s]+/);
          if (match) {
            shell.openExternal(match[0]).catch((err) => {
              console.error('[Tunnel] Failed to open external URL:', err.message);
            });
          }
        }
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
    const providerId = tunnel.getProviderId(store);

    // Kill any orphaned child processes from a previous session (cloudflared
    // specifically; tailscale runs as a daemon and doesn't need this).
    tunnel.killOrphaned(store);

    const sendStatus = (msg) => {
      console.log(`[Tunnel:${providerId}] ` + msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel-status', { status: 'starting', message: msg, provider: providerId });
      }
    };

    try {
      const installed = await tunnel.checkInstalled(store);
      if (!installed.installed) {
        const binName = providerId === 'tailscale' ? 'tailscale' : 'cloudflared';
        console.log(`[Tunnel] ${binName} not installed — skipping auto-start`);
        return;
      }
      sendStatus(`${providerId} client found (` + installed.version + ')');

      if (providerId === 'cloudflare') {
        // Check authentication (cert.pem)
        if (!(await tunnel.checkAuthenticated(store))) {
          sendStatus('Not authenticated — opening login...');
          const loginResult = await tunnel.runWizardStep(store, 'login');
          if (!loginResult.success) {
            console.log('[Tunnel] Login failed:', loginResult.output);
            return;
          }
          sendStatus('Authentication complete');
        }

        // Check if tunnel exists, create if needed
        const tunnelName = store.get('tunnelName');
        const domain = store.get('tunnelDomain');
        const setup = await tunnel.checkSetup(store);
        if (!setup.exists) {
          sendStatus('Creating tunnel "' + tunnelName + '"...');
          const createResult = await tunnel.runWizardStep(store, 'create');
          if (!createResult.success && !createResult.output.includes('already exists')) {
            console.log('[Tunnel] Create failed:', createResult.output);
            return;
          }
          sendStatus('Tunnel created');
        }

        // Route DNS (idempotent — safe to re-run)
        sendStatus('Routing DNS for ' + domain + '...');
        await tunnel.runWizardStep(store, 'dns');
      } else if (providerId === 'tailscale') {
        // For Tailscale the only prerequisite we can verify is that the node
        // is logged in — funnel policy / HTTPS must be enabled in the admin
        // console beforehand. We surface errors via the tunnel log.
        if (!(await tunnel.checkAuthenticated(store))) {
          console.log('[Tunnel] tailscale not logged in — skipping auto-start');
          sendStatus('Tailscale not logged in');
          return;
        }
      }

      // Start tunnel
      sendStatus('Starting tunnel...');
      await tunnel.startTunnel(store);

      // Wait for tunnel to connect, then refresh all feeds
      let tunnelPollAttempts = 0;
      const tunnelPollInterval = setInterval(async () => {
        tunnelPollAttempts++;
        const tState = await tunnel.getTunnelState(store);
        if (tState.status === 'running') {
          clearInterval(tunnelPollInterval);
          console.log('[Tunnel] Connected — refreshing all feeds');
          const feedsSnapshot = store.get('feeds');
          for (const feed of feedsSnapshot) {
            // Re-check the live store: a login failure on one feed pauses every feed on that domain.
            const liveFeed = store.get('feeds').find(f => f.username === feed.username && (f.platform || 'instagram') === (feed.platform || 'instagram'));
            if (!liveFeed || isCustomFeedPaused(liveFeed)) continue;
            try {
              const plat = feed.platform || 'instagram';
              let profileData;
              if (plat === 'twitter') profileData = await scrapeTwitterProfile(feed.username);
              else if (plat === 'facebook') profileData = await scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
              else if (plat === 'linkedin') profileData = await scrapeLinkedInProfile(feed.username);
              else if (plat === 'txt') profileData = await scrapeTxtFile(feed.fullUrl || feed.url);
              else if (plat === 'reddit') profileData = await scrapeReddit(feed.fullUrl || feed.url);
              else if (plat === 'telegram') profileData = await scrapeTelegramChannel(feed, { telegramLoggedIn: Boolean(store.get('telegramLoggedIn')) });
              else if (plat === 'calendar') profileData = await scrapeCalendar(feed, { feedDir: getFeedDir() });
              else if (plat === 'custom') profileData = await scrapeCustomSiteHeadless(feed.fullUrl, feed.selector, feed.alias || feed.username, feed.scrollSelector, feed.scrollCount, { usesLogin: Boolean(feed.usesLogin) });
              else profileData = await scrapeInstagramProfile(feed.username);
              const fk = (feed.feedKey || feed.username).replace(/\//g, '-');
              profileData.feedKey = fk;
              profileData.alias = feed.alias;
              profileData.fullUrl = feed.fullUrl || feed.url;
              profileData.directExternalLink = Boolean(feed.directExternalLink);
              profileData.filterKeywords = feed.filterKeywords || [];
              const genResult = await generateFeed(fk, profileData, store, plat);

              // Re-read store and update only this entry to avoid overwriting concurrent additions
              const currentFeeds = store.get('feeds');
              const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === (plat));
              if (idx !== -1) {
                currentFeeds[idx].lastChecked = new Date().toISOString();
                currentFeeds[idx].postCount = genResult?.postCount ?? profileData.posts.length;
                const realPostsT = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
                const postsWithTsT = realPostsT.length > 0 ? realPostsT : profileData.posts.filter(p => p.timestamp);
                currentFeeds[idx].latestPostDate = postsWithTsT.length > 0
                  ? new Date(Math.max(...postsWithTsT.map(p => new Date(p.timestamp).getTime()))).toISOString()
                  : currentFeeds[idx].latestPostDate || null;
                store.set('feeds', currentFeeds);
              }
              if (plat === 'custom') recordCustomFeedSuccess(feed.username, profileData.loginState);

            } catch (err) {
              console.error('[Post-tunnel refresh] Failed @' + feed.username + ':', err.message);
              addNotification('error', 'Post-tunnel refresh failed @' + feed.username + ': ' + err.message);
              if ((feed.platform || 'instagram') === 'custom') recordCustomFeedFailure(feed.username, err);
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
  // Ensure any child tunnel process is fully killed before the app exits.
  // For Tailscale (daemon-managed), this is a no-op — Funnel stays configured
  // across sessions, which matches user expectations for that provider.
  Promise.resolve(tunnel.stopTunnel(store)).catch(() => {});
});

app.on('window-all-closed', () => {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  if (internetCheckInterval) clearInterval(internetCheckInterval);
  if (staleFeedCheckInterval) clearInterval(staleFeedCheckInterval);
  Promise.resolve(tunnel.stopTunnel(store)).catch(() => {});
  stopFeedServer();
  app.quit();
});

// ── Main Window ────────────────────────────────────────────────────────────

function createMainWindow() {
  const savedWindowState = store.get('windowState') || {};
  const hasValidPosition = Number.isInteger(savedWindowState.x) && Number.isInteger(savedWindowState.y);

  const windowOptions = {
    width: Number.isInteger(savedWindowState.width) ? savedWindowState.width : 960,
    height: Number.isInteger(savedWindowState.height) ? savedWindowState.height : 700,
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
  };

  if (hasValidPosition) {
    windowOptions.x = savedWindowState.x;
    windowOptions.y = savedWindowState.y;
  }

  mainWindow = new BrowserWindow({
    ...windowOptions,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  if (savedWindowState.isMaximized || !savedWindowState.hasSavedState) {
    mainWindow.maximize();
  }

  const saveWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const isMaximized = mainWindow.isMaximized();
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();

    store.set('windowState', {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
      hasSavedState: true,
    });
  };

  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  // Minimize to tray instead of taskbar
  mainWindow.on('minimize', (e) => {
    saveWindowState();
    e.preventDefault();
    mainWindow.hide();
  });

  // Close button truly quits (default behavior)
  mainWindow.on('close', (e) => {
    saveWindowState();
    if (!isQuitting) {
      isQuitting = true;
      if (tray) { tray.destroy(); tray = null; }
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.maximize();

  mainWindow.show();
  mainWindow.focus();
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
    { label: 'Show', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });

  tray.on('double-click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
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
let redditLoginWindow = null;

function openLoginWindow() {
  if (loginWindow) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 460,
    height: 720,
    parent: mainWindow,
    modal: false,
    title: 'Login to Instagram',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  loginWindow.setMenuBarVisibility(false);
  const chromeUA = getRealisticUserAgent();
  loginWindow.webContents.session.setUserAgent(chromeUA);
  loginWindow.webContents.setUserAgent(chromeUA);
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
    width: 650,
    height: 780,
    parent: mainWindow,
    modal: false,
    title: 'Login to Twitter / X',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  twitterLoginWindow.setMenuBarVisibility(false);

  const chromeUA = getRealisticUserAgent();
  twitterLoginWindow.webContents.session.setUserAgent(chromeUA);
  twitterLoginWindow.webContents.setUserAgent(chromeUA);

  // Allow popups for Google and Apple OAuth
  twitterLoginWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' };
  });

  // Inject helper banner explaining that Twitter/X web requires Username (@handle), not email
  const injectTwitterBanner = `
    (function() {
      if (document.getElementById('unsocial-twitter-tip')) return;
      const bar = document.createElement('div');
      bar.id = 'unsocial-twitter-tip';
      bar.innerHTML = '<strong>Tip:</strong> Please enter your <strong>Twitter username (@handle)</strong>, NOT your email address. X blocks email logins on desktop web browsers.';
      bar.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:9999999; background:#1d9bf0; color:#fff; padding:10px 16px; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; font-size:13px; line-height:1.4; text-align:center; box-shadow:0 2px 10px rgba(0,0,0,0.35); transition:background 0.3s;';
      document.body.appendChild(bar);

      // Watch for X's download_app_pivot redirect which happens if an email is entered
      setInterval(() => {
        const hash = window.location.hash || '';
        const bodyText = document.body ? document.body.innerText : '';
        if (hash.includes('download_app_pivot') || bodyText.includes('Get the app to finish signing up using email')) {
          bar.style.background = '#e0245e';
          bar.innerHTML = '<strong>⚠️ X blocked this email address!</strong> Please click the back arrow (←) above and enter your <strong>Twitter username (@handle)</strong> instead.';
        }
      }, 500);
    })();
  `;

  twitterLoginWindow.webContents.on('did-finish-load', () => {
    if (twitterLoginWindow && !twitterLoginWindow.isDestroyed()) {
      twitterLoginWindow.webContents.executeJavaScript(injectTwitterBanner).catch(() => {});
    }
  });

  twitterLoginWindow.webContents.on('did-navigate-in-page', () => {
    if (twitterLoginWindow && !twitterLoginWindow.isDestroyed()) {
      twitterLoginWindow.webContents.executeJavaScript(injectTwitterBanner).catch(() => {});
    }
  });

  twitterLoginWindow.loadURL('https://x.com/i/flow/login');

  let twitterLoginClosed = false;
  let twitterPollTimer = null;

  const tryCloseIfLoggedIn = async () => {
    if (twitterLoginClosed) return;
    try {
      const cookies = await session.defaultSession.cookies.get({ domain: 'x.com' });
      const authCookie = cookies.find(c => c.name === 'auth_token' && c.value.length > 0);
      if (authCookie) {
        twitterLoginClosed = true;
        if (twitterPollTimer) { clearInterval(twitterPollTimer); twitterPollTimer = null; }
        mainWindow.webContents.send('login-status', { platform: 'twitter', loggedIn: true });
        if (twitterLoginWindow && !twitterLoginWindow.isDestroyed()) twitterLoginWindow.close();
        return true;
      }
    } catch (_) {}
    return false;
  };

  twitterPollTimer = setInterval(tryCloseIfLoggedIn, 1500);

  const checkUrl = (url) => {
    if (url.startsWith('https://x.com/home') || url.startsWith('https://twitter.com/home')) {
      tryCloseIfLoggedIn();
    }
  };

  twitterLoginWindow.webContents.on('did-navigate', (_e, url) => checkUrl(url));
  twitterLoginWindow.webContents.on('did-navigate-in-page', (_e, url) => checkUrl(url));

  twitterLoginWindow.on('closed', () => {
    if (twitterPollTimer) { clearInterval(twitterPollTimer); twitterPollTimer = null; }
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
    modal: false,
    title: 'Login to Facebook',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  facebookLoginWindow.setMenuBarVisibility(false);
  const chromeUA = getRealisticUserAgent();
  facebookLoginWindow.webContents.session.setUserAgent(chromeUA);
  facebookLoginWindow.webContents.setUserAgent(chromeUA);
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
    modal: false,
    title: 'Login to LinkedIn',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  linkedinLoginWindow.setMenuBarVisibility(false);
  const chromeUA = getRealisticUserAgent();
  linkedinLoginWindow.webContents.session.setUserAgent(chromeUA);
  linkedinLoginWindow.webContents.setUserAgent(chromeUA);
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

// ── Reddit Login Window ───────────────────────────────────────────────────

function openRedditLoginWindow() {
  if (redditLoginWindow) {
    redditLoginWindow.focus();
    return;
  }

  redditLoginWindow = new BrowserWindow({
    width: 520,
    height: 720,
    parent: mainWindow,
    modal: false,
    title: 'Login to Reddit',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  redditLoginWindow.setMenuBarVisibility(false);
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  redditLoginWindow.webContents.session.setUserAgent(chromeUA);
  redditLoginWindow.webContents.setUserAgent(chromeUA);

  redditLoginWindow.loadURL('https://www.reddit.com/login/');

  const checkClose = async (url) => {
    try {
      const cookies = await session.defaultSession.cookies.get({ domain: 'reddit.com' });
      const authCookie = cookies.find(c => (c.name === 'reddit_session' || c.name === 'token' || c.name === 'session') && c.value.length > 0);
      if (authCookie && !url.includes('/login') && !url.includes('/register') && !url.includes('/password')) {
        mainWindow.webContents.send('login-status', { platform: 'reddit', loggedIn: true });
        if (redditLoginWindow && !redditLoginWindow.isDestroyed()) redditLoginWindow.close();
      }
    } catch (_) {}
  };

  redditLoginWindow.webContents.on('did-navigate', (_e, url) => {
    checkClose(url);
  });

  redditLoginWindow.on('closed', () => {
    redditLoginWindow = null;
    checkRedditLoginStatus();
  });
}

let telegramLoginWindow = null;
function openTelegramLoginWindow() {
  if (telegramLoginWindow && !telegramLoginWindow.isDestroyed()) {
    telegramLoginWindow.focus();
    return;
  }

  telegramLoginWindow = new BrowserWindow({
    width: 520,
    height: 700,
    parent: mainWindow,
    modal: true,
    title: 'Log into Telegram (for Private Channels)',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      partition: undefined,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  telegramLoginWindow.setMenuBarVisibility(false);
  const chromeUA = getRealisticUserAgent();
  telegramLoginWindow.webContents.session.setUserAgent(chromeUA);
  telegramLoginWindow.webContents.setUserAgent(chromeUA);

  telegramLoginWindow.loadURL('https://web.telegram.org/k/');

  // Poll localStorage inside Telegram Web K to detect when QR/phone login completes
  const authPollInterval = setInterval(async () => {
    if (!telegramLoginWindow || telegramLoginWindow.isDestroyed()) {
      clearInterval(authPollInterval);
      return;
    }
    try {
      const isAuthed = await telegramLoginWindow.webContents.executeJavaScript(`
        (function() {
          try {
            const raw = localStorage.getItem('user_auth') || localStorage.getItem('account1');
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return Boolean(parsed && (parsed.id || parsed.userId));
          } catch (_) {
            return false;
          }
        })()
      `);
      if (isAuthed) {
        clearInterval(authPollInterval);
        store.set('telegramLoggedIn', true);
        resolveNotificationsBySubstring('Telegram session');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('login-status', { platform: 'telegram', loggedIn: true });
        }
        if (telegramLoginWindow && !telegramLoginWindow.isDestroyed()) {
          telegramLoginWindow.close();
        }
      }
    } catch (_) {}
  }, 1200);

  telegramLoginWindow.on('closed', () => {
    clearInterval(authPollInterval);
    telegramLoginWindow = null;
    checkTelegramLoginStatus();
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
    // Check both x.com and twitter.com for actual auth_token cookie
    const xCookies = await session.defaultSession.cookies.get({ domain: 'x.com' });
    const twCookies = await session.defaultSession.cookies.get({ domain: 'twitter.com' });
    const allCookies = [...xCookies, ...twCookies];
    const authCookie = allCookies.find(c => c.name === 'auth_token' && c.value.length > 0);
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

async function checkRedditLoginStatus() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'reddit.com' });
    const authCookie = cookies.find(c => (c.name === 'reddit_session' || c.name === 'token' || c.name === 'session') && c.value.length > 0);
    const loggedIn = !!authCookie;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'reddit', loggedIn });
    }
    if (!loggedIn) {
      const feeds = store.get('feeds');
      if (feeds.some(f => f.platform === 'reddit')) {
        addNotification('warning', 'Reddit session expired — please log in again');
      }
    } else {
      resolveNotificationsBySubstring('Reddit session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

async function checkTelegramLoginStatus() {
  try {
    const loggedIn = Boolean(store.get('telegramLoggedIn'));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-status', { platform: 'telegram', loggedIn });
    }
    if (!loggedIn) {
      const feeds = store.get('feeds');
      // Only warn if user has private Telegram channels (public channels do not require login)
      if (feeds.some(f => f.platform === 'telegram' && (f.isPrivate || String(f.username || '').startsWith('c/') || String(f.username || '').startsWith('invite/')))) {
        addNotification('warning', 'Telegram session required for private channels — please log in');
      }
    } else {
      resolveNotificationsBySubstring('Telegram session');
    }
    return loggedIn;
  } catch {
    return false;
  }
}

// ── Custom Website Login State ─────────────────────────────────────────────
//
// loggedIn semantics for custom feeds with usesLogin:
//   true  → the page itself showed a logged-in session (e.g. a "Log out" link)
//   false → the page showed a login form / login link / "must be logged in"
//   null  → not yet verified (site gives no clear signal either way)
// Cookies are NOT trusted to mean "logged in": many sites (phpBB forums such as
// Mobilism) set "session" cookies for guests too.

function getFeedBaseDomain(f) {
  return getDomainPartsFromUrl(f.fullUrl || f.url || '').baseDomain || '';
}

function isCustomFeedPaused(f) {
  return (f.platform || 'instagram') === 'custom' && Boolean(f.loginPaused);
}

function notifyFeedsUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }
}

/**
 * Record a failed custom-feed scrape. Login failures pause auto-refresh for the
 * feed AND every other login-based feed on the same domain, so we stop hitting
 * the site until the user re-logs in.
 */
function recordCustomFeedFailure(username, err) {
  const feeds = store.get('feeds');
  const target = feeds.find(f => f.username === username && (f.platform || 'instagram') === 'custom');
  if (!target) return;

  target.lastError = err.message;

  if (err.isLoginError) {
    const domain = getFeedBaseDomain(target);
    const nowIso = new Date().toISOString();
    const pausedNames = [];
    for (const f of feeds) {
      if ((f.platform || 'instagram') !== 'custom') continue;
      const sameGroup = f === target || (domain && f.usesLogin && getFeedBaseDomain(f) === domain);
      if (!sameGroup) continue;
      f.loginError = true;
      f.loggedIn = false;
      if (!f.loginPaused) f.loginPausedAt = nowIso;
      f.loginPaused = true;
      if (err.lockedOut) f.loginLockedOut = true;
      if (f !== target) {
        f.lastError = `Paused — login problem detected on ${domain} (via "${target.alias || target.username}"). Re-login to resume.`;
      }
      pausedNames.push(f.alias || f.username);
    }
    addNotification(
      'warning',
      `${domain || 'Custom site'} login ${err.lockedOut ? 'locked (too many attempts)' : 'expired'} — auto-refresh paused for ${pausedNames.length} feed${pausedNames.length === 1 ? '' : 's'} until you re-login (@${username})`
    );
  }

  store.set('feeds', feeds);
  notifyFeedsUpdated();
}

/** Record a successful custom-feed scrape and its page-detected login state. */
function recordCustomFeedSuccess(username, loginState) {
  const feeds = store.get('feeds').map((f) => {
    if (!(f.username === username && (f.platform || 'instagram') === 'custom')) return f;
    const next = {
      ...f,
      loginError: false,
      lastError: null,
      loginPaused: false,
      loginPausedAt: null,
      loginLockedOut: false,
    };
    if (f.usesLogin) {
      if (loginState === 'logged-in') {
        next.loggedIn = true;
        next.loginVerifiedAt = new Date().toISOString();
      }
      // If scrape succeeded, retain current loggedIn state and do not pause feed
    }
    return next;
  });
  store.set('feeds', feeds);
  notifyFeedsUpdated();
}

/** Clear pause / error state for all login feeds on a domain after a verified re-login. */
function markCustomDomainLoggedIn(domain, username, authCookieNames) {
  const nowIso = new Date().toISOString();
  const feeds = store.get('feeds').map((f) => {
    if ((f.platform || 'instagram') !== 'custom') return f;
    const isTarget = username && f.username === username;
    const sameDomain = domain && getFeedBaseDomain(f) === domain && (f.usesLogin || f.loginError || f.loginPaused);
    if (!isTarget && !sameDomain) return f;
    return {
      ...f,
      usesLogin: true,
      loggedIn: true,
      loginVerifiedAt: nowIso,
      loginError: false,
      loginPaused: false,
      loginPausedAt: null,
      loginLockedOut: false,
      lastError: null,
      authCookieNames: authCookieNames && authCookieNames.length ? authCookieNames : (f.authCookieNames || []),
    };
  });
  store.set('feeds', feeds);
  for (const f of feeds) {
    if ((f.platform || 'instagram') === 'custom' && domain && getFeedBaseDomain(f) === domain) {
      resolveNotificationsBySubstring(`@${f.username}`);
    }
  }
  notifyFeedsUpdated();
}

/**
 * Lightweight, request-free status check (runs on get-feeds / platform checks).
 * Groups feeds by domain so all feeds from the same website stay in sync.
 */
async function checkCustomFeedsLoginStatus() {
  try {
    const feeds = store.get('feeds');
    let changed = false;

    // Cache cookies and login state per baseDomain so multiple feeds from the same website stay consistent
    const domainStatusCache = new Map();

    for (const f of feeds) {
      if ((f.platform || 'instagram') !== 'custom') continue;

      if (f.usesLogin === undefined) {
        f.usesLogin = false;
        f.loggedIn = false;
        changed = true;
        continue;
      }

      if (!f.usesLogin) {
        if (f.loggedIn !== false) {
          f.loggedIn = false;
          changed = true;
        }
        continue;
      }

      const domain = getFeedBaseDomain(f);
      if (!domain) continue;

      let status = domainStatusCache.get(domain);
      if (!status) {
        status = await getSiteCookies(f.fullUrl || f.url);
        domainStatusCache.set(domain, status);
      }

      // If site is a forum like phpBB (such as Mobilism), verify registered user ID
      const isPhpBB = isPhpBBSite(status.all, domain);
      if (isPhpBB) {
        if (status.isPhpBBLoggedIn && !f.loginLockedOut) {
          if (f.loggedIn !== true || f.loginError) {
            f.loggedIn = true;
            f.loginError = false;
            f.loginPaused = false;
            f.lastError = null;
            changed = true;
          }
          continue;
        } else {
          // phpBB guest session or missing authenticated user cookie
          if (f.loggedIn !== false || !f.loginError || !f.loginPaused) {
            f.loggedIn = false;
            f.loginError = true;
            f.loginPaused = true;
            if (!f.lastError || f.lastError.includes('guest session')) {
              f.lastError = 'Session expired — not logged in. Re-login needed.';
            }
            changed = true;
          }
          continue;
        }
      }

      // If saved session cookies disappeared entirely → definitely logged out.
      const names = Array.isArray(f.authCookieNames) ? f.authCookieNames : [];
      if (names.length > 0 && f.loggedIn !== false) {
        const present = new Set(status.all.map((c) => c.name));
        if (!names.some((n) => present.has(n))) {
          f.loggedIn = false;
          f.loginError = true;
          f.loginPaused = true;
          f.lastError = 'Session expired — login cookies missing. Re-login needed.';
          changed = true;
        }
      }
    }

    if (changed) {
      store.set('feeds', feeds);
    }
    return feeds;
  } catch (err) {
    console.error('[Custom Login Check] Error:', err.message);
    return store.get('feeds');
  }
}

async function checkAllPlatforms() {
  await checkCustomFeedsLoginStatus();
  return {
    instagram: await checkLoginStatus(),
    twitter: await checkTwitterLoginStatus(),
    facebook: await checkFacebookLoginStatus(),
    linkedin: await checkLinkedInLoginStatus(),
    reddit: await checkRedditLoginStatus(),
    telegram: await checkTelegramLoginStatus(),
  };
}

// ── IPC Handlers ───────────────────────────────────────────────────────────

// Instagram auth
ipcMain.handle('get-app-version', () => app.getVersion());
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

// Reddit auth
ipcMain.handle('open-reddit-login', () => openRedditLoginWindow());
ipcMain.handle('check-reddit-login', () => checkRedditLoginStatus());
ipcMain.handle('logout-reddit', async () => {
  await session.defaultSession.clearStorageData({
    origins: ['https://www.reddit.com', 'https://reddit.com'],
  });
  mainWindow.webContents.send('login-status', { platform: 'reddit', loggedIn: false });
});

ipcMain.handle('parse-reddit-url', (_e, input) => {
  return parseRedditInput(input);
});

// Telegram auth (needed only for private channels)
ipcMain.handle('open-telegram-login', () => openTelegramLoginWindow());
ipcMain.handle('check-telegram-login', () => checkTelegramLoginStatus());
ipcMain.handle('logout-telegram', async () => {
  store.set('telegramLoggedIn', false);
  await session.defaultSession.clearStorageData({
    origins: ['https://web.telegram.org', 'https://t.me'],
  });
  mainWindow.webContents.send('login-status', { platform: 'telegram', loggedIn: false });
});
ipcMain.handle('list-telegram-channels', async () => {
  return await listTelegramChannels();
});

// Calendar helpers
ipcMain.handle('parse-calendar-url', (_e, input) => {
  return parseCalendarInput(input, { forceCalendar: true });
});

ipcMain.handle('pick-calendar-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Select iCalendar (.ics) File',
    properties: ['openFile'],
    filters: [
      { name: 'iCalendar Files (.ics)', extensions: ['ics', 'ical', 'ifb', 'vcs'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Force reset: clear ALL cookies + storage for a platform (nuclear option)
ipcMain.handle('force-reset-platform', async (_e, platform) => {
  const domainMap = {
    instagram: ['https://www.instagram.com', 'https://instagram.com'],
    twitter: ['https://x.com', 'https://twitter.com', 'https://api.twitter.com'],
    facebook: ['https://www.facebook.com', 'https://facebook.com'],
    linkedin: ['https://www.linkedin.com', 'https://linkedin.com'],
    reddit: ['https://www.reddit.com', 'https://reddit.com'],
    telegram: ['https://web.telegram.org', 'https://t.me', 'https://telegram.org'],
  };
  const origins = domainMap[platform];
  if (!origins) return;

  if (platform === 'telegram') {
    store.set('telegramLoggedIn', false);
  }

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
    reddit: ['reddit.com'],
    telegram: ['telegram.org', 't.me'],
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

ipcMain.handle('get-feeds', async () => {
  return await checkCustomFeedsLoginStatus();
});

async function addFeedCore(input) {
  let parsed;
  const hasExplicitAlias = Boolean(typeof input === 'object' && input !== null && input.alias && String(input.alias).trim());
  if (typeof input === 'object' && input !== null) {
    const rawUrl = (input.targetUrl || input.fullUrl || input.url || '').trim();
    if (input.platform === 'calendar') {
      parsed = parseCalendarInput(input, { forceCalendar: true });
    } else if (input.platform === 'reddit' || rawUrl.includes('reddit.com') || /^\/??(?:r|u|user)\//i.test(rawUrl)) {
      const fromUrl = parseRedditInput(rawUrl) || {};
      const username = input.username || fromUrl.username || 'r-reddit-feed';
      const fullUrl = rawUrl || fromUrl.fullUrl || '';
      parsed = {
        ...fromUrl,
        ...input,
        platform: 'reddit',
        username,
        fullUrl,
        alias: input.alias || fromUrl.alias || username,
        feedKey: input.feedKey || fromUrl.username || username.replace(/[^a-zA-Z0-9_-]/g, '-'),
      };
    } else if (input.platform && input.username) {
      parsed = input;
    } else {
      parsed = parseProfileInput(rawUrl || input);
      if (parsed && input.alias) parsed.alias = input.alias;
    }
  } else {
    parsed = parseProfileInput(input);
  }

  if (!parsed) throw new Error('Invalid URL or username. Supported: Telegram, Reddit, Calendar (.ics / Google / Outlook), Instagram, Twitter/X, Facebook, LinkedIn, any website URL, or .txt URLs');

  let { username, platform } = parsed;

  // Custom websites get routed to the wizard flow
  if (platform === 'custom') {
    return await handleAddCustomFeed(parsed);
  }

  const feeds = store.get('feeds');

  // Use platform+username as unique key so same username on different platforms is allowed
  if (feeds.find((f) => f.username === username && f.platform === platform)) {
    throw new Error(`Already tracking ${parsed.alias || username} on ${platform}`);
  }

  let profileData;
  if (platform === 'twitter') {
    profileData = await scrapeTwitterProfile(username);
  } else if (platform === 'facebook') {
    profileData = await scrapeFacebookProfile(username, parsed.subTab, parsed.fullUrl);
  } else if (platform === 'linkedin') {
    profileData = await scrapeLinkedInProfile(username);
  } else if (platform === 'txt') {
    profileData = await scrapeTxtFile(parsed.fullUrl);
  } else if (platform === 'reddit') {
    profileData = await scrapeReddit(parsed.fullUrl);
  } else if (platform === 'calendar') {
    profileData = await scrapeCalendar(parsed, { feedDir: getFeedDir() });
  } else if (platform === 'telegram') {
    profileData = await scrapeTelegramChannel(parsed, {
      telegramLoggedIn: Boolean(store.get('telegramLoggedIn')),
    });
    // If an invite link (invite/HASH) resolved to a permanent channel username (c/12345 or public handle), adopt it
    if (profileData && profileData.username && profileData.username !== username) {
      username = profileData.username;
      if (feeds.find((f) => f.username === username && f.platform === platform)) {
        throw new Error(`Already tracking ${profileData.fullName || username} on Telegram`);
      }
    }
  } else {
    profileData = await scrapeInstagramProfile(username);
  }

  if (profileData.posts.length < 1) {
    throw new Error(
      platform === 'txt'
        ? `Found no entries in ${parsed.fullUrl}. Make sure the file is a valid changelog.`
        : platform === 'calendar'
          ? `Found no events in calendar (${parsed.fullUrl}). Make sure the calendar has events and is publicly accessible.`
          : platform === 'reddit'
            ? `Found no posts for ${parsed.alias || username} on Reddit. Make sure the subreddit exists or check your search/sort options.`
            : platform === 'telegram'
              ? `Found no posts for ${parsed.alias || username} on Telegram. If this is a private channel, make sure you are logged into Telegram.`
              : `Found no posts for @${username} on ${platform}. ` +
                'Make sure you are logged in and the profile is accessible.'
    );
  }

  // Re-focus main window after hidden scraper window was destroyed
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

  const isOrg = Boolean(username && typeof username === 'string' && (username.startsWith('company/') || username.startsWith('showcase/') || username.startsWith('school/')));
  const isPrivateTg = platform === 'telegram' && Boolean(profileData.isPrivate ?? parsed.isPrivate ?? username.startsWith('c/'));
  const profileUrls = {
    twitter: `https://x.com/${username}`,
    facebook: `https://www.facebook.com/${username}`,
    instagram: `https://www.instagram.com/${username}/`,
    linkedin: isOrg ? `https://www.linkedin.com/${username}` : `https://www.linkedin.com/in/${username}`,
    txt: parsed.fullUrl || (typeof input === 'string' ? input : ''),
    reddit: parsed.fullUrl || (typeof input === 'string' ? input : ''),
    calendar: profileData.siteUrl || parsed.siteUrl || parsed.fullUrl || (typeof input === 'string' ? input : ''),
    telegram: isPrivateTg
      ? `https://t.me/${username}`
      : `https://t.me/s/${username}`,
  };

  // Clean feedKey for safe filenames and URL routes
  const feedKey = (parsed.feedKey || username).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const realPostsAdd = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
  const postsWithTsAdd = realPostsAdd.length > 0 ? realPostsAdd : profileData.posts.filter(p => p.timestamp);
  const latestPostDate = postsWithTsAdd.length > 0
    ? new Date(Math.max(...postsWithTsAdd.map(p => new Date(p.timestamp).getTime()))).toISOString()
    : null;

  const defaultAlias =
    (platform === 'calendar' && !hasExplicitAlias && profileData.fullName ? profileData.fullName : null) ||
    parsed.alias ||
    (platform === 'telegram' && isPrivateTg && profileData.fullName ? profileData.fullName : username);

  const entry = {
    url: profileUrls[platform] || profileUrls.instagram,
    username,
    feedKey,
    platform,
    isPrivate: platform === 'telegram' ? isPrivateTg : undefined,
    chatId: platform === 'telegram' ? (profileData.chatId || parsed.chatId || null) : undefined,
    calendarProvider: platform === 'calendar' ? (profileData.calendarProvider || parsed.calendarProvider || 'ics') : undefined,
    calendarProviderLabel: platform === 'calendar' ? (profileData.calendarProviderLabel || parsed.calendarProviderLabel || 'Calendar') : undefined,
    siteUrl: platform === 'calendar' ? (profileData.siteUrl || parsed.siteUrl || parsed.fullUrl) : undefined,
    subTab: parsed.subTab || null,
    fullUrl: parsed.fullUrl || (platform === 'txt' || platform === 'reddit' || platform === 'telegram' || platform === 'calendar' ? profileUrls[platform] : null),
    alias: defaultAlias,
    directExternalLink: Boolean(parsed.directExternalLink),
    filterKeywords: parsed.filterKeywords || [],
    lastChecked: new Date().toISOString(),
    postCount: profileData.posts.length,
    latestPostDate,
  };

  feeds.push(entry);
  store.set('feeds', feeds);

  profileData.feedKey = feedKey;
  profileData.alias = entry.alias;
  profileData.fullUrl = entry.fullUrl;
  profileData.directExternalLink = entry.directExternalLink;
  profileData.filterKeywords = entry.filterKeywords;
  const genResultAdd = await generateFeed(feedKey, profileData, store, platform);
  if (genResultAdd && typeof genResultAdd.postCount === 'number') {
    entry.postCount = genResultAdd.postCount;
    store.set('feeds', feeds);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }

  return entry;
}

ipcMain.handle('add-feed', async (_e, input) => {
  return await addFeedCore(input);
});

// ── Custom Website Feed (wizard-based) ─────────────────────────────────────

async function saveCustomFeedCore({ pageUrl, selector, feedName, scrollSelector, scrollCount, usesLogin, authCookieNames, loginState, profileData }) {
  if (!profileData || profileData.posts.length < 1) {
    throw new Error('No items were found. Try clicking on a different element.');
  }

  // Re-focus main window
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

  const feeds = store.get('feeds');

  // Prevent exact duplicate custom URL tracking while allowing multiple feeds from the same domain.
  const normalizedPageUrl = normalizeUrlForComparison(pageUrl);
  if (feeds.find((f) =>
    f.platform === 'custom' && normalizeUrlForComparison(f.fullUrl || f.url) === normalizedPageUrl
  )) {
    throw new Error(`Already tracking this custom URL: ${pageUrl}`);
  }

  // Keep a stable internal username (ID) derived from URL, not display feedName.
  const baseUsername = (feedName || 'custom-feed')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-feed';
  const username = ensureUniqueCustomUsername(baseUsername, feeds, normalizedPageUrl);

  const feedKey = username.replace(/\//g, '-');

  const realPostsAdd = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
  const postsWithTsAdd = realPostsAdd.length > 0 ? realPostsAdd : profileData.posts.filter(p => p.timestamp);
  const latestPostDate = postsWithTsAdd.length > 0
    ? new Date(Math.max(...postsWithTsAdd.map(p => new Date(p.timestamp).getTime()))).toISOString()
    : null;

  const isCustomLoggedIn = Boolean(usesLogin) && loginState === 'logged-in';
  const isCustomLoggedOut = Boolean(usesLogin) && loginState === 'logged-out';

  const entry = {
    url: pageUrl,
    username,
    feedKey,
    platform: 'custom',
    subTab: null,
    fullUrl: pageUrl,
    selector,
    scrollSelector: scrollSelector || null,
    scrollCount: scrollCount || 0,
    usesLogin: Boolean(usesLogin),
    loggedIn: isCustomLoggedIn,
    loginError: isCustomLoggedOut,
    loginPaused: isCustomLoggedOut,
    authCookieNames: Array.isArray(authCookieNames) ? authCookieNames : [],
    lastError: isCustomLoggedOut ? 'Login session required. Click Re-login to sign in.' : null,
    alias: feedName || username,
    filterKeywords: [],
    lastChecked: new Date().toISOString(),
    postCount: profileData.posts.length,
    latestPostDate,
  };

  feeds.push(entry);
  store.set('feeds', feeds);

  profileData.feedKey = feedKey;
  profileData.alias = entry.alias;
  profileData.fullUrl = entry.fullUrl;
  profileData.filterKeywords = entry.filterKeywords;
  const genResultCustom = await generateFeed(feedKey, profileData, store, 'custom');
  if (genResultCustom && typeof genResultCustom.postCount === 'number') {
    entry.postCount = genResultCustom.postCount;
    store.set('feeds', feeds);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }

  return entry;
}

async function handleAddCustomFeed(parsed) {
  isCustomLoginWindowOpen = true;
  try {
    const result = await startCustomWizard(parsed.fullUrl, mainWindow);
    return await saveCustomFeedCore({ ...result, pageUrl: result.pageUrl || parsed.fullUrl });
  } finally {
    isCustomLoginWindowOpen = false;
  }
}

function normalizeUrlForComparison(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';

    const sortedParams = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [key, value] of sortedParams) {
      u.searchParams.append(key, value);
    }
    return u.toString();
  } catch {
    return String(rawUrl).trim();
  }
}

function ensureUniqueCustomUsername(baseUsername, feeds, uniquenessSeed) {
  const existing = new Set(
    feeds
      .filter((f) => (f.platform || 'instagram') === 'custom')
      .map((f) => f.username)
  );

  if (!existing.has(baseUsername)) return baseUsername;

  const shortHash = crypto
    .createHash('sha1')
    .update(uniquenessSeed || baseUsername)
    .digest('hex')
    .slice(0, 6);

  let candidate = `${baseUsername}-${shortHash}`;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${baseUsername}-${shortHash}-${counter}`;
    counter += 1;
  }
  return candidate;
}

ipcMain.handle('start-custom-feed', async (_e, url) => {
  const parsed = parseProfileInput(url);
  if (!parsed) throw new Error('Invalid URL');
  return await handleAddCustomFeed(parsed);
});

ipcMain.handle('toggle-feed-boost', (_e, username, platform) => {
  const plat = platform || 'instagram';
  const feeds = store.get('feeds');
  const idx = feeds.findIndex((f) => f.username === username && (f.platform || 'instagram') === plat);
  if (idx === -1) throw new Error('Feed not found');
  feeds[idx].boosted = !feeds[idx].boosted;
  store.set('feeds', feeds);
  scheduleNextRefresh();
  return feeds[idx];
});

async function renameFeedCore(username, platform, newAlias, filterKeywords, usesLogin) {
  const fs = require('fs');
  const feedDir = require('./rss-generator').getFeedDir();
  const currentFeeds = store.get('feeds');
  let targetFeed = null;
  let oldFeedKey = '';
  let newFeedKey = '';
  let aliasToUse = '';

  // Parse and clean filterKeywords
  let parsedKeywords = null;
  if (Array.isArray(filterKeywords)) {
    parsedKeywords = filterKeywords.map(k => String(k).trim()).filter(Boolean);
  } else if (typeof filterKeywords === 'string') {
    parsedKeywords = filterKeywords.split(/[,\n]+/).map(k => k.trim()).filter(Boolean);
  }

  const feeds = currentFeeds.map((f) => {
    if (f.username === username && (f.platform || 'instagram') === (platform || 'instagram')) {
      aliasToUse = (newAlias && typeof newAlias === 'string' && newAlias.trim()) ? newAlias.trim() : (f.alias || f.username);
      oldFeedKey = (f.feedKey || f.username).replace(/\//g, '-');
      // Sanitize alias to create a URL-safe feed key
      newFeedKey = aliasToUse
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || oldFeedKey;

      const oldRss = path.join(feedDir, `${oldFeedKey}.rss.xml`);
      const oldAtom = path.join(feedDir, `${oldFeedKey}.atom.xml`);
      const oldData = path.join(feedDir, `${oldFeedKey}.data.json`);
      const newRss = path.join(feedDir, `${newFeedKey}.rss.xml`);
      const newAtom = path.join(feedDir, `${newFeedKey}.atom.xml`);
      const newData = path.join(feedDir, `${newFeedKey}.data.json`);

      if (oldFeedKey !== newFeedKey) {
        try { if (fs.existsSync(oldRss)) fs.renameSync(oldRss, newRss); } catch (_) {}
        try { if (fs.existsSync(oldAtom)) fs.renameSync(oldAtom, newAtom); } catch (_) {}
        try { if (fs.existsSync(oldData)) fs.renameSync(oldData, newData); } catch (_) {}
      }

      const activeKeywords = parsedKeywords !== null ? parsedKeywords : (f.filterKeywords || []);
      const customLoginUpdates = {};
      if ((f.platform || 'instagram') === 'custom' && usesLogin !== undefined) {
        customLoginUpdates.usesLogin = Boolean(usesLogin);
        if (!usesLogin) {
          customLoginUpdates.loggedIn = false;
          customLoginUpdates.loginError = false;
        }
      }
      f = { ...f, alias: aliasToUse, feedKey: newFeedKey, filterKeywords: activeKeywords, ...customLoginUpdates };
      targetFeed = f;
      return f;
    }
    return f;
  });
  store.set('feeds', feeds);

  // If target feed was updated, regenerate RSS/Atom feeds with updated alias and filterKeywords
  if (targetFeed) {
    try {
      const dataFile = path.join(feedDir, `${targetFeed.feedKey}.data.json`);
      let profileData = null;

      if (fs.existsSync(dataFile)) {
        try {
          profileData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        } catch (_) {}
      }

      // If data.json does not exist yet, fallback to extracting posts from existing RSS XML
      if (!profileData || !Array.isArray(profileData.posts) || profileData.posts.length === 0) {
        const rssFile = path.join(feedDir, `${targetFeed.feedKey}.rss.xml`);
        if (fs.existsSync(rssFile)) {
          const rawXml = fs.readFileSync(rssFile, 'utf8');
          const parsedPosts = [];
          const itemMatches = rawXml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
          for (const m of itemMatches) {
            const itemXml = m[1];
            const titleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
            const linkMatch = itemXml.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
            const descMatch = itemXml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
            const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
            const contentMatch = itemXml.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/i);
            parsedPosts.push({
              title: titleMatch ? titleMatch[1].trim() : '',
              permalink: linkMatch ? linkMatch[1].trim() : '',
              description: descMatch ? descMatch[1].trim() : '',
              caption: descMatch ? descMatch[1].trim() : '',
              timestamp: dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString(),
              content: contentMatch ? contentMatch[1].trim() : ''
            });
          }
          if (parsedPosts.length > 0) {
            profileData = {
              username: targetFeed.username,
              platform: targetFeed.platform || 'instagram',
              fullName: targetFeed.alias,
              biography: '',
              fullUrl: targetFeed.fullUrl || targetFeed.url,
              posts: parsedPosts
            };
          }
        }
      }

      if (profileData && Array.isArray(profileData.posts)) {
        profileData.feedKey = targetFeed.feedKey;
        profileData.alias = targetFeed.alias;
        profileData.fullUrl = targetFeed.fullUrl || targetFeed.url;
        profileData.directExternalLink = Boolean(targetFeed.directExternalLink);
        profileData.filterKeywords = targetFeed.filterKeywords || [];
        const result = await generateFeed(targetFeed.feedKey, profileData, store, targetFeed.platform || platform);

        if (result && typeof result.postCount === 'number') {
          const freshFeeds = store.get('feeds');
          const idx = freshFeeds.findIndex(f => f.username === username && (f.platform || 'instagram') === (platform || 'instagram'));
          if (idx !== -1) {
            freshFeeds[idx].postCount = result.postCount;
            store.set('feeds', freshFeeds);
          }
        }
      }
    } catch (err) {
      console.error('[rename-feed] Error regenerating feed with updated filters:', err);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }

  return await checkCustomFeedsLoginStatus();
}

ipcMain.handle('rename-feed', (_e, username, platform, newAlias, filterKeywords, usesLogin) => {
  return renameFeedCore(username, platform, newAlias, filterKeywords, usesLogin);
});

ipcMain.handle('remove-feed', (_e, username, platform) => {
  const feeds = store.get('feeds').filter((f) =>
    !(f.username === username && (f.platform || 'instagram') === (platform || 'instagram'))
  );
  store.set('feeds', feeds);
  return feeds;
});

async function refreshFeedCore(username, platform) {
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
    } else if (platform === 'txt') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'txt');
      profileData = await scrapeTxtFile(feedEntry?.fullUrl || feedEntry?.url);
    } else if (platform === 'reddit') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'reddit');
      profileData = await scrapeReddit(feedEntry?.fullUrl || feedEntry?.url);
    } else if (platform === 'telegram') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'telegram');
      profileData = await scrapeTelegramChannel(feedEntry || username, {
        telegramLoggedIn: Boolean(store.get('telegramLoggedIn')),
      });
    } else if (platform === 'calendar') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'calendar');
      profileData = await scrapeCalendar(feedEntry || username, { feedDir: getFeedDir() });
    } else if (platform === 'custom') {
      const feedEntry = store.get('feeds').find((f) => f.username === username && f.platform === 'custom');
      profileData = await scrapeCustomSiteHeadless(
        feedEntry?.fullUrl,
        feedEntry?.selector,
        feedEntry?.alias || username,
        feedEntry?.scrollSelector,
        feedEntry?.scrollCount,
        { usesLogin: Boolean(feedEntry?.usesLogin) }
      );
    } else {
      profileData = await scrapeInstagramProfile(username);
    }
  } catch (err) {
    if (platform === 'custom') {
      recordCustomFeedFailure(username, err);
    }
    addNotification('error', `Failed to refresh @${username}: ${err.message}`);
    throw err;
  }

  const storedFeed = store.get('feeds').find((f) => f.username === username && (f.platform || 'instagram') === platform);
  const feedKey = (storedFeed?.feedKey || username).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  profileData.feedKey = feedKey;
  profileData.alias = storedFeed?.alias;
  profileData.fullUrl = storedFeed?.fullUrl || storedFeed?.url;
  profileData.directExternalLink = Boolean(storedFeed?.directExternalLink);
  profileData.filterKeywords = storedFeed?.filterKeywords || [];
  const genResultRef = await generateFeed(feedKey, profileData, store, platform);

  // Re-focus main window after hidden scraper window was destroyed
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

  // Resolve any previous errors for this feed
  resolveNotificationsBySubstring(`@${username}`);
  removeStaleNotificationsForFeed(username);

  const realPostsRefresh = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
  const postsWithTsRefresh = realPostsRefresh.length > 0 ? realPostsRefresh : profileData.posts.filter(p => p.timestamp);
  const latestPostDate = postsWithTsRefresh.length > 0
    ? new Date(Math.max(...postsWithTsRefresh.map(p => new Date(p.timestamp).getTime()))).toISOString()
    : null;

  const feeds = store.get('feeds').map((f) => {
    if (f.username === username && (f.platform || 'instagram') === platform) {
      return {
        ...f,
        lastChecked: new Date().toISOString(),
        postCount: genResultRef?.postCount ?? profileData.posts.length,
        latestPostDate: latestPostDate || f.latestPostDate || null,
        ...(platform === 'custom'
          ? {
              loginError: false,
              lastError: null,
              loginPaused: false,
              loginPausedAt: null,
              loginLockedOut: false,
              loggedIn: f.usesLogin
                ? (profileData?.loginState === 'logged-in' ? true : (profileData?.loginState === 'logged-out' ? false : f.loggedIn))
                : false,
            }
          : {}),
      };
    }
    return f;
  });
  store.set('feeds', feeds);

  if (platform === 'custom') {
    recordCustomFeedSuccess(username, profileData.loginState);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }

  return feeds.find((f) => f.username === username && (f.platform || 'instagram') === platform);
}

ipcMain.handle('refresh-feed', async (_e, username, platform) => {
  return await refreshFeedCore(username, platform);
});

async function refreshAllCore() {
  const feedsSnapshot = store.get('feeds');
  const results = [];

  for (const feed of feedsSnapshot) {
    if (isCustomFeedPaused(feed)) {
      console.log(`[Refresh-all] Skipping @${feed.username} (custom feed login paused)`);
      results.push({ username: feed.username, platform: feed.platform, success: false, error: 'Login paused' });
      continue;
    }
    try {
      const platform = feed.platform || 'instagram';
      let profileData;
      if (platform === 'twitter') {
        profileData = await scrapeTwitterProfile(feed.username);
      } else if (platform === 'facebook') {
        profileData = await scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
      } else if (platform === 'linkedin') {
        profileData = await scrapeLinkedInProfile(feed.username);
      } else if (platform === 'txt') {
        profileData = await scrapeTxtFile(feed.fullUrl || feed.url);
      } else if (platform === 'reddit') {
        profileData = await scrapeReddit(feed.fullUrl || feed.url);
      } else if (platform === 'telegram') {
        profileData = await scrapeTelegramChannel(feed, {
          telegramLoggedIn: Boolean(store.get('telegramLoggedIn')),
        });
      } else if (platform === 'calendar') {
        profileData = await scrapeCalendar(feed, { feedDir: getFeedDir() });
      } else if (platform === 'custom') {
        profileData = await scrapeCustomSiteHeadless(
          feed.fullUrl,
          feed.selector,
          feed.alias || feed.username,
          feed.scrollSelector,
          feed.scrollCount,
          { usesLogin: Boolean(feed.usesLogin) }
        );
      } else {
        profileData = await scrapeInstagramProfile(feed.username);
      }
      const feedKey = (feed.feedKey || feed.username).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      profileData.feedKey = feedKey;
      profileData.alias = feed.alias;
      profileData.fullUrl = feed.fullUrl || feed.url;
      profileData.directExternalLink = Boolean(feed.directExternalLink);
      profileData.filterKeywords = feed.filterKeywords || [];
      const genResultAll = await generateFeed(feedKey, profileData, store, platform);

      // Re-read store and update only this entry to avoid overwriting concurrent additions
      const currentFeeds = store.get('feeds');
      const idx = currentFeeds.findIndex(f => f.username === feed.username && (f.platform || 'instagram') === platform);
      if (idx !== -1) {
        currentFeeds[idx].lastChecked = new Date().toISOString();
        currentFeeds[idx].postCount = genResultAll?.postCount ?? profileData.posts.length;
        if (platform === 'custom') {
          currentFeeds[idx].loginError = false;
          currentFeeds[idx].lastError = null;
          currentFeeds[idx].loginPaused = false;
          currentFeeds[idx].loginPausedAt = null;
          currentFeeds[idx].loginLockedOut = false;
          if (currentFeeds[idx].usesLogin) {
            currentFeeds[idx].loggedIn = (profileData?.loginState === 'logged-in' ? true : (profileData?.loginState === 'logged-out' ? false : currentFeeds[idx].loggedIn));
          }
        }
        const realPostsRA = profileData.posts.filter(p => !p.timestampEstimated && p.timestamp);
        const postsWithTsRA = realPostsRA.length > 0 ? realPostsRA : profileData.posts.filter(p => p.timestamp);
        currentFeeds[idx].latestPostDate = postsWithTsRA.length > 0
          ? new Date(Math.max(...postsWithTsRA.map(p => new Date(p.timestamp).getTime()))).toISOString()
          : currentFeeds[idx].latestPostDate || null;
        store.set('feeds', currentFeeds);
      }
      if (platform === 'custom') {
        recordCustomFeedSuccess(feed.username, profileData.loginState);
      }
      resolveNotificationsBySubstring(`@${feed.username}`);
      removeStaleNotificationsForFeed(feed.username);
      results.push({ username: feed.username, success: true });
    } catch (err) {
      if ((feed.platform || 'instagram') === 'custom') {
        recordCustomFeedFailure(feed.username, err);
      }
      results.push({ username: feed.username, success: false, error: err.message });
      addNotification('error', `Refresh failed @${feed.username}: ${err.message}`);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }

  return results;
}

ipcMain.handle('refresh-all', async () => {
  return await refreshAllCore();
});

ipcMain.handle('toggle-reddit-direct-link', async (_e, username, platform = 'reddit') => {
  const feeds = store.get('feeds');
  const feed = feeds.find((f) => f.username === username && (f.platform || 'instagram') === platform);
  if (!feed) throw new Error('Feed not found');
  feed.directExternalLink = !feed.directExternalLink;
  store.set('feeds', feeds);

  try {
    const profileData = await scrapeReddit(feed.fullUrl || feed.url);
    const feedKey = (feed.feedKey || feed.username).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    profileData.feedKey = feedKey;
    profileData.alias = feed.alias;
    profileData.fullUrl = feed.fullUrl || feed.url;
    profileData.directExternalLink = Boolean(feed.directExternalLink);
    profileData.filterKeywords = feed.filterKeywords || [];
    const genResultToggle = await generateFeed(feedKey, profileData, store, platform);
    if (genResultToggle && typeof genResultToggle.postCount === 'number') {
      feed.postCount = genResultToggle.postCount;
      store.set('feeds', feeds);
    }
  } catch (err) {
    console.error('Failed to regenerate feed on toggle direct link:', err);
  }

  return feed;
});

ipcMain.handle('get-server-port', () => {
  return store.get('serverPort');
});

ipcMain.handle('open-external', (_e, url) => {
  shell.openExternal(url);
});

ipcMain.handle('open-custom-login', (_e, url, username) => {
  return new Promise((resolve) => {
    isCustomLoginWindowOpen = true;

    const feeds = store.get('feeds');
    const targetFeed = username
      ? feeds.find(f => f.username === username && (f.platform || 'instagram') === 'custom')
      : feeds.find(f => (f.platform || 'instagram') === 'custom' && (f.fullUrl === url || f.url === url));
    const targetUrl = url || targetFeed?.fullUrl || targetFeed?.url;
    const siteLabel = targetFeed?.alias || targetFeed?.username || targetUrl || 'Custom Website';
    const domainParts = getDomainPartsFromUrl(targetUrl);
    const targetDomain = domainParts.baseDomain;

    // Open base domain homepage so user can log in naturally without broken /login URLs
    let baseWebsiteUrl = targetUrl;
    try {
      const u = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
      baseWebsiteUrl = u.origin;
    } catch (_) {
      baseWebsiteUrl = domainParts.origin || targetUrl;
    }
    const initialUrl = baseWebsiteUrl || targetUrl;

    let loginWin = new BrowserWindow({
      width: 1100,
      height: 820,
      parent: mainWindow || undefined,
      modal: false,
      title: `Login — ${siteLabel}`,
      webPreferences: {
        preload: path.join(__dirname, 'preload-custom.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    loginWin.setMenuBarVisibility(false);
    const realisticUA = getRealisticUserAgent();
    loginWin.webContents.session.setUserAgent(realisticUA);
    loginWin.webContents.setUserAgent(realisticUA);

    // Allow OAuth/SSO popup windows (Google, Apple, GitHub, etc.)
    loginWin.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 600,
        height: 720,
        parent: loginWin,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    }));

    let cfPollTimer = null;
    const cleanupCfPollTimer = () => {
      if (cfPollTimer) {
        clearInterval(cfPollTimer);
        cfPollTimer = null;
      }
    };

    const injectLoginHelperBar = async () => {
      if (!loginWin || loginWin.isDestroyed()) {
        cleanupCfPollTimer();
        return;
      }

      // Check if current page is Cloudflare challenge (Turnstile / managed challenge)
      const isCf = await isCloudflareChallenge(loginWin.webContents);
      if (isCf) {
        console.log('[Custom Login] Cloudflare challenge active — withholding toolbar injection to prevent challenge loop.');
        try {
          await loginWin.webContents.executeJavaScript(`(function() {
            var existing = document.getElementById('__unsocial_relogin_bar');
            if (existing) existing.remove();
            if (document.body && document.body.style && document.body.style.marginTop === '44px') {
              document.body.style.removeProperty('margin-top');
            }
          })()`).catch(() => {});
        } catch (_) {}
        try {
          loginWin.setTitle(`Cloudflare Verification — ${siteLabel} (Complete check to continue)`);
        } catch (_) {}

        // Poll periodically while on challenge page so that as soon as the user completes Turnstile
        // and Cloudflare redirects to the forum, the toolbar appears automatically.
        if (!cfPollTimer) {
          cfPollTimer = setInterval(async () => {
            if (!loginWin || loginWin.isDestroyed()) {
              cleanupCfPollTimer();
              return;
            }
            const stillCf = await isCloudflareChallenge(loginWin.webContents);
            if (!stillCf) {
              cleanupCfPollTimer();
              console.log('[Custom Login] Cloudflare challenge cleared! Injecting login helper bar.');
              injectLoginHelperBar();
            }
          }, 1500);
        }
        return;
      }

      cleanupCfPollTimer();
      try {
        loginWin.setTitle(`Login — ${siteLabel}`);
      } catch (_) {}

      const currentUrl = loginWin.webContents.getURL() || targetUrl;
      const cookies = await getSiteCookies(currentUrl);
      const loginInfo = await detectLoginState(loginWin.webContents);

      const isActuallyLoggedIn = loginInfo.state === 'logged-in' || cookies.isPhpBBLoggedIn;
      const isLockedOut = Boolean(loginInfo.lockedOut);
      const isGuest = cookies.isGuest || loginInfo.state === 'logged-out';

      let statusHtml = '';
      if (isActuallyLoggedIn) {
        statusHtml = '<span id="__unsocial_relogin_status" style="background:rgba(52,211,153,0.18);color:#34d399;border:1px solid rgba(52,211,153,0.45);padding:3px 9px;border-radius:5px;font-weight:700;font-size:11px;white-space:nowrap;flex-shrink:0;">✅ LOGGED IN</span>';
      } else if (isLockedOut) {
        statusHtml = '<span id="__unsocial_relogin_status" style="background:rgba(239,68,68,0.22);color:#fca5a5;border:1px solid rgba(239,68,68,0.55);padding:3px 9px;border-radius:5px;font-weight:700;font-size:11px;white-space:nowrap;flex-shrink:0;" title="Website reports too many login attempts. Enter username, password AND solve the CAPTCHA image below to unlock.">⚠️ LOCKED OUT — SOLVE CAPTCHA</span>';
      } else if (isGuest) {
        statusHtml = '<span id="__unsocial_relogin_status" style="background:rgba(251,191,36,0.18);color:#fbbf24;border:1px solid rgba(251,191,36,0.45);padding:3px 9px;border-radius:5px;font-weight:600;font-size:11px;white-space:nowrap;flex-shrink:0;">🔓 NOT LOGGED IN</span>';
      } else {
        statusHtml = `<span id="__unsocial_relogin_status" style="background:rgba(148,163,184,0.15);color:#cbd5e1;border:1px solid rgba(148,163,184,0.3);padding:3px 9px;border-radius:5px;font-size:11px;white-space:nowrap;flex-shrink:0;">🍪 ${cookies.nonNoise.length} cookie${cookies.nonNoise.length === 1 ? '' : 's'}</span>`;
      }

      const js = `(function() {
        var existing = document.getElementById('__unsocial_relogin_bar');
        if (existing) existing.remove();
        var bar = document.createElement('div');
        bar.id = '__unsocial_relogin_bar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#e8e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;padding:7px 12px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(0,0,0,0.5);border-bottom:2px solid #7c5cfc;user-select:none;';
        bar.innerHTML = \`
          <span style="background:#7c5cfc;color:#fff;font-weight:700;font-size:11px;padding:3px 7px;border-radius:5px;letter-spacing:0.3px;flex-shrink:0;">CUSTOM LOGIN</span>
          <button id="__unsocial_relogin_back" title="Back" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;">←</button>
          <button id="__unsocial_relogin_reload" title="Reload" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;">↻</button>
          <button id="__unsocial_relogin_goto_base" title="Navigate to website base domain homepage" style="background:rgba(99,102,241,0.2);color:#a5b4fc;border:1px solid rgba(99,102,241,0.45);padding:4px 9px;border-radius:5px;cursor:pointer;font-weight:600;font-size:11px;white-space:nowrap;flex-shrink:0;">🏠 Base Site</button>
          \${${JSON.stringify(Boolean(targetUrl && targetUrl !== baseWebsiteUrl))} ? \`<button id="__unsocial_relogin_goto_feed" title="Navigate to feed content page" style="background:rgba(255,255,255,0.08);color:#e2e8f0;border:1px solid rgba(255,255,255,0.18);padding:4px 9px;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap;flex-shrink:0;">📄 Feed Page</button>\` : ''}
          <input id="__unsocial_relogin_url" type="text" value="\${location.href.replace(/"/g, '&quot;')}" style="flex:1;min-width:120px;background:rgba(0,0,0,0.35);color:#e8e8f0;border:1px solid rgba(255,255,255,0.16);border-radius:5px;padding:4px 8px;font-size:11px;outline:none;" />
          ${statusHtml}
          <button id="__unsocial_relogin_clear" title="Clear website session cookies (preserves Cloudflare) and reload base site" style="background:rgba(248,113,113,0.15);color:#fca5a5;border:1px solid rgba(248,113,113,0.35);padding:5px 9px;border-radius:5px;font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;">🧹 Clear Cookies</button>
          <button id="__unsocial_relogin_confirm" style="background:#10b981;color:#fff;border:none;padding:5px 12px;border-radius:5px;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;" title="Click once you have logged in to save cookies, mark feed as logged in, and refresh">✓ Confirm Logged In & Refresh</button>
          <button id="__unsocial_relogin_close" style="background:rgba(255,255,255,0.08);color:#bbb;border:1px solid rgba(255,255,255,0.18);padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;" title="Close window without changing login status">✕ Close</button>
        \`;
        document.documentElement.appendChild(bar);
        document.body.style.setProperty('margin-top', '44px', 'important');

        document.getElementById('__unsocial_relogin_back').addEventListener('click', () => history.back());
        document.getElementById('__unsocial_relogin_reload').addEventListener('click', () => location.reload());
        document.getElementById('__unsocial_relogin_goto_base').addEventListener('click', () => { location.href = ${JSON.stringify(baseWebsiteUrl || '')}; });
        var btnFeed = document.getElementById('__unsocial_relogin_goto_feed');
        if (btnFeed) btnFeed.addEventListener('click', () => { location.href = ${JSON.stringify(targetUrl || '')}; });
        var urlInput = document.getElementById('__unsocial_relogin_url');
        urlInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && urlInput.value.trim()) {
            var v = urlInput.value.trim();
            if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
            location.href = v;
          }
        });
        document.getElementById('__unsocial_relogin_clear').addEventListener('click', () => {
          var btn = document.getElementById('__unsocial_relogin_clear');
          btn.textContent = 'Clearing...';
          btn.disabled = true;
          window.unsocial.send('custom-relogin-clear');
        });
        document.getElementById('__unsocial_relogin_confirm').addEventListener('click', () => {
          var btn = document.getElementById('__unsocial_relogin_confirm');
          btn.textContent = 'Saving…';
          btn.disabled = true;
          window.unsocial.send('custom-relogin-confirm');
        });
        document.getElementById('__unsocial_relogin_close').addEventListener('click', () => {
          window.unsocial.send('custom-relogin-close');
        });
      })();`;

      loginWin.webContents.executeJavaScript(js).catch(() => {});
    };

    loginWin.webContents.on('did-finish-load', injectLoginHelperBar);
    loginWin.webContents.on('did-navigate', injectLoginHelperBar);
    loginWin.webContents.on('did-navigate-in-page', injectLoginHelperBar);
    loginWin.webContents.on('page-title-updated', (_event, title) => {
      const t = (title || '').toLowerCase();
      if (!t.includes('just a moment') && !t.includes('attention required! | cloudflare')) {
        injectLoginHelperBar();
      }
    });

    let finalized = false;
    const finalizeLogin = async (isLoggedIn, shouldRefresh = true) => {
      if (finalized) return;
      finalized = true;
      cleanupCfPollTimer();
      isCustomLoginWindowOpen = false;
      ipcMain.removeListener('custom-wizard-msg', onReloginMsg);

      try {
        await session.defaultSession.cookies.flushStore();
      } catch (_) {}

      const { nonNoise, authLike } = await getSiteCookies(targetUrl);
      const authCookieNames = (authLike.length > 0 ? authLike : nonNoise).map((c) => c.name);

      if (isLoggedIn) {
        markCustomDomainLoggedIn(targetDomain, targetFeed?.username, authCookieNames);
      } else if (targetFeed?.username) {
        recordCustomFeedFailure(targetFeed.username, new Error('Login not completed — session remains logged out.'));
      }

      let refreshed = false;
      let refreshError = null;
      if (shouldRefresh && isLoggedIn && targetFeed?.username) {
        try {
          await refreshFeedCore(targetFeed.username, 'custom');
          refreshed = true;
        } catch (err) {
          refreshError = err.message;
        }
      }

      resolve({
        success: true,
        usesLogin: true,
        loggedIn: isLoggedIn && !refreshError,
        refreshed,
        refreshError,
        cookieCount: nonNoise.length,
      });
    };

    const onReloginMsg = async (_event, channel) => {
      if (!loginWin || loginWin.isDestroyed()) return;
      if (channel === 'custom-relogin-clear') {
        const currentUrl = loginWin.webContents.getURL() || targetUrl;
        await clearSiteCookiesAndStorage(currentUrl, true);
        if (targetUrl && targetUrl !== currentUrl) {
          await clearSiteCookiesAndStorage(targetUrl, true);
        }
        loginWin.loadURL(baseWebsiteUrl || initialUrl);
      } else if (channel === 'custom-relogin-confirm') {
        const winToClose = loginWin;
        loginWin = null;
        if (winToClose && !winToClose.isDestroyed()) {
          winToClose.close();
        }
        await finalizeLogin(true, true);
      } else if (channel === 'custom-relogin-close') {
        const winToClose = loginWin;
        loginWin = null;
        if (winToClose && !winToClose.isDestroyed()) {
          winToClose.close();
        }
        const cookies = await getSiteCookies(targetUrl);
        const isLogged = (cookies.authLike.length > 0 && !cookies.isGuest) || Boolean(targetFeed?.loggedIn);
        await finalizeLogin(isLogged, isLogged);
      }
    };

    ipcMain.on('custom-wizard-msg', onReloginMsg);

    loginWin.loadURL(initialUrl).catch((err) => {
      console.error('[Custom Login] Failed to load URL:', err.message);
    });

    loginWin.on('closed', async () => {
      cleanupCfPollTimer();
      loginWin = null;
      isCustomLoginWindowOpen = false;
      if (finalized) return;
      const cookies = await getSiteCookies(targetUrl);
      const isPhpBB = isPhpBBSite(cookies.all, targetDomain);
      const isLogged = isPhpBB
        ? Boolean(cookies.isPhpBBLoggedIn)
        : ((cookies.authLike.length > 0 || (cookies.nonNoise.length > 0 && targetFeed?.loggedIn)) && !cookies.isGuest);
      finalizeLogin(isLogged, isLogged);
    });
  });
});

async function confirmCustomLoginCore(username) {
  const feeds = store.get('feeds');
  const targetFeed = feeds.find(f => f.username === username && (f.platform || 'instagram') === 'custom');
  if (!targetFeed) throw new Error('Custom feed not found');

  const targetUrl = targetFeed.fullUrl || targetFeed.url;
  const targetDomain = getFeedBaseDomain(targetFeed);
  const { nonNoise, authLike } = await getSiteCookies(targetUrl);
  const authCookieNames = (authLike.length > 0 ? authLike : nonNoise).map(c => c.name);

  markCustomDomainLoggedIn(targetDomain, username, authCookieNames);

  let refreshed = false;
  let refreshError = null;
  try {
    await refreshFeedCore(username, 'custom');
    refreshed = true;
  } catch (err) {
    refreshError = err.message;
  }

  return {
    success: true,
    usesLogin: true,
    loggedIn: true,
    refreshed,
    refreshError,
    cookieCount: nonNoise.length,
  };
}

ipcMain.handle('confirm-custom-login', async (_e, username) => {
  return confirmCustomLoginCore(username);
});

ipcMain.handle('toggle-custom-login', async (_e, username, usesLogin) => {
  const feeds = store.get('feeds');
  const idx = feeds.findIndex(f => f.username === username && (f.platform || 'instagram') === 'custom');
  if (idx === -1) throw new Error('Custom feed not found');

  const nextUsesLogin = usesLogin !== undefined ? Boolean(usesLogin) : !feeds[idx].usesLogin;
  feeds[idx].usesLogin = nextUsesLogin;

  if (nextUsesLogin) {
    const { nonNoise, authLike } = await getSiteCookies(feeds[idx].fullUrl || feeds[idx].url);
    feeds[idx].loggedIn = (nonNoise.length > 0 || authLike.length > 0) && !feeds[idx].loginError;
    if (authLike.length > 0 || nonNoise.length > 0) {
      feeds[idx].authCookieNames = (authLike.length > 0 ? authLike : nonNoise).map(c => c.name);
    }
  } else {
    feeds[idx].loggedIn = false;
    feeds[idx].loginError = false;
    resolveNotificationsBySubstring(`(@${username})`);
  }

  store.set('feeds', feeds);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }
  return feeds[idx];
});

ipcMain.handle('logout-custom-feed', async (_e, username) => {
  const feeds = store.get('feeds');
  const idx = feeds.findIndex(f => f.username === username && (f.platform || 'instagram') === 'custom');
  if (idx === -1) throw new Error('Custom feed not found');

  const targetUrl = feeds[idx].fullUrl || feeds[idx].url;
  const targetDomain = getDomainPartsFromUrl(targetUrl)?.baseDomain;
  await clearSiteCookiesAndStorage(targetUrl);

  for (let i = 0; i < feeds.length; i++) {
    if ((feeds[i].platform || 'instagram') !== 'custom') continue;
    const fDomain = getDomainPartsFromUrl(feeds[i].fullUrl || feeds[i].url)?.baseDomain;
    if (feeds[i].username === username || (targetDomain && fDomain === targetDomain)) {
      feeds[i].loggedIn = false;
      feeds[i].authCookieNames = [];
    }
  }

  store.set('feeds', feeds);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feeds-updated');
  }
  return feeds[idx];
});

ipcMain.handle('export-opml', (_e, groups, tunnelDomain) => {
  try {
    // Determine export directory: beside the exe for portable, or Downloads folder
    let exportDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (!exportDir) {
      try {
        exportDir = app.getPath('downloads');
      } catch (_) {
        try {
          exportDir = app.getPath('documents');
        } catch (_) {
          exportDir = app.getPath('home');
        }
      }
    }

    const feedTokenExport = store.get('feedToken');
    const tokenSuffix = feedTokenExport ? `?token=${feedTokenExport}` : '';
    let fileCount = 0;

    for (const [category, feeds] of Object.entries(groups)) {
      const platformMap = { 'Instagram': 'instagram', 'Twitter': 'twitter', 'Facebook': 'facebook', 'LinkedIn': 'linkedin', 'Telegram': 'telegram', 'Reddit': 'reddit', 'Calendar': 'calendar', 'Text': 'txt', 'Custom': 'custom' };
      const platformUrlBase = {
        'Instagram': 'https://www.instagram.com/',
        'Twitter': 'https://x.com/',
        'Facebook': 'https://www.facebook.com/',
        'LinkedIn': 'https://www.linkedin.com/in/',
        'Telegram': 'https://t.me/',
        'Reddit': 'https://www.reddit.com/',
        'Calendar': '',
        'Text': '',
        'Custom': '',
      };

      let outlines = '';
      for (const feed of feeds) {
        const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
        const xmlUrl = `https://${tunnelDomain}/feed/${feedKey}${tokenSuffix}`;
        const isOrg = feed.username.startsWith('company/') || feed.username.startsWith('showcase/') || feed.username.startsWith('school/');
        const htmlUrl = (feed.platform === 'txt' || feed.platform === 'custom' || feed.platform === 'reddit' || feed.platform === 'telegram' || feed.platform === 'calendar')
          ? (feed.siteUrl || feed.fullUrl || feed.url || `${platformUrlBase[category] || ''}${feed.username}`)
          : feed.platform === 'linkedin'
            ? (isOrg ? `https://www.linkedin.com/${feed.username}/` : `https://www.linkedin.com/in/${feed.username}/`)
            : `${platformUrlBase[category] || ''}${feed.username}/`;
        const title = escapeXml(feed.alias || feed.username);
        outlines += `      <outline text="${title}" title="${title}" type="rss" xmlUrl="${escapeXml(xmlUrl)}" htmlUrl="${escapeXml(htmlUrl)}"/>\n`;
      }

      const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head>\n    <title>${category} feeds from UnSocial</title>\n  </head>\n  <body>\n    <outline text="${category}" title="${category}">\n${outlines}    </outline>\n  </body>\n</opml>\n`;

      const filePath = path.join(exportDir, `${category}.xml`);
      fs.writeFileSync(filePath, opml, 'utf-8');
      fileCount++;
    }

    if (exportDir) {
      shell.openPath(exportDir).catch((err) => {
        console.error('[Export OPML] Failed to open folder:', err.message);
      });
    }

    return { success: true, fileCount, exportDir };
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
  return tunnel.checkInstalled(store);
});

ipcMain.handle('tunnel-check-authenticated', async () => {
  return { authenticated: await tunnel.checkAuthenticated(store) };
});

ipcMain.handle('tunnel-check-setup', async () => {
  return tunnel.checkSetup(store);
});

ipcMain.handle('tunnel-run-setup', async (_e, step) => {
  return tunnel.runWizardStep(store, step);
});

ipcMain.handle('tunnel-start', async () => {
  return tunnel.startTunnel(store);
});

ipcMain.handle('tunnel-stop', async () => {
  await tunnel.stopTunnel(store);
  return { status: 'stopped' };
});

ipcMain.handle('tunnel-state', async () => {
  return tunnel.getTunnelState(store);
});

ipcMain.handle('tunnel-get-settings', () => {
  return {
    provider: tunnel.getProviderId(store),
    availableProviders: tunnel.getAvailableProviders(),
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

ipcMain.handle('tunnel-get-provider', () => {
  return {
    provider: tunnel.getProviderId(store),
    available: tunnel.getAvailableProviders(),
  };
});

ipcMain.handle('tunnel-set-provider', async (_e, providerId) => {
  const result = await tunnel.setProvider(store, providerId);
  // Notify the renderer so it can re-read state for the new provider.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tunnel-status', {
      status: 'stopped',
      provider: result.provider,
    });
  }
  return result;
});

// ── Feed Token IPC Handlers ───────────────────────────────────────────

ipcMain.handle('get-feed-token', () => {
  return store.get('feedToken') || '';
});

ipcMain.handle('set-feed-token', (_e, token) => {
  store.set('feedToken', token || '');
  return store.get('feedToken');
});

ipcMain.handle('generate-feed-token', () => {
  const token = crypto.randomBytes(32).toString('hex');
  store.set('feedToken', token);
  return token;
});

ipcMain.handle('get-feed-public-base-url', () => {
  return store.get('feedPublicBaseUrl') || '';
});

ipcMain.handle('set-feed-public-base-url', (_e, raw) => {
  const normalized = normalizeFeedPublicBaseUrlInput(raw);
  store.set('feedPublicBaseUrl', normalized);
  return normalized;
});

ipcMain.handle('get-resolved-feed-base-url', () => {
  return resolveFeedBaseUrl(store);
});

// ── Remote Web Access IPC Handlers ─────────────────────────────────────────

ipcMain.handle('get-remote-auth-settings', async () => {
  const username = store.get('remoteUsername') || 'admin';
  const password = store.get('remotePassword') || '';
  const customWebUrl = store.get('remoteWebUrl') || '';
  const port = store.get('serverPort') || 3845;
  const feedPublicBase = store.get('feedPublicBaseUrl') || '';

  let tunnelUrl = '';
  try {
    tunnelUrl = await tunnel.getPublicUrl(store);
  } catch (_) {}

  let defaultUrl = '';
  if (tunnelUrl) {
    defaultUrl = `${tunnelUrl.replace(/\/+$/, '')}/remote`;
  } else if (feedPublicBase) {
    defaultUrl = `${feedPublicBase.replace(/\/+$/, '')}/remote`;
  } else {
    defaultUrl = `http://localhost:${port}/remote`;
  }

  const bestUrl = customWebUrl || defaultUrl;

  return {
    username,
    password,
    webUrl: bestUrl,
    customWebUrl,
    defaultWebUrl: defaultUrl,
    tunnelProvider: tunnel.getProviderId(store),
  };
});

ipcMain.handle('set-remote-auth-settings', (_e, settings) => {
  if (settings && typeof settings === 'object') {
    if (settings.username && typeof settings.username === 'string') {
      store.set('remoteUsername', settings.username.trim());
    }
    if (settings.password && typeof settings.password === 'string') {
      store.set('remotePassword', settings.password.trim());
    }
    if (typeof settings.webUrl === 'string') {
      store.set('remoteWebUrl', settings.webUrl.trim());
    }
  }
  return {
    username: store.get('remoteUsername') || 'admin',
    password: store.get('remotePassword') || '',
    webUrl: store.get('remoteWebUrl') || '',
  };
});

ipcMain.handle('generate-remote-password', () => {
  const newPass = crypto.randomBytes(6).toString('hex');
  store.set('remotePassword', newPass);
  return newPass;
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

  // LinkedIn company/showcase/school URL: https://www.linkedin.com/company/companyname/ or showcase/school
  const liOrgMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/((?:company|showcase|school)\/[a-zA-Z0-9._-]+)/
  );
  if (liOrgMatch) return { username: liOrgMatch[1], platform: 'linkedin' };

  // Instagram URL: https://www.instagram.com/username/
  const igMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/
  );
  if (igMatch) return { username: igMatch[1], platform: 'instagram' };

  // .txt URL — any http(s) URL ending in .txt
  const txtMatch = input.match(/^(https?:\/\/.+\.txt)$/i);
  if (txtMatch) {
    const fullUrl = txtMatch[1];
    // Derive a short name from the URL path (e.g. "changelog" from changelog.txt)
    let fileName;
    try {
      const u = new URL(fullUrl);
      const pathParts = u.pathname.split('/').filter(Boolean);
      fileName = (pathParts.pop() || 'feed').replace(/\.txt$/i, '');
      // Prefix with hostname for uniqueness
      const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
      fileName = `${host}-${fileName}`;
    } catch (_) {
      fileName = 'txt-feed';
    }
    return { username: fileName, platform: 'txt', fullUrl };
  }

  // Telegram channel URL or shorthand (public t.me/..., private t.me/c/..., invite t.me/+..., web.telegram.org)
  const telegramParsed = parseTelegramInput(input);
  if (telegramParsed) return telegramParsed;

  // Reddit URL or shorthand
  const redditParsed = parseRedditInput(input);
  if (redditParsed) return redditParsed;

  // Calendar URL (.ics, webcal://, Google Calendar public/embed/share URL, Outlook Live/365 published calendar, or local .ics file)
  const calendarParsed = parseCalendarInput(input);
  if (calendarParsed) return calendarParsed;

  // Bare @username or username — default to Instagram
  const bare = input.replace(/^@/, '');
  if (/^[a-zA-Z0-9._]{1,30}$/.test(bare)) return { username: bare, platform: 'instagram' };

  // Any other URL — treat as custom website (catch-all)
  // Also match URLs without protocol (e.g. "example.com/page")
  const anyUrlMatch = input.match(/^(https?:\/\/.+)/i) || input.match(/^([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}\/.+)/i);
  if (anyUrlMatch) {
    const fullUrl = anyUrlMatch[1].startsWith('http') ? anyUrlMatch[1] : 'https://' + anyUrlMatch[1];
    let siteName;
    try {
      const u = new URL(fullUrl);
      const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
      const pathSlug = u.pathname.replace(/^\/|\/$|\.[^.]+$/g, '').replace(/\//g, '-') || '';
      siteName = pathSlug ? `${host}-${pathSlug}` : host;
    } catch (_) {
      siteName = 'custom-feed';
    }
    return { username: siteName, platform: 'custom', fullUrl };
  }

  return null;
}

function parseRedditInput(input) {
  if (typeof input !== 'string') return null;
  input = input.trim();

  // Strip .rss extension if present (e.g. .rss, top.rss, search.rss)
  let clean = input.replace(/\.rss(?=[?#]|$)/i, '');
  clean = clean.replace(/\/\.rss(?=[?#]|$)/i, '/');

  // Match reddit URLs or shorthand r/ or u/
  const isRedditDomain = /(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?reddit\.com/i.test(clean);
  const isRedditShorthand = /^\/??(?:r|u|user)\/[a-zA-Z0-9_+]+/i.test(clean);

  if (!isRedditDomain && !isRedditShorthand) return null;

  let fullUrl = clean;
  if (!fullUrl.startsWith('http')) {
    fullUrl = 'https://www.reddit.com/' + fullUrl.replace(/^\/+/, '');
  }

  let u;
  try {
    u = new URL(fullUrl);
  } catch (_) {
    return null;
  }

  // 1. Search in subreddit or global search: /r/subname/search or /search
  const searchMatch = u.pathname.match(/(?:\/r\/([a-zA-Z0-9_+]+))?\/search\/?/i);
  if (searchMatch) {
    const subName = searchMatch[1] || 'all';
    const q = u.searchParams.get('q') || '';
    const sort = u.searchParams.get('sort') || 'new';
    const t = u.searchParams.get('t') || '';

    const alias = subName && subName !== 'all' ? `r/${subName}` : 'Reddit';
    const qSlug = q.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 35);
    const username = `r-${subName}-search-${qSlug || 'query'}-${sort}${t ? '-' + t : ''}`;

    return {
      platform: 'reddit',
      redditType: 'search',
      subName,
      query: q,
      sort,
      timeframe: t,
      username,
      alias,
      fullUrl: u.toString(),
    };
  }

  // 2. Subreddit posts: /r/subname/(top|new|hot|rising|controversial)?
  const subMatch = u.pathname.match(/\/r\/([a-zA-Z0-9_+]+)(?:\/(top|new|hot|rising|controversial))?/i);
  if (subMatch) {
    const subName = subMatch[1];
    const sort = subMatch[2] ? subMatch[2].toLowerCase() : (u.pathname.includes('/top') ? 'top' : 'hot');
    const t = u.searchParams.get('t') || '';

    const alias = `r/${subName}`;
    let username = `r-${subName}`;
    if (sort !== 'hot' || t) {
      username += `-${sort}${t ? '-' + t : ''}`;
    }

    return {
      platform: 'reddit',
      redditType: 'subreddit',
      subName,
      sort,
      timeframe: t,
      username,
      alias,
      fullUrl: u.toString(),
    };
  }

  // 3. User posts: /(?:user|u)/username(/submitted)?
  const userMatch = u.pathname.match(/\/(?:user|u)\/([a-zA-Z0-9_-]+)/i);
  if (userMatch) {
    const userName = userMatch[1];
    return {
      platform: 'reddit',
      redditType: 'user',
      subName: `u/${userName}`,
      username: `u-${userName}-submitted`,
      alias: `u/${userName}`,
      fullUrl: u.toString(),
    };
  }

  return null;
}
