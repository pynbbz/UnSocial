/**
 * Headless entry point for Docker / server deployments.
 *
 * Runs the Electron app without any GUI — no main window, no tray, no login
 * popups.  Provides a REST management API on the same port as the RSS feed
 * server so feeds can be added, removed, refreshed and configured remotely.
 *
 * Usage:
 *   UNSOCIAL_DATA=/data electron --no-sandbox src/headless.js
 *
 * Environment variables:
 *   UNSOCIAL_DATA      – Path to persistent data directory (default: /data)
 *   UNSOCIAL_API_TOKEN  – Optional token to protect the /api/* management routes
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');

// ── Configure data path before any module reads it ─────────────────────────

const DATA_DIR = process.env.UNSOCIAL_DATA || '/data';
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
app.setPath('userData', DATA_DIR);

// ── Electron headless flags ────────────────────────────────────────────────

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');

// ── Imports (after userData is configured) ─────────────────────────────────

const Store = require('electron-store');
const { startFeedServer, stopFeedServer } = require('./feed-server');
const { scrapeInstagramProfile } = require('./scraper');
const { scrapeTwitterProfile } = require('./scraper-twitter');
const { scrapeFacebookProfile } = require('./scraper-facebook');
const { scrapeLinkedInProfile } = require('./scraper-linkedin');
const { scrapeTxtFile } = require('./scraper-txt');
const { scrapeCustomSiteHeadless } = require('./scraper-custom');
const { generateFeed, getFeedDir } = require('./rss-generator');
const { parseProfileInput } = require('./parse-input');
const crypto = require('crypto');

const store = new Store({
  defaults: {
    feeds: [],
    serverPort: 3845,
    checkIntervalMinutes: 30,
    tunnelDomain: '',
    tunnelName: 'unsocial-tunnel',
    tunnelAutoStart: false,
    feedToken: '',
  },
});

// ── Scrape dispatcher ──────────────────────────────────────────────────────

async function scrapeByPlatform(feed) {
  const platform = feed.platform || 'instagram';
  switch (platform) {
    case 'twitter':
      return scrapeTwitterProfile(feed.username);
    case 'facebook':
      return scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
    case 'linkedin':
      return scrapeLinkedInProfile(feed.username);
    case 'txt':
      return scrapeTxtFile(feed.fullUrl || feed.url);
    case 'custom':
      return scrapeCustomSiteHeadless(
        feed.fullUrl, feed.selector,
        feed.alias || feed.username,
        feed.scrollSelector, feed.scrollCount,
      );
    default:
      return scrapeInstagramProfile(feed.username);
  }
}

function computeLatestPostDate(posts) {
  const real = posts.filter(p => !p.timestampEstimated && p.timestamp);
  const candidates = real.length > 0 ? real : posts.filter(p => p.timestamp);
  if (candidates.length === 0) return null;
  return new Date(
    Math.max(...candidates.map(p => new Date(p.timestamp).getTime())),
  ).toISOString();
}

// ── Smart staggered feed refresher (identical logic to main.js) ────────────

let refreshTimeout = null;
let isRefreshing = false;
const MAX_STALE_MS = 6 * 60 * 60 * 1000;

function getRandomInterval() {
  const min = 25, max = 65;
  return Math.round((min + Math.random() * (max - min)) * 60 * 1000);
}

function scheduleNextRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);

  let interval = getRandomInterval();

  try {
    const feeds = store.get('feeds');
    if (feeds.length > 0) {
      const sorted = [...feeds].sort((a, b) => {
        const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
        const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
        return ta - tb;
      });
      const oldestTime = sorted[0].lastChecked
        ? new Date(sorted[0].lastChecked).getTime() : 0;
      const age = Date.now() - oldestTime;
      const timeUntilStale = MAX_STALE_MS - age;

      if (timeUntilStale <= 0) {
        interval = 5_000;
      } else if (timeUntilStale < interval) {
        interval = Math.max(timeUntilStale - 2 * 60 * 1000, 5_000);
      }
    }
  } catch (err) {
    console.error('[Smart-refresh] Error computing staleness cap:', err.message);
  }

  const mins = (interval / 60_000).toFixed(1);
  console.log(`[Smart-refresh] Next feed refresh in ${mins} minutes`);
  refreshTimeout = setTimeout(() => refreshOldestFeed(), interval);
}

async function refreshOldestFeed() {
  if (isRefreshing) { scheduleNextRefresh(); return; }
  isRefreshing = true;

  try {
    const feeds = store.get('feeds');
    if (feeds.length === 0) { scheduleNextRefresh(); isRefreshing = false; return; }

    const sorted = [...feeds].sort((a, b) => {
      const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return ta - tb;
    });
    const feed = sorted[0];
    const platform = feed.platform || 'instagram';

    console.log(`[Smart-refresh] Refreshing @${feed.username} (${platform}), last checked: ${feed.lastChecked || 'never'}`);

    const profileData = await scrapeByPlatform(feed);
    const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
    await generateFeed(feedKey, profileData, store, platform);

    const currentFeeds = store.get('feeds');
    const idx = currentFeeds.findIndex(
      f => f.username === feed.username && (f.platform || 'instagram') === platform,
    );
    if (idx !== -1) {
      currentFeeds[idx].lastChecked = new Date().toISOString();
      currentFeeds[idx].postCount = profileData.posts.length;
      currentFeeds[idx].latestPostDate =
        computeLatestPostDate(profileData.posts) || currentFeeds[idx].latestPostDate || null;
      store.set('feeds', currentFeeds);
    }

    console.log(`[Smart-refresh] @${feed.username} done (${profileData.posts.length} posts)`);
  } catch (err) {
    const feeds = store.get('feeds');
    const sorted = [...feeds].sort((a, b) => {
      const ta = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const tb = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return ta - tb;
    });
    const feed = sorted[0];
    console.error(`[Smart-refresh] Failed @${feed?.username || 'unknown'}: ${err.message}`);

    if (feed) {
      try {
        const currentFeeds = store.get('feeds');
        const idx = currentFeeds.findIndex(
          f => f.username === feed.username
            && (f.platform || 'instagram') === (feed.platform || 'instagram'),
        );
        if (idx !== -1) {
          const prev = currentFeeds[idx].lastChecked
            ? new Date(currentFeeds[idx].lastChecked).getTime() : 0;
          currentFeeds[idx].lastChecked = new Date(prev + 30 * 60 * 1000).toISOString();
          store.set('feeds', currentFeeds);
          console.log(`[Smart-refresh] Bumped @${feed.username} lastChecked by 30 min`);
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

// ── Management REST API ────────────────────────────────────────────────────

function setupManagementAPI(expressApp) {
  const router = express.Router();
  router.use(express.json());

  const apiToken = process.env.UNSOCIAL_API_TOKEN;
  if (apiToken) {
    router.use((req, res, next) => {
      const provided =
        req.query.api_token ||
        req.headers['x-api-token'] ||
        ((req.headers.authorization || '').startsWith('Bearer ')
          ? req.headers.authorization.slice(7) : null);
      if (provided === apiToken) return next();
      res.status(401).json({ error: 'Invalid or missing API token' });
    });
    console.log('[API] Management API is protected by UNSOCIAL_API_TOKEN');
  } else {
    console.log('[API] WARNING: No UNSOCIAL_API_TOKEN set — management API is unprotected');
  }

  // ── List feeds ───────────────────────────────────────────────────────────
  router.get('/feeds', (_req, res) => {
    res.json({ feeds: store.get('feeds') });
  });

  // ── Add a feed ───────────────────────────────────────────────────────────
  router.post('/feeds', async (req, res) => {
    try {
      const { url, selector, alias, scrollSelector, scrollCount } = req.body || {};
      if (!url) return res.status(400).json({ error: 'url is required' });

      const parsed = parseProfileInput(url);
      if (!parsed) {
        return res.status(400).json({
          error: 'Invalid URL or username. Supported: Instagram, Twitter/X, Facebook, LinkedIn, .txt URLs, or any website URL',
        });
      }

      let { username, platform } = parsed;
      if (selector) platform = 'custom';

      const feeds = store.get('feeds');
      if (feeds.find(f => f.username === username && (f.platform || 'instagram') === platform)) {
        return res.status(409).json({ error: `Already tracking @${username} on ${platform}` });
      }

      let profileData;
      if (platform === 'custom') {
        const feedName = alias || username;
        profileData = await scrapeCustomSiteHeadless(
          parsed.fullUrl || url, selector, feedName,
          scrollSelector, scrollCount || 0,
        );
      } else {
        profileData = await scrapeByPlatform({
          ...parsed,
          fullUrl: parsed.fullUrl || (platform === 'txt' ? url : null),
        });
      }

      if (!profileData || profileData.posts.length < 1) {
        return res.status(422).json({ error: 'No posts found for the given URL' });
      }

      const feedKey = username.replace(/\//g, '-');
      const platformUrls = {
        twitter: `https://x.com/${username}`,
        facebook: `https://www.facebook.com/${username}`,
        instagram: `https://www.instagram.com/${username}/`,
        linkedin: `https://www.linkedin.com/in/${username}`,
        txt: parsed.fullUrl || url,
        custom: parsed.fullUrl || url,
      };

      const entry = {
        url: platformUrls[platform] || platformUrls.instagram,
        username,
        feedKey,
        platform,
        subTab: parsed.subTab || null,
        fullUrl: parsed.fullUrl || (platform === 'txt' ? url : null),
        selector: selector || null,
        scrollSelector: scrollSelector || null,
        scrollCount: scrollCount || 0,
        alias: alias || username,
        lastChecked: new Date().toISOString(),
        postCount: profileData.posts.length,
        latestPostDate: computeLatestPostDate(profileData.posts),
      };

      feeds.push(entry);
      store.set('feeds', feeds);
      await generateFeed(feedKey, profileData, store, platform);

      console.log(`[API] Added feed: @${username} (${platform})`);
      res.status(201).json({ success: true, feed: entry });
    } catch (err) {
      console.error('[API] Add feed error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Remove a feed ────────────────────────────────────────────────────────
  router.delete('/feeds', (req, res) => {
    const { username, platform } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username is required' });
    const plat = platform || 'instagram';

    const before = store.get('feeds').length;
    const feeds = store.get('feeds').filter(
      f => !(f.username === username && (f.platform || 'instagram') === plat),
    );
    store.set('feeds', feeds);

    if (feeds.length === before) {
      return res.status(404).json({ error: 'Feed not found' });
    }

    console.log(`[API] Removed feed: @${username} (${plat})`);
    res.json({ success: true, feeds });
  });

  // ── Rename a feed ────────────────────────────────────────────────────────
  router.patch('/feeds/rename', (req, res) => {
    const { username, platform, alias } = req.body || {};
    if (!username || !alias) {
      return res.status(400).json({ error: 'username and alias are required' });
    }
    const plat = platform || 'instagram';
    const feedDir = getFeedDir();

    const feeds = store.get('feeds').map(f => {
      if (f.username === username && (f.platform || 'instagram') === plat) {
        const oldFeedKey = (f.feedKey || f.username).replace(/\//g, '-');
        const newFeedKey = alias.trim()
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

        for (const ext of ['rss.xml', 'atom.xml']) {
          const oldPath = path.join(feedDir, `${oldFeedKey}.${ext}`);
          const newPath = path.join(feedDir, `${newFeedKey}.${ext}`);
          try { if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath); } catch (_) {}
        }
        return { ...f, alias, feedKey: newFeedKey };
      }
      return f;
    });
    store.set('feeds', feeds);
    res.json({ success: true, feeds });
  });

  // ── Refresh a single feed ────────────────────────────────────────────────
  router.post('/feeds/refresh', async (req, res) => {
    try {
      const { username, platform } = req.body || {};
      if (!username) return res.status(400).json({ error: 'username is required' });
      const plat = platform || 'instagram';

      const feed = store.get('feeds').find(
        f => f.username === username && (f.platform || 'instagram') === plat,
      );
      if (!feed) return res.status(404).json({ error: 'Feed not found' });

      const profileData = await scrapeByPlatform(feed);
      const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
      await generateFeed(feedKey, profileData, store, plat);

      const feeds = store.get('feeds').map(f => {
        if (f.username === username && (f.platform || 'instagram') === plat) {
          return {
            ...f,
            lastChecked: new Date().toISOString(),
            postCount: profileData.posts.length,
            latestPostDate: computeLatestPostDate(profileData.posts) || f.latestPostDate || null,
          };
        }
        return f;
      });
      store.set('feeds', feeds);

      console.log(`[API] Refreshed: @${username} (${plat}) — ${profileData.posts.length} posts`);
      res.json({
        success: true,
        feed: feeds.find(f => f.username === username && (f.platform || 'instagram') === plat),
      });
    } catch (err) {
      console.error('[API] Refresh error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Refresh all feeds ────────────────────────────────────────────────────
  router.post('/refresh-all', async (_req, res) => {
    const feedsSnapshot = store.get('feeds');
    const results = [];

    for (const feed of feedsSnapshot) {
      try {
        const plat = feed.platform || 'instagram';
        const profileData = await scrapeByPlatform(feed);
        const fk = (feed.feedKey || feed.username).replace(/\//g, '-');
        await generateFeed(fk, profileData, store, plat);

        const currentFeeds = store.get('feeds');
        const idx = currentFeeds.findIndex(
          f => f.username === feed.username && (f.platform || 'instagram') === plat,
        );
        if (idx !== -1) {
          currentFeeds[idx].lastChecked = new Date().toISOString();
          currentFeeds[idx].postCount = profileData.posts.length;
          currentFeeds[idx].latestPostDate =
            computeLatestPostDate(profileData.posts) || currentFeeds[idx].latestPostDate || null;
          store.set('feeds', currentFeeds);
        }

        results.push({ username: feed.username, platform: plat, success: true });
      } catch (err) {
        results.push({ username: feed.username, platform: feed.platform, success: false, error: err.message });
      }
    }

    res.json({ results });
  });

  // ── Get / update config ──────────────────────────────────────────────────
  router.get('/config', (_req, res) => {
    res.json({
      serverPort: store.get('serverPort'),
      checkIntervalMinutes: store.get('checkIntervalMinutes'),
      feedToken: store.get('feedToken') ? '(set)' : '(not set)',
      tunnelDomain: store.get('tunnelDomain'),
      tunnelName: store.get('tunnelName'),
      dataDir: app.getPath('userData'),
    });
  });

  router.patch('/config', (req, res) => {
    const allowed = ['checkIntervalMinutes', 'tunnelDomain', 'tunnelName', 'feedToken'];
    const body = req.body || {};
    for (const key of allowed) {
      if (body[key] !== undefined) store.set(key, body[key]);
    }
    res.json({ success: true });
  });

  // ── Token management ─────────────────────────────────────────────────────
  router.get('/token', (_req, res) => {
    const token = store.get('feedToken');
    res.json({ feedToken: token || null, isSet: !!token });
  });

  router.post('/token/generate', (_req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    store.set('feedToken', token);
    console.log('[API] Generated new feed token');
    res.json({ feedToken: token });
  });

  // ── Server status ────────────────────────────────────────────────────────
  router.get('/status', (_req, res) => {
    const feeds = store.get('feeds');
    res.json({
      mode: 'headless',
      uptime: process.uptime(),
      feedCount: feeds.length,
      dataDir: app.getPath('userData'),
      port: store.get('serverPort'),
      isRefreshing,
    });
  });

  expressApp.use('/api', router);
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  const port = store.get('serverPort');

  console.log('────────────────────────────────────────');
  console.log(' UnSocial — Headless / Docker mode');
  console.log('────────────────────────────────────────');
  console.log(`Data directory : ${app.getPath('userData')}`);
  console.log(`Feed server    : http://0.0.0.0:${port}/`);
  console.log(`Management API : http://0.0.0.0:${port}/api/`);
  console.log('────────────────────────────────────────');

  const feedApp = startFeedServer(store, { host: '0.0.0.0' });
  setupManagementAPI(feedApp);
  scheduleNextRefresh();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[Headless] ${signal} received, shutting down...`);
  if (refreshTimeout) clearTimeout(refreshTimeout);
  stopFeedServer();
  app.quit();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
