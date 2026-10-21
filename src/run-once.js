const { once } = require('events');

const { startFeedServer, stopFeedServer } = require('./feed-server');
const { generateFeed } = require('./rss-generator');
const { scrapeInstagramProfile } = require('./scraper');
const { scrapeTwitterProfile } = require('./scraper-twitter');
const { scrapeFacebookProfile } = require('./scraper-facebook');
const { scrapeLinkedInProfile } = require('./scraper-linkedin');
const { scrapeTxtFile } = require('./scraper-txt');
const { scrapeCustomSiteHeadless } = require('./scraper-custom');

const DEFAULT_SCRAPE_TIMEOUT_MS = 180_000;
const DEFAULT_MANUAL_DELIVERY_TIMEOUT_MS = 10 * 60_000;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function scrapeFeed(feed) {
  const platform = feed.platform || 'instagram';

  if (platform === 'twitter') return scrapeTwitterProfile(feed.username);
  if (platform === 'facebook') {
    return scrapeFacebookProfile(feed.username, feed.subTab, feed.fullUrl);
  }
  if (platform === 'linkedin') return scrapeLinkedInProfile(feed.username);
  if (platform === 'txt') return scrapeTxtFile(feed.fullUrl || feed.url);
  if (platform === 'custom') {
    return scrapeCustomSiteHeadless(
      feed.fullUrl,
      feed.selector,
      feed.alias || feed.username,
      feed.scrollSelector,
      feed.scrollCount,
    );
  }
  return scrapeInstagramProfile(feed.username);
}

function calculateLatestPostDate(profileData, previousValue) {
  const posts = Array.isArray(profileData.posts) ? profileData.posts : [];
  const realPosts = posts.filter((post) => !post.timestampEstimated && post.timestamp);
  const timestampedPosts = realPosts.length > 0
    ? realPosts
    : posts.filter((post) => post.timestamp);

  const timestamps = timestampedPosts
    .map((post) => new Date(post.timestamp).getTime())
    .filter(Number.isFinite);

  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : previousValue || null;
}

function updateFeedMetadata(store, feed, profileData) {
  const platform = feed.platform || 'instagram';
  const feeds = store.get('feeds');
  const index = feeds.findIndex((candidate) =>
    candidate.username === feed.username &&
    (candidate.platform || 'instagram') === platform
  );

  if (index === -1) return;

  feeds[index].lastChecked = new Date().toISOString();
  feeds[index].postCount = Array.isArray(profileData.posts) ? profileData.posts.length : 0;
  feeds[index].latestPostDate = calculateLatestPostDate(profileData, feeds[index].latestPostDate);
  store.set('feeds', feeds);
}

async function refreshConfiguredFeeds(store, scrapeTimeoutMs = DEFAULT_SCRAPE_TIMEOUT_MS) {
  const configuredFeeds = store.get('feeds');
  const refreshed = [];
  const failed = [];

  if (!Array.isArray(configuredFeeds) || configuredFeeds.length === 0) {
    throw new Error('No feeds are configured in UnSocial.');
  }

  console.log(`[Batch] Refreshing ${configuredFeeds.length} configured feed(s).`);

  for (const feed of configuredFeeds) {
    const platform = feed.platform || 'instagram';
    const label = `${platform}:${feed.username}`;
    console.log(`[Batch] Scraping ${label}...`);

    try {
      const profileData = await withTimeout(
        scrapeFeed(feed),
        scrapeTimeoutMs,
        `Scrape ${label}`,
      );
      const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
      await generateFeed(feedKey, profileData, store, platform);
      updateFeedMetadata(store, feed, profileData);
      refreshed.push({ feed, feedKey, postCount: profileData.posts.length });
      console.log(`[Batch] Refreshed ${label} (${profileData.posts.length} post(s)).`);
    } catch (error) {
      failed.push({ feed, error });
      console.error(`[Batch] Failed ${label}: ${error.message}`);
    }
  }

  return { refreshed, failed };
}

async function waitForServer(server, timeoutMs = 10_000) {
  if (server.listening) return;

  await withTimeout(
    Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([error]) => Promise.reject(error)),
    ]),
    timeoutMs,
    'Starting the local RSS server',
  );
}

function waitForFeedRequests(expectedFeedKeys, observedFeedKeys, deliveryTimeoutMs) {
  const expected = new Set(expectedFeedKeys);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const missing = [...expected].filter((feedKey) => !observedFeedKeys.has(feedKey));
      if (missing.length === 0) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= deliveryTimeoutMs) {
        clearInterval(timer);
        reject(new Error(`The RSS reader did not request feed(s): ${missing.join(', ')}`));
      }
    }, 250);
  });
}

async function serveRefreshedFeeds(store, refreshed, deliveryTimeoutMs, onReady) {
  const expectedFeedKeys = refreshed.map((result) => result.feedKey);
  const observedFeedKeys = new Set();

  const server = startFeedServer(store, {
    onFeedServed({ username, statusCode }) {
      if (statusCode >= 200 && statusCode < 400 && expectedFeedKeys.includes(username)) {
        if (!observedFeedKeys.has(username)) {
          console.log(`[Delivery] RSS reader retrieved ${username}.`);
        }
        observedFeedKeys.add(username);
      }
    },
  });

  try {
    await waitForServer(server);
    await onReady();
    await waitForFeedRequests(expectedFeedKeys, observedFeedKeys, deliveryTimeoutMs);
    console.log('[Delivery] RSS reader retrieved every refreshed feed.');
    return { observedFeedKeys: [...observedFeedKeys] };
  } finally {
    await stopFeedServer();
    console.log('[Delivery] Local RSS server stopped.');
  }
}

async function fetchAndWaitForReader(store, options = {}) {
  const scrapeTimeoutMs = options.scrapeTimeoutMs || DEFAULT_SCRAPE_TIMEOUT_MS;
  const deliveryTimeoutMs = options.deliveryTimeoutMs || DEFAULT_MANUAL_DELIVERY_TIMEOUT_MS;
  const refreshResult = await refreshConfiguredFeeds(store, scrapeTimeoutMs);

  if (refreshResult.refreshed.length === 0) {
    const errors = refreshResult.failed.map(({ feed, error }) =>
      `${feed.username}: ${error.message}`
    );
    throw new Error(`No feeds were refreshed successfully. ${errors.join('; ')}`);
  }

  const port = store.get('serverPort');
  const delivery = await serveRefreshedFeeds(
    store,
    refreshResult.refreshed,
    deliveryTimeoutMs,
    async () => {
      console.log('[Manual] RSS files are ready. Open or refresh your RSS reader now.');
      for (const { feedKey } of refreshResult.refreshed) {
        console.log(`[Manual] Serving http://localhost:${port}/feed/${feedKey}`);
      }
      console.log(`[Manual] Waiting up to ${Math.round(deliveryTimeoutMs / 60_000)} minutes for the feed requests...`);
    },
  );

  return {
    ...refreshResult,
    delivery,
    ok: refreshResult.failed.length === 0,
  };
}

module.exports = {
  calculateLatestPostDate,
  fetchAndWaitForReader,
  refreshConfiguredFeeds,
  waitForFeedRequests,
};
