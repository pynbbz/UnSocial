const { BrowserWindow } = require('electron');
const { getRealisticUserAgent } = require('./user-agent');

/**
 * Scrape a Reddit page (subreddit, search results, or user profile)
 * using a hidden Electron BrowserWindow with authenticated session cookies.
 *
 * Supports:
 * - Subreddits (/r/name, /r/name/top/?t=week, /r/name/new, /r/name/hot, etc.)
 * - Search results (/r/name/search/?q=...&sort=...)
 * - User posts (/user/name/submitted/ or /u/name/)
 * - Special feeds (/r/all, /r/popular)
 */
async function scrapeReddit(targetUrl, _cookieString) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('Valid Reddit target URL is required');
  }
  targetUrl = targetUrl.trim();
  // Ensure protocol
  if (!targetUrl.startsWith('http')) {
    targetUrl = 'https://www.reddit.com' + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
  }
  // Strip .rss extension if present
  targetUrl = targetUrl.replace(/\.rss(?=[?#]|$)/i, '');
  if (targetUrl.endsWith('/.rss')) {
    targetUrl = targetUrl.replace(/\/\.rss$/, '/');
  }

  const hidden = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Use a realistic user agent
  const chromeUA = getRealisticUserAgent();
  hidden.webContents.session.setUserAgent(chromeUA);
  hidden.webContents.setUserAgent(chromeUA);

  try {
    const result = await loadAndExtract(hidden, targetUrl);
    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function loadAndExtract(win, targetUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading Reddit URL: ${targetUrl}`));
    }, 40000);

    let handled = false;
    win.webContents.on('did-finish-load', async () => {
      const curUrl = win.webContents.getURL();
      if (!curUrl || curUrl === 'about:blank') return;
      if (handled) return;
      handled = true;

      // Allow SPA hydration & initial post rendering
      await sleep(3500);

      try {
        // Optional quick scroll down to trigger initial lazy load of posts
        await win.webContents.executeJavaScript(`
          try { window.scrollBy(0, 800); } catch (_) {}
        `);
        await sleep(1000);

        const data = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var posts = [];
              var seenIds = new Set();

              function isRedditAd(el) {
                if (!el) return false;
                var tag = (el.tagName || '').toUpperCase();
                if (tag === 'SHREDDIT-AD-POST' || tag === 'SHREDDIT-AD' || tag === 'SHREDDIT-PROMOTED-POST') {
                  return true;
                }
                if (el.hasAttribute('promoted') || el.hasAttribute('is-promoted') || el.getAttribute('is-promoted') === 'true') {
                  return true;
                }
                if (el.hasAttribute('data-promoted') || el.getAttribute('data-promoted') === 'true') {
                  return true;
                }
                if (el.classList && (el.classList.contains('promotedlink') || el.classList.contains('promoted'))) {
                  return true;
                }
                if (el.getAttribute('post-type') === 'promoted' || el.getAttribute('ad-type') || el.getAttribute('adtype')) {
                  return true;
                }
                if (el.getAttribute('domain') === 'ads.reddit.com') {
                  return true;
                }
                if (el.hasAttribute('data-ad-click-location') || el.hasAttribute('data-adclicklocation') || el.hasAttribute('data-adclicktracker')) {
                  return true;
                }
                if (el.querySelector('[slot="promoted-badge"], .promoted-name-container, .advertiser-name, [data-testid*="promoted"], [data-ad-click-location], [data-adclicklocation], [data-adclicktracker], a[href*="alb.reddit.com"], a[href*="ads.reddit.com"]')) {
                  return true;
                }
                if (el.innerText && /^\\s*advertisement:/i.test(el.innerText)) {
                  return true;
                }
                var permalink = el.getAttribute('permalink') || '';
                var contentHref = el.getAttribute('content-href') || '';
                if (permalink.includes('ads.reddit.com') || contentHref.includes('ads.reddit.com') || contentHref.includes('alb.reddit.com')) {
                  return true;
                }
                return false;
              }

              // ── 0. Remove Reddit Sponsored / Promoted Ad Elements ──
              var adElements = document.querySelectorAll('shreddit-ad-post, shreddit-ad, shreddit-promoted-post, .promotedlink, [data-promoted="true"], [data-adclicklocation], [data-ad-click-location], [data-adclicktracker]');
              adElements.forEach(function(ad) {
                try { ad.remove(); } catch (_) {}
              });

              // ── 1. Shreddit Posts (Modern Subreddit & User Pages) ──
              var shredditPosts = document.querySelectorAll('shreddit-post');
              if (shredditPosts.length > 0) {
                shredditPosts.forEach(function(p) {
                  try {
                    if (isRedditAd(p)) return;

                    var id = p.getAttribute('id') || p.id || '';
                    if (!id) {
                      var perm = p.getAttribute('permalink') || '';
                      var m = perm.match(/\\/comments\\/([a-zA-Z0-9]+)/);
                      if (m) id = m[1];
                    }
                    if (id && seenIds.has(id)) return;
                    if (id) seenIds.add(id);

                    var postTitle = p.getAttribute('post-title');
                    if (!postTitle) {
                      var slotTitle = p.querySelector('[slot="title"]');
                      if (slotTitle) postTitle = slotTitle.innerText.trim();
                    }
                    if (!postTitle) {
                      var titleLink = p.querySelector('a[href*="/comments/"]');
                      if (titleLink) postTitle = titleLink.innerText.trim();
                    }
                    if (!postTitle) return;

                    var permalink = p.getAttribute('permalink') || '';
                    if (permalink && !permalink.startsWith('http')) {
                      permalink = 'https://www.reddit.com' + permalink;
                    }

                    var author = p.getAttribute('author') || '';
                    var score = parseInt(p.getAttribute('score'), 10) || 0;
                    var commentCount = parseInt(p.getAttribute('comment-count'), 10) || 0;
                    var createdTimestamp = p.getAttribute('created-timestamp') || null;
                    var contentHref = p.getAttribute('content-href') || '';

                    // Image / Media thumbnail
                    var imageUrl = '';
                    var img = p.querySelector('img[src*="redd.it"], img[src*="preview.redd.it"], [slot="thumbnail"] img');
                    if (img && img.src && !img.src.includes('avatar') && !img.src.includes('emoji')) {
                      imageUrl = img.src;
                    }

                    // Self text snippet
                    var bodyText = '';
                    var bodyEl = p.querySelector('[slot="text-body"], .text-neutral-content, div[id$="-post-rtjson-content"]');
                    if (bodyEl) {
                      bodyText = bodyEl.innerText.trim();
                    }

                    posts.push({
                      id: id || ('post-' + posts.length),
                      title: postTitle,
                      author: author,
                      caption: bodyText || (contentHref && contentHref !== permalink ? contentHref : ''),
                      likes: score,
                      comments: commentCount,
                      timestamp: createdTimestamp || new Date().toISOString(),
                      permalink: permalink,
                      contentHref: contentHref,
                      imageUrl: imageUrl,
                      externalUrl: (contentHref && contentHref !== permalink) ? contentHref : null,
                    });
                  } catch (_) {}
                });
              }

              // ── 2. Search Results / Alternative Layout Fallback ──
              if (posts.length === 0) {
                var commentLinks = document.querySelectorAll('a[href*="/comments/"]');
                commentLinks.forEach(function(a) {
                  try {
                    if (a.closest('shreddit-ad-post, shreddit-ad, shreddit-promoted-post, .promotedlink, [data-promoted], [data-adclicklocation], [data-ad-click-location], [data-adclicktracker], [data-testid*="promoted"]')) {
                      return;
                    }

                    var href = a.getAttribute('href') || a.href;
                    var m = href.match(/\\/comments\\/([a-zA-Z0-9]+)/);
                    if (!m) return;
                    var postId = m[1];
                    if (seenIds.has(postId)) return;
                    seenIds.add(postId);

                    var fullHref = href.startsWith('http') ? href : 'https://www.reddit.com' + href;
                    var title = a.innerText.trim();

                    // Find enclosing article/card if possible
                    var article = a.closest('article, [data-testid="search-post-unit"], [data-testid="post-container"]') || a.parentElement;
                    if (article && isRedditAd(article)) return;
                    if (!title && article) {
                      var heading = article.querySelector('h2, h3, a[href*="/comments/"]');
                      if (heading) title = heading.innerText.trim();
                    }
                    if (!title) return;

                    var timeEl = article ? article.querySelector('time, faceplate-timeago') : null;
                    var timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('ts')) : null;

                    var authorEl = article ? article.querySelector('a[href*="/user/"], a[href*="/u/"]') : null;
                    var author = authorEl ? authorEl.innerText.replace(/^u\\//, '').trim() : '';

                    var img = article ? article.querySelector('img') : null;
                    var imageUrl = (img && img.src && !img.src.includes('avatar')) ? img.src : '';

                    // Try to find score and comment counts in article text
                    var score = 0;
                    var comments = 0;
                    if (article && article.innerText) {
                      var text = article.innerText;
                      var upvoteMatch = text.match(/([\\d,.]+[kKmM]?)\\s*(?:upvotes|points)/i);
                      if (upvoteMatch) score = parseRedditCount(upvoteMatch[1]);
                      var commentMatch = text.match(/([\\d,.]+[kKmM]?)\\s*comments/i);
                      if (commentMatch) comments = parseRedditCount(commentMatch[1]);
                    }

                    posts.push({
                      id: postId,
                      title: title,
                      author: author,
                      caption: title,
                      likes: score,
                      comments: comments,
                      timestamp: timestamp || new Date().toISOString(),
                      permalink: fullHref,
                      contentHref: fullHref,
                      imageUrl: imageUrl,
                      externalUrl: null,
                    });
                  } catch (_) {}
                });
              }

              // ── Page Metadata ──
              var ogTitle = '';
              var ogDesc = '';
              var ogImage = '';
              var el = document.querySelector('meta[property="og:title"]');
              if (el) ogTitle = el.content || '';
              el = document.querySelector('meta[property="og:description"], meta[name="description"]');
              if (el) ogDesc = el.content || '';
              el = document.querySelector('meta[property="og:image"]');
              if (el) ogImage = el.content || '';

              return {
                title: ogTitle || document.title || 'Reddit',
                description: ogDesc || '',
                image: ogImage || '',
                url: window.location.href,
                posts: posts,
              };
            } catch (err) {
              return { error: err.message, posts: [] };
            }

            function parseRedditCount(str) {
              if (!str) return 0;
              str = str.replace(/,/g, '').trim().toLowerCase();
              if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
              if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000000);
              return parseInt(str, 10) || 0;
            }
          })()
        `);

        clearTimeout(timeout);

        if (data.error) {
          reject(new Error(`Reddit scraping error: ${data.error}`));
          return;
        }

        // Format into profileData
        const result = {
          fullName: data.title,
          username: extractSubredditOrUser(targetUrl),
          biography: data.description,
          siteUrl: targetUrl,
          profilePicUrl: data.image || 'https://www.redditstatic.com/shreddit/assets/favicon/192x192.png',
          posts: data.posts,
        };

        resolve(result);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      // Ignore ERR_ABORTED (-3) and ERR_FAILED (-2) as they happen on redirects and intermediate frames
      if (errorCode === -3 || errorCode === -2 || errorCode === 'ERR_ABORTED' || errorCode === 'ERR_FAILED' || isMainFrame === false) return;
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      reject(new Error(`Failed to load Reddit page: ${errorDescription} (${errorCode})`));
    });

    win.loadURL(targetUrl).catch((err) => {
      // Ignore ERR_ABORTED (-3) and ERR_FAILED (-2): Chromium cancels/fails the initial navigation request when redirects occur
      if (err && (
        err.code === 'ERR_ABORTED' || err.message?.includes('ERR_ABORTED') || err.errno === -3 ||
        err.code === 'ERR_FAILED' || err.message?.includes('ERR_FAILED') || err.errno === -2
      )) {
        return;
      }
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function extractSubredditOrUser(url) {
  try {
    const u = new URL(url);
    const subMatch = u.pathname.match(/\/r\/([a-zA-Z0-9_]+)/i);
    if (subMatch) return `r/${subMatch[1]}`;
    const userMatch = u.pathname.match(/\/(?:user|u)\/([a-zA-Z0-9_-]+)/i);
    if (userMatch) return `u/${userMatch[1]}`;
  } catch (_) {}
  return 'reddit';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { scrapeReddit, extractSubredditOrUser };
