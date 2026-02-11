const { BrowserWindow } = require('electron');

/**
 * Scrape a LinkedIn profile/company page using a hidden Electron BrowserWindow.
 * Works the same way as the other scrapers — loads the real page in
 * Chromium with the user's authenticated session, waits for JS to render,
 * then extracts posts from the DOM.
 */
async function scrapeLinkedInProfile(username) {
  // Support both company pages and personal profiles
  const isCompany = username.startsWith('company/');
  const profileUrl = `https://www.linkedin.com/${isCompany ? username : `in/${username}`}/recent-activity/all/`;

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
    const result = await loadAndExtract(hidden, profileUrl, username, isCompany);
    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function loadAndExtract(win, profileUrl, username, isCompany) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading LinkedIn profile: ${username}`));
    }, 45000);

    let handled = false;
    win.webContents.on('did-finish-load', async () => {
      if (handled) return;
      handled = true;

      // LinkedIn is JS-heavy; give time for posts to render
      await sleep(6000);

      try {
        // Check for login wall
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || currentUrl.includes('authwall')) {
          clearTimeout(timeout);
          reject(new Error('LinkedIn requires login. Please log in to LinkedIn first.'));
          return;
        }

        // Scroll to load more content
        await win.webContents.executeJavaScript('window.scrollBy(0, 800)');
        await sleep(2000);
        await win.webContents.executeJavaScript('window.scrollBy(0, 800)');
        await sleep(2000);
        await win.webContents.executeJavaScript('window.scrollBy(0, 800)');
        await sleep(2000);
        await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
        await sleep(1000);

        const data = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var posts = [];
              var seen = new Set();

              // ── Extract posts from the activity feed ──
              // On /recent-activity/all/ LinkedIn renders each post inside
              // .feed-shared-update-v2 containers or occludable-update wrappers.
              // We also grab any element with a data-urn that looks like a post.
              var postEls = document.querySelectorAll(
                '.feed-shared-update-v2, .occludable-update, ' +
                '[data-urn*="urn:li:activity"], [data-urn*="urn:li:ugcPost"], [data-urn*="urn:li:share"]'
              );

              for (var i = 0; i < postEls.length && posts.length < 20; i++) {
                try {
                  var postEl = postEls[i];

                  // ── Find the REAL permalink ──
                  var permalink = '';
                  var postUniqueId = '';

                  // Strategy 1: Timestamp link — the <a> that wraps or is near <time>
                  var timeEl = postEl.querySelector('time');
                  if (timeEl) {
                    var timeLink = timeEl.closest('a');
                    if (!timeLink) {
                      // Sometimes <time> is a sibling or child, check parent's children
                      var timeParent = timeEl.parentElement;
                      if (timeParent) timeLink = timeParent.closest('a') || timeParent.querySelector('a');
                    }
                    if (timeLink) {
                      var timeLinkHref = timeLink.href || '';
                      if (timeLinkHref.includes('/feed/update/')) {
                        permalink = timeLinkHref;
                        var urnFromTime = timeLinkHref.match(/\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                        if (urnFromTime) postUniqueId = urnFromTime[1];
                      } else if (timeLinkHref.includes('/posts/')) {
                        permalink = timeLinkHref;
                        var actFromTime = timeLinkHref.match(/activity[:-](\\d+)/);
                        if (actFromTime) postUniqueId = 'urn:li:activity:' + actFromTime[1];
                      }
                    }
                  }

                  // Strategy 2: CSS selector for <a> with /feed/update/ in href attribute
                  if (!permalink) {
                    var updateLinks = postEl.querySelectorAll('a[href*="/feed/update/"]');
                    for (var a = 0; a < updateLinks.length; a++) {
                      var href = updateLinks[a].href || '';
                      var m = href.match(/\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                      if (m) {
                        permalink = href.split('?')[0];
                        postUniqueId = m[1];
                        break;
                      }
                    }
                  }

                  // Strategy 3: Scan ALL <a> elements for LinkedIn post URL patterns
                  // Catches links set programmatically by React that may not match CSS selectors
                  if (!permalink) {
                    var allPostLinks = postEl.querySelectorAll('a');
                    for (var al = 0; al < allPostLinks.length; al++) {
                      var aHref = allPostLinks[al].href || '';
                      if (!aHref) continue;
                      var feedM = aHref.match(/linkedin\\.com\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                      if (feedM) {
                        permalink = aHref.split('?')[0];
                        postUniqueId = feedM[1];
                        break;
                      }
                    }
                    // Also check for /posts/ URLs
                    if (!permalink) {
                      for (var al2 = 0; al2 < allPostLinks.length; al2++) {
                        var aHref2 = allPostLinks[al2].href || '';
                        if (aHref2.includes('/posts/') && aHref2.includes('linkedin.com')) {
                          permalink = aHref2.split('?')[0];
                          var actFromLink = aHref2.match(/activity[:-](\\d+)/);
                          if (actFromLink) postUniqueId = 'urn:li:activity:' + actFromLink[1];
                          else postUniqueId = 'posts-' + i;
                          break;
                        }
                      }
                    }
                  }

                  // Strategy 4: data-urn attribute on the container or ancestors
                  if (!postUniqueId) {
                    var urnEl = postEl.closest('[data-urn]') || postEl;
                    var urn = urnEl.getAttribute('data-urn') || postEl.getAttribute('data-urn') || '';
                    var urnMatch = urn.match(/(urn:li:[a-zA-Z]+:\\d+)/);
                    if (urnMatch) {
                      postUniqueId = urnMatch[1];
                      if (!permalink) {
                        permalink = 'https://www.linkedin.com/feed/update/' + postUniqueId + '/';
                      }
                    }
                  }

                  // Strategy 5: data-id attribute
                  if (!postUniqueId) {
                    var dataId = postEl.getAttribute('data-id') || '';
                    var m4 = dataId.match(/(\\d{10,})/);
                    if (m4) postUniqueId = 'id:' + m4[1];
                  }

                  // Last resort: positional ID (won't have a valid permalink)
                  if (!postUniqueId) postUniqueId = 'pos-' + i;

                  // Ensure permalink is absolute
                  if (permalink && !permalink.startsWith('http')) {
                    permalink = 'https://www.linkedin.com' + permalink;
                  }
                  // Clean up trailing slashes and query params for consistency
                  if (permalink) {
                    permalink = permalink.split('?')[0];
                    if (!permalink.endsWith('/')) permalink += '/';
                  }

                  if (seen.has(postUniqueId)) continue;
                  seen.add(postUniqueId);

                  // ── Post text ──
                  var textContent = '';
                  // LinkedIn uses multiple possible containers for post text
                  var textEl2 = postEl.querySelector(
                    '.feed-shared-text, .feed-shared-update-v2__description, ' +
                    '.update-components-text, [data-test-id="main-feed-activity-card__commentary"]'
                  );
                  if (textEl2) {
                    textContent = textEl2.innerText.trim();
                  }
                  // Broader fallback: longest text span with dir="ltr"
                  if (!textContent) {
                    var spanEls = postEl.querySelectorAll('.break-words span[dir="ltr"], span.break-words');
                    for (var s = 0; s < spanEls.length; s++) {
                      var txt = spanEls[s].innerText.trim();
                      if (txt.length > textContent.length) textContent = txt;
                    }
                  }

                  // ── Timestamp ──
                  var timestamp = null;
                  if (timeEl) {
                    timestamp = timeEl.getAttribute('datetime') || null;
                  }
                  // Fallback: spans with relative time text (e.g. "2d", "3w")
                  if (!timestamp) {
                    var timeSpans = postEl.querySelectorAll(
                      '.feed-shared-actor__sub-description span, ' +
                      '.update-components-actor__sub-description span, ' +
                      'a[href*="/feed/update/"] span'
                    );
                    for (var t = 0; t < timeSpans.length; t++) {
                      var timeText = timeSpans[t].innerText.trim();
                      if (timeText.match(/^\\d+[hdwmo]$|^\\d+\\s*(hour|day|week|month|minute|year)/i)) {
                        timestamp = approximateTimeFromRelative(timeText);
                        break;
                      }
                    }
                  }

                  // ── Images ──
                  var images = [];
                  var imgEls = postEl.querySelectorAll(
                    '.feed-shared-image img, .update-components-image img, ' +
                    '.ivm-image-view-model img, .feed-shared-article img'
                  );
                  for (var j = 0; j < imgEls.length; j++) {
                    var src = imgEls[j].src || imgEls[j].getAttribute('data-delayed-url') || '';
                    if (src &&
                        !src.includes('data:image') &&
                        !src.includes('static.licdn.com/aero') &&
                        !src.includes('profile-displayphoto-shrink') &&
                        !src.includes('/aero-v1/') &&
                        !src.includes('data:image/gif')) {
                      images.push(src);
                    }
                  }

                  // ── Video ──
                  var hasVideo = postEl.querySelector(
                    'video, .feed-shared-linkedin-video, .update-components-linkedin-video'
                  ) !== null;

                  // ── Engagement metrics ──
                  var likes = 0;
                  var comments = 0;
                  // Try the social counts bar
                  var socialCountEl = postEl.querySelector(
                    '.social-details-social-counts, .feed-shared-social-counts'
                  );
                  if (socialCountEl) {
                    // LinkedIn often shows "X reactions" and "Y comments" as separate spans
                    var allSpans = socialCountEl.querySelectorAll('span, button');
                    for (var sc = 0; sc < allSpans.length; sc++) {
                      var scText = allSpans[sc].innerText || allSpans[sc].getAttribute('aria-label') || '';
                      var likeM = scText.match(/(\\d[\\d,]*)\\s*(?:reaction|like)/i);
                      if (likeM && !likes) likes = parseInt(likeM[1].replace(/,/g, ''));
                      var commentM = scText.match(/(\\d[\\d,]*)\\s*comment/i);
                      if (commentM && !comments) comments = parseInt(commentM[1].replace(/,/g, ''));
                    }
                  }
                  // Fallback: aria-labels on reaction buttons
                  if (!likes) {
                    var reactBtn = postEl.querySelector('button[aria-label*="reaction"], button[aria-label*="like"]');
                    if (reactBtn) {
                      var m5 = (reactBtn.getAttribute('aria-label') || '').match(/(\\d[\\d,]*)/);
                      if (m5) likes = parseInt(m5[1].replace(/,/g, ''));
                    }
                  }

                  // ── Author ──
                  var authorName = '';
                  var authorEl = postEl.querySelector(
                    '.feed-shared-actor__name, .update-components-actor__name'
                  );
                  if (authorEl) {
                    // Remove "View X's profile" aria text, just get visible text
                    var visibleSpan = authorEl.querySelector('span[aria-hidden="true"]');
                    authorName = visibleSpan ? visibleSpan.innerText.trim() : authorEl.innerText.trim().split('\\n')[0];
                  }

                  // Skip posts with no text and no images (likely empty wrappers)
                  if (!textContent && images.length === 0 && !hasVideo) continue;

                  posts.push({
                    id: postUniqueId,
                    text: textContent,
                    timestamp: timestamp,
                    images: images,
                    hasVideo: hasVideo,
                    likes: likes,
                    comments: comments,
                    permalink: permalink,
                    authorName: authorName,
                  });
                } catch (_) {}
              }

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

              // Get display name from profile header
              var headerName = '';
              var nameEl = document.querySelector('h1, .text-heading-xlarge');
              if (nameEl) headerName = nameEl.innerText.trim();

              return {
                posts: posts,
                ogTitle: ogTitle || headerName,
                ogDesc: ogDesc,
                ogImage: ogImage,
                headerName: headerName,
              };
            } catch (e) {
              return { error: e.message, posts: [] };
            }

            function approximateTimeFromRelative(text) {
              var now = Date.now();
              var match;
              if ((match = text.match(/(\\d+)\\s*m/))) return new Date(now - parseInt(match[1]) * 60000).toISOString();
              if ((match = text.match(/(\\d+)\\s*h/))) return new Date(now - parseInt(match[1]) * 3600000).toISOString();
              if ((match = text.match(/(\\d+)\\s*d/))) return new Date(now - parseInt(match[1]) * 86400000).toISOString();
              if ((match = text.match(/(\\d+)\\s*w/))) return new Date(now - parseInt(match[1]) * 604800000).toISOString();
              if ((match = text.match(/(\\d+)\\s*mo/))) return new Date(now - parseInt(match[1]) * 2592000000).toISOString();
              if ((match = text.match(/(\\d+)\\s*y/))) return new Date(now - parseInt(match[1]) * 31536000000).toISOString();
              return new Date(now).toISOString();
            }
          })();
        `);

        clearTimeout(timeout);

        // If no posts found, try scrolling more and retrying
        if (!data.posts || data.posts.length === 0) {
          await win.webContents.executeJavaScript('window.scrollTo(0, 1200)');
          await sleep(4000);

          const retry = await win.webContents.executeJavaScript(`
            (function() {
              var posts = [];
              var seen = new Set();
              var postEls = document.querySelectorAll(
                '.feed-shared-update-v2, .occludable-update, ' +
                '[data-urn*="urn:li:activity"], [data-urn*="urn:li:ugcPost"], [data-urn*="urn:li:share"]'
              );
              for (var i = 0; i < postEls.length && posts.length < 20; i++) {
                try {
                  var postEl = postEls[i];
                  var permalink = '';
                  var postUniqueId = '';

                  // Timestamp link
                  var timeEl = postEl.querySelector('time');
                  if (timeEl) {
                    var timeLink = timeEl.closest('a');
                    if (!timeLink) {
                      var tp = timeEl.parentElement;
                      if (tp) timeLink = tp.closest('a') || tp.querySelector('a');
                    }
                    if (timeLink && timeLink.href) {
                      if (timeLink.href.includes('/feed/update/')) {
                        permalink = timeLink.href.split('?')[0];
                        var um = permalink.match(/\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                        if (um) postUniqueId = um[1];
                      } else if (timeLink.href.includes('/posts/')) {
                        permalink = timeLink.href.split('?')[0];
                        var atm = timeLink.href.match(/activity[:-](\\d+)/);
                        if (atm) postUniqueId = 'urn:li:activity:' + atm[1];
                      }
                    }
                  }
                  // CSS selector for /feed/update/ links
                  if (!permalink) {
                    var links = postEl.querySelectorAll('a[href*="/feed/update/"]');
                    for (var a = 0; a < links.length; a++) {
                      var href = links[a].href || '';
                      var m = href.match(/\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                      if (m) {
                        permalink = href.split('?')[0];
                        postUniqueId = m[1];
                        break;
                      }
                    }
                  }
                  // Scan all <a> elements for post URL patterns
                  if (!permalink) {
                    var allLinks = postEl.querySelectorAll('a');
                    for (var al = 0; al < allLinks.length; al++) {
                      var aH = allLinks[al].href || '';
                      var fm = aH.match(/linkedin\\.com\\/feed\\/update\\/(urn:li:[a-zA-Z]+:\\d+)/);
                      if (fm) { permalink = aH.split('?')[0]; postUniqueId = fm[1]; break; }
                    }
                    if (!permalink) {
                      for (var al2 = 0; al2 < allLinks.length; al2++) {
                        var aH2 = allLinks[al2].href || '';
                        if (aH2.includes('/posts/') && aH2.includes('linkedin.com')) {
                          permalink = aH2.split('?')[0];
                          var am = aH2.match(/activity[:-](\\d+)/);
                          if (am) postUniqueId = 'urn:li:activity:' + am[1];
                          else postUniqueId = 'posts-' + i;
                          break;
                        }
                      }
                    }
                  }
                  // data-urn fallback
                  if (!postUniqueId) {
                    var urnEl = postEl.closest('[data-urn]') || postEl;
                    var urn = urnEl.getAttribute('data-urn') || postEl.getAttribute('data-urn') || '';
                    var urnMatch = urn.match(/(urn:li:[a-zA-Z]+:\\d+)/);
                    if (urnMatch) {
                      postUniqueId = urnMatch[1];
                      if (!permalink) permalink = 'https://www.linkedin.com/feed/update/' + postUniqueId + '/';
                    }
                  }
                  if (!postUniqueId) postUniqueId = 'pos-' + i;
                  if (permalink && !permalink.startsWith('http')) permalink = 'https://www.linkedin.com' + permalink;
                  if (permalink && !permalink.endsWith('/')) permalink += '/';
                  if (seen.has(postUniqueId)) continue;
                  seen.add(postUniqueId);

                  var textEl2 = postEl.querySelector('.feed-shared-text, .break-words span[dir="ltr"]');
                  var textContent = textEl2 ? textEl2.innerText.trim() : '';
                  var timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();
                  if (!textContent) continue;
                  posts.push({
                    id: postUniqueId,
                    text: textContent,
                    timestamp: timestamp,
                    images: [],
                    hasVideo: false,
                    likes: 0,
                    comments: 0,
                    permalink: permalink,
                    authorName: '',
                  });
                } catch (_) {}
              }
              return posts;
            })();
          `);

          if (retry && retry.length > 0) {
            data.posts = retry;
          }
        }

        const profileData = buildLinkedInProfile(username, data);
        resolve(profileData);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to extract LinkedIn data for ${username}: ${err.message}`));
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load LinkedIn profile ${username}: ${desc} (${code})`));
    });

    win.loadURL(profileUrl);
  });
}

