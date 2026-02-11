const { BrowserWindow } = require('electron');

/**
 * Scrape a Twitter/X profile using a hidden Electron BrowserWindow.
 * Works the same way as the Instagram scraper — loads the real page in
 * Chromium with the user's authenticated session, waits for JS to render,
 * then extracts tweets from the DOM and any embedded JSON.
 */
async function scrapeTwitterProfile(username, _cookieString) {
  const profileUrl = `https://x.com/${username}`;

  const hidden = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  try {
    const result = await loadAndExtract(hidden, profileUrl, username);
    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function loadAndExtract(win, profileUrl, username) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading @${username}'s Twitter profile`));
    }, 35000);

    win.webContents.on('did-finish-load', async () => {
      // Twitter/X is very JS-heavy; give extra time for tweets to render
      await sleep(5000);

      try {
        const data = await win.webContents.executeJavaScript(`
          (function() {
            try {
              // ── Extract tweets from the timeline ──
              // Twitter renders tweets as article elements
              var articles = document.querySelectorAll('article[data-testid="tweet"]');
              var tweets = [];
              var seen = new Set();

              articles.forEach(function(article) {
                try {
                  // Find the tweet link (contains /status/)
                  var timeEl = article.querySelector('time');
                  var linkEls = article.querySelectorAll('a[href*="/status/"]');
                  var tweetLink = null;
                  for (var i = 0; i < linkEls.length; i++) {
                    var href = linkEls[i].getAttribute('href');
                    if (href && href.match(/\\/status\\/\\d+$/)) {
                      tweetLink = href;
                      break;
                    }
                  }

                  if (!tweetLink) return;

                  var statusMatch = tweetLink.match(/\\/status\\/(\\d+)/);
                  if (!statusMatch) return;
                  var tweetId = statusMatch[1];

                  if (seen.has(tweetId)) return;
                  seen.add(tweetId);

                  // Get tweet text
                  var textEl = article.querySelector('[data-testid="tweetText"]');
                  var tweetText = textEl ? textEl.innerText : '';

                  // Get timestamp
                  var timestamp = timeEl ? timeEl.getAttribute('datetime') : null;

                  // Get images
                  var images = [];
                  var imgEls = article.querySelectorAll('[data-testid="tweetPhoto"] img');
                  imgEls.forEach(function(img) {
                    if (img.src && !img.src.includes('emoji')) {
                      images.push(img.src);
                    }
                  });

                  // Get video indicator
                  var hasVideo = article.querySelector('[data-testid="videoPlayer"]') !== null;

                  // Get metrics
                  var likes = 0;
                  var retweets = 0;
                  var replies = 0;
                  var metricGroups = article.querySelectorAll('[role="group"] button');
                  metricGroups.forEach(function(btn) {
                    var label = btn.getAttribute('aria-label') || '';
                    var replyMatch = label.match(/(\\d+)\\s*repl/i);
                    var rtMatch = label.match(/(\\d+)\\s*re(?:post|tweet)/i);
                    var likeMatch = label.match(/(\\d+)\\s*like/i);
                    if (replyMatch) replies = parseInt(replyMatch[1]);
                    if (rtMatch) retweets = parseInt(rtMatch[1]);
                    if (likeMatch) likes = parseInt(likeMatch[1]);
                  });

                  // Get display name of the tweet author
                  var authorEl = article.querySelector('[data-testid="User-Name"]');
                  var authorName = '';
                  if (authorEl) {
                    var spans = authorEl.querySelectorAll('span');
                    if (spans.length > 0) authorName = spans[0].innerText;
                  }

                  tweets.push({
                    id: tweetId,
                    text: tweetText,
                    timestamp: timestamp,
                    images: images,
                    hasVideo: hasVideo,
                    likes: likes,
                    retweets: retweets,
                    replies: replies,
                    permalink: 'https://x.com' + tweetLink,
                    authorName: authorName,
                  });
                } catch(_) {}
              });

              // ── Profile info ──
              var ogTitle = '';
              var ogDesc = '';
              var ogImage = '';
              var el;
              el = document.querySelector('meta[property="og:title"]');
              if (el) ogTitle = el.content || '';
              el = document.querySelector('meta[property="og:description"], meta[name="description"]');
              if (el) ogDesc = el.content || '';
              el = document.querySelector('meta[property="og:image"]');
              if (el) ogImage = el.content || '';

              // Try to get display name from the page header
              var headerName = '';
              var headerEl = document.querySelector('[data-testid="UserName"]');
              if (headerEl) {
                var nameSpans = headerEl.querySelectorAll('span');
                if (nameSpans.length > 0) headerName = nameSpans[0].innerText;
              }
              // Fallback: page title
              if (!headerName) {
                var titleMatch = document.title.match(/^(.+?)\\s*[\\(\\/@]/);
                if (titleMatch) headerName = titleMatch[1].trim();
              }

              // Try profile avatar
              var avatarEl = document.querySelector('img[alt="Opens profile photo"]');
              var avatarUrl = avatarEl ? avatarEl.src : ogImage;

              return {
                tweets: tweets,
                ogTitle: ogTitle || headerName,
                ogDesc: ogDesc,
                ogImage: avatarUrl || ogImage,
                headerName: headerName,
              };
            } catch(e) {
              return { error: e.message, tweets: [] };
            }
          })();
        `);

        clearTimeout(timeout);

        // If no tweets found, scroll and retry
        if (!data.tweets || data.tweets.length === 0) {
          await win.webContents.executeJavaScript('window.scrollTo(0, 800)');
          await sleep(3000);

          const retry = await win.webContents.executeJavaScript(`
            (function() {
              var articles = document.querySelectorAll('article[data-testid="tweet"]');
              var tweets = [];
              var seen = new Set();
              articles.forEach(function(article) {
                try {
                  var linkEls = article.querySelectorAll('a[href*="/status/"]');
                  var tweetLink = null;
                  for (var i = 0; i < linkEls.length; i++) {
                    var href = linkEls[i].getAttribute('href');
                    if (href && href.match(/\\/status\\/\\d+$/)) { tweetLink = href; break; }
                  }
                  if (!tweetLink) return;
                  var statusMatch = tweetLink.match(/\\/status\\/(\\d+)/);
                  if (!statusMatch) return;
                  var tweetId = statusMatch[1];
                  if (seen.has(tweetId)) return;
                  seen.add(tweetId);
                  var textEl = article.querySelector('[data-testid="tweetText"]');
                  var timeEl = article.querySelector('time');
                  tweets.push({
                    id: tweetId,
                    text: textEl ? textEl.innerText : '',
                    timestamp: timeEl ? timeEl.getAttribute('datetime') : null,
                    images: [],
                    hasVideo: false,
                    likes: 0, retweets: 0, replies: 0,
                    permalink: 'https://x.com' + tweetLink,
                    authorName: '',
                  });
                } catch(_) {}
              });
              return tweets;
            })();
          `);

          if (retry && retry.length > 0) {
            data.tweets = retry;
          }
        }

        const profileData = buildTwitterProfile(username, data);
        resolve(profileData);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to extract Twitter data for @${username}: ${err.message}`));
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load @${username}'s Twitter profile: ${desc} (${code})`));
    });

    win.loadURL(profileUrl);
  });
}

function buildTwitterProfile(username, data) {
  let fullName = username;
  if (data.headerName) {
    fullName = data.headerName;
  } else if (data.ogTitle) {
    const m = data.ogTitle.match(/^(.+?)[\s(/@]/);
    fullName = m ? m[1].trim() : data.ogTitle;
  }

  const posts = [];
  for (const tweet of (data.tweets || []).slice(0, 20)) {
    const caption = tweet.text || '';
    const title = caption.length > 120 ? caption.slice(0, 119) + '…' : (caption || '(no text)');

    posts.push({
      id: tweet.id,
      shortcode: tweet.id,
      caption,
      timestamp: tweet.timestamp || new Date().toISOString(),
      imageUrl: tweet.images && tweet.images.length > 0 ? tweet.images[0] : '',
      images: tweet.images || [],
      isVideo: tweet.hasVideo || false,
      videoUrl: null,
      likes: tweet.likes || 0,
      comments: tweet.replies || 0,
      retweets: tweet.retweets || 0,
      permalink: tweet.permalink || `https://x.com/${username}/status/${tweet.id}`,
    });
  }

  return {
    username,
    fullName,
    biography: data.ogDesc || '',
    profilePicUrl: data.ogImage || '',
    posts,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scrapeTwitterProfile };