function buildLinkedInProfile(username, data) {
  let fullName = username;
  if (data.headerName) {
    fullName = data.headerName;
  } else if (data.ogTitle) {
    // LinkedIn og:title often is "Name | LinkedIn"
    const m = data.ogTitle.match(/^(.+?)\s*[|–]/);
    fullName = m ? m[1].trim() : data.ogTitle;
  }

  const posts = [];
  for (const post of (data.posts || []).slice(0, 20)) {
    const caption = post.text || '';
    const title = caption.length > 120 ? caption.slice(0, 119) + '…' : (caption || '(no text)');

    // Build the best permalink we can:
    // 1. Use the directly-extracted permalink if available
    // 2. If post.id is already a full URN (urn:li:...), construct from it
    // 3. Last resort: assume it's an activity numeric id
    let bestPermalink = post.permalink || '';
    if (!bestPermalink && post.id) {
      if (post.id.startsWith('urn:li:')) {
        bestPermalink = `https://www.linkedin.com/feed/update/${post.id}/`;
      } else if (/^\d+$/.test(post.id)) {
        bestPermalink = `https://www.linkedin.com/feed/update/urn:li:activity:${post.id}/`;
      } else {
        bestPermalink = `https://www.linkedin.com/in/${username}/recent-activity/all/`;
      }
    }

    posts.push({
      id: post.id,
      shortcode: post.id,
      caption,
      timestamp: post.timestamp || new Date().toISOString(),
      imageUrl: post.images && post.images.length > 0 ? post.images[0] : '',
      images: post.images || [],
      isVideo: post.hasVideo || false,
      videoUrl: null,
      likes: post.likes || 0,
      comments: post.comments || 0,
      permalink: bestPermalink,
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

module.exports = { scrapeLinkedInProfile };
