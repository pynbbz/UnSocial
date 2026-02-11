const { BrowserWindow } = require('electron');

/**
 * Scrape a Facebook page, group, or event using a hidden Electron BrowserWindow.
 * Uses the user's authenticated session to load the page, wait for JS
 * rendering, then extract posts from the DOM.
 *
 * Supports three page types (based on real DOM analysis):
 *   1. Facebook Pages  (e.g. "EventsInCalgary")
 *      - Posts wrapped in div[aria-posinset] with data-virtualized="false"
 *      - Post body in [data-ad-rendering-role="story_message"]
 *      - Author in [data-ad-rendering-role="profile_name"] h2
 *   2. Group Event pages (e.g. "groups/CalgaryMetalSceneEvents/events")
 *      - h2 headings "Upcoming events" / "Past events" separate sections
 *      - Event cards have <a aria-label="EventName" href="/events/ID/...">
 *      - Date in small spans, "Shared by" info
 *   3. My Events / standalone events page (facebook.com/events)
 *      - Cards in data-virtualized="false" wrappers
 *      - Title in <object type="nested/pressable"><a href="/events/ID/">
 *      - Date/location in nested spans
 */
async function scrapeFacebookProfile(identifier, subTab, fullUrl) {
  const isGroup = identifier.startsWith('groups/');
  const isEvent = identifier === 'events' || identifier.startsWith('events/') || subTab === 'my_events';
  let profileUrl;
  if (fullUrl) {
    profileUrl = fullUrl;
  } else if (isGroup && subTab) {
    profileUrl = `https://www.facebook.com/${identifier}/${subTab}`;
  } else {
    profileUrl = `https://www.facebook.com/${identifier}`;
  }

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
    const result = await loadAndExtract(hidden, profileUrl, identifier, { isGroup, isEvent, subTab });
    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

function loadAndExtract(win, profileUrl, identifier, { isGroup, isEvent, subTab }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading Facebook page: ${identifier}`));
    }, 60000);

    let handled = false;
    win.webContents.on('did-finish-load', async () => {
      if (handled) return;
      handled = true;

      // Facebook is JS-heavy; wait for rendering
      const waitTime = (isGroup || isEvent) ? 10000 : 8000;
      await sleep(waitTime);

      try {
        // Check for login wall
        const currentUrl = win.webContents.getURL();
        if (currentUrl.includes('/login') || currentUrl.includes('checkpoint')) {
          clearTimeout(timeout);
          reject(new Error('Facebook requires login. Please log in to Facebook first.'));
          return;
        }

        // Scroll to trigger lazy content loading
        await win.webContents.executeJavaScript('window.scrollBy(0, 600)');
        await sleep(2000);
        await win.webContents.executeJavaScript('window.scrollBy(0, 600)');
        await sleep(2000);
        await win.webContents.executeJavaScript('window.scrollBy(0, 600)');
        await sleep(2000);
        // Scroll back to top so position-based filtering works correctly
        await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
        await sleep(1000);

        // Determine page type for extraction
        const pageType = isGroup && subTab === 'events' ? 'group_events'
          : isEvent ? 'my_events'
          : 'page';

        const data = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var PAGE_TYPE = ${JSON.stringify(pageType)};

              // ── Extract page/group name ──
              var pageName = '';
              var h1 = document.querySelector('h1');
              if (h1) pageName = h1.innerText.trim();
              if (!pageName) {
                var ogTitle = document.querySelector('meta[property="og:title"]');
                if (ogTitle) pageName = ogTitle.content || '';
              }

              // ── Extract profile picture ──
              var profilePic = '';
              var profileImg = document.querySelector('image[preserveAspectRatio]')
                || document.querySelector('svg image');
              if (profileImg) {
                profilePic = profileImg.getAttribute('xlink:href') || profileImg.src || '';
              }

              // ════════════════════════════════════════════
              // TYPE 1: Facebook Page posts (e.g. EventsInCalgary)
              // Posts are inside div[aria-posinset] containers
              // ════════════════════════════════════════════
              if (PAGE_TYPE === 'page') {
                var postWrappers = document.querySelectorAll('div[aria-posinset]');
                var posts = [];
                var seen = new Set();

                for (var i = 0; i < postWrappers.length && posts.length < 15; i++) {
                  try {
                    var wrapper = postWrappers[i];
                    // Skip virtualized (off-screen) posts that have no real content
                    var inner = wrapper.querySelector('div[data-virtualized="false"]');
                    if (!inner) continue;

                    // ── Post body text ──
                    var textContent = '';
                    // Primary: [data-ad-comet-preview="message"] or [data-ad-preview="message"]
                    var msgDiv = inner.querySelector('div[data-ad-comet-preview="message"], div[data-ad-preview="message"]');
                    if (msgDiv) {
                      textContent = msgDiv.innerText.trim();
                    }
                    // Fallback: div[dir="auto"][style*="text-align"] inside the post
                    if (!textContent) {
                      var dirAutos = inner.querySelectorAll('div[dir="auto"]');
                      for (var d = 0; d < dirAutos.length; d++) {
                        var txt = dirAutos[d].innerText.trim();
                        if (txt.length > 15 && txt.length > textContent.length) {
                          textContent = txt;
                        }
                      }
                    }
                    if (!textContent || textContent.length < 5) continue;

                    // Dedup
                    var key = textContent.substring(0, 80);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // ── Author name ──
                    var authorName = '';
                    var profileNameEl = inner.querySelector('[data-ad-rendering-role="profile_name"]');
                    if (profileNameEl) {
                      var h2 = profileNameEl.querySelector('h2');
                      if (h2) authorName = h2.innerText.trim();
                    }

                    // ── Image ──
                    var imageUrl = '';
                    var imgs = inner.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]');
                    for (var im = 0; im < imgs.length; im++) {
                      var src = imgs[im].src || '';
                      // Skip profile pic thumbnails (small SVG mask images)
                      if (src.includes('_s120x120') || src.includes('_s74x74')) continue;
                      var w = imgs[im].width || imgs[im].naturalWidth || 0;
                      if (w > 80 || src.includes('/p') || src.includes('s960x960')) {
                        imageUrl = src;
                        break;
                      }
                    }

                    // ── Permalink ──
                    var permalink = '';
                    var photoLink = inner.querySelector('a[href*="/photo/"], a[href*="/photos/"], a[href*="/videos/"]');
                    if (photoLink) permalink = photoLink.href;
                    if (!permalink) {
                      var postLinks = inner.querySelectorAll('a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink"]');
                      if (postLinks.length > 0) permalink = postLinks[0].href;
                    }

                    // ── Timestamp ── (Facebook obfuscates these; best-effort)
                    var timestamp = null;
                    // Look for relative time text in the header area
                    var headerSpans = inner.querySelectorAll('span[class] > a[role="link"] span');
                    for (var hs = 0; hs < headerSpans.length; hs++) {
                      var hsTxt = headerSpans[hs].innerText.trim();
                      var relMs = parseRelativeTime(hsTxt);
                      if (relMs !== null) {
                        timestamp = Date.now() - relMs;
                        break;
                      }
                    }
                    if (!timestamp) {
                      timestamp = Date.now() - (posts.length * 3600000);
                    }

                    // ── Engagement counts ──
                    var likes = 0, comments = 0;
                    var engagementBtns = inner.querySelectorAll('div[role="button"] span[class]');
                    for (var eb = 0; eb < engagementBtns.length; eb++) {
                      var eTxt = engagementBtns[eb].innerText.trim();
                      var cMatch = eTxt.match(/(\\d+)\\s*comment/i);
                      if (cMatch) { comments = parseInt(cMatch[1]); continue; }
                      var sMatch = eTxt.match(/(\\d+)\\s*share/i);
                      if (sMatch) continue; // skip shares
                    }

                    var isVideo = inner.querySelector('video') !== null;

                    posts.push({
                      id: permalink || ('fb-page-' + i + '-' + Date.now()),
                      shortcode: permalink ? permalink.split('/').filter(Boolean).pop() : '',
                      caption: textContent,
                      timestamp: new Date(timestamp).toISOString(),
                      imageUrl: imageUrl,
                      isVideo: isVideo,
                      videoUrl: isVideo ? (inner.querySelector('video') || {}).src || '' : '',
                      likes: likes,
                      comments: comments,
                      permalink: permalink || ${JSON.stringify(profileUrl)},
                      author: authorName,
                    });
                  } catch(e) {}
                }

                return {
                  username: ${JSON.stringify(identifier)},
                  fullName: pageName || ${JSON.stringify(identifier)},
                  biography: '',
                  profilePicUrl: profilePic,
                  posts: posts,
                };
              }

              // ════════════════════════════════════════════
              // TYPE 2: Group Events page
              // Sections separated by h2 "Upcoming events" / "Past events"
              // Event cards: <a aria-label="EventName" href="/events/ID/...">
              // ════════════════════════════════════════════
              if (PAGE_TYPE === 'group_events') {
                // Find the "Upcoming events" and "Past events" h2 headings
                var allH2 = document.querySelectorAll('h2');
                var upcomingH2 = null;
                var pastH2 = null;
                for (var hi = 0; hi < allH2.length; hi++) {
                  var hText = allH2[hi].innerText.trim().toLowerCase();
                  if (hText === 'upcoming events') upcomingH2 = allH2[hi];
                  if (hText === 'past events') pastH2 = allH2[hi];
                }

                // Position-based filtering: keep only event links between the two headings
                var upcomingTop = upcomingH2 ? upcomingH2.getBoundingClientRect().top : -Infinity;
                var pastEventsTop = pastH2 ? pastH2.getBoundingClientRect().top : Infinity;
                var eventLinks = document.querySelectorAll('a[href*="/events/"]');

                var events = [];
                var seenEvents = new Set();

                for (var ei = 0; ei < eventLinks.length; ei++) {
                  try {
                    var a = eventLinks[ei];
                    var href = a.href || '';
                    var evMatch = href.match(/facebook\\.com\\/events\\/(\\d+)/);
                    if (!evMatch) continue;
                    var eventId = evMatch[1];
                    if (seenEvents.has(eventId)) continue;

                    // Skip links outside the "Upcoming events" section
                    var linkTop = a.getBoundingClientRect().top;
                    if (linkTop < upcomingTop) continue;
                    if (linkTop >= pastEventsTop) continue;

                    // Skip "Create event" and navigation links
                    if (href.includes('/create')) continue;

                    seenEvents.add(eventId);

                    // Event name from aria-label or link text
                    var eventName = a.getAttribute('aria-label') || a.innerText.trim() || 'Event ' + eventId;
                    // Clean up: if name is very long, it's probably the whole card text
                    if (eventName.length > 150) {
                      var nameLines = eventName.split('\\n');
                      eventName = nameLines[0].trim();
                    }

                    // Walk up to the card container to get date and other info
                    var card = a;
                    for (var up = 0; up < 8; up++) {
                      if (card.parentElement) card = card.parentElement;
                      // Stop when we hit a container that has the full card width
                      if (card.offsetWidth > 300 && card.querySelectorAll('a[href*="/events/"]').length <= 3) break;
                    }

                    // Extract date — look for text matching day/date patterns
                    var eventDate = '';
                    var allSpans = card.querySelectorAll('span');
                    for (var si = 0; si < allSpans.length; si++) {
                      var spanText = allSpans[si].innerText.trim();
                      if (spanText.length > 3 && spanText.length < 60 &&
                          spanText.match(/(this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i) &&
                          spanText.match(/\\d|at|pm|am/i)) {
                        eventDate = spanText;
                        break;
                      }
                    }

                    // Extract "Shared by" info
                    var sharedBy = '';
                    var sharedSpans = card.querySelectorAll('span');
                    for (var sbi = 0; sbi < sharedSpans.length; sbi++) {
                      var sbText = sharedSpans[sbi].innerText.trim();
                      if (sbText.startsWith('Shared by ')) {
                        sharedBy = sbText;
                        break;
                      }
                    }

                    // Extract image (background-image on a div, or img tag)
                    var img = '';
                    var bgDiv = card.querySelector('div[style*="background-image"]');
                    if (bgDiv) {
                      var bgMatch = bgDiv.style.backgroundImage.match(/url\\("?([^"]+)"?\\)/);
                      if (bgMatch) img = bgMatch[1];
                    }
                    if (!img) {
                      var imgEl = card.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
                      if (imgEl) img = imgEl.src || '';
                    }

                    // Build caption
                    var caption = eventName;
                    if (eventDate) caption += ' \\u2014 ' + eventDate;
                    if (sharedBy) caption += ' (' + sharedBy + ')';

                    // Parse date for timestamp
                    var timestamp = null;
                    if (eventDate) {
                      var parsed = Date.parse(eventDate);
                      if (!isNaN(parsed)) timestamp = parsed;
                    }
                    if (!timestamp) timestamp = Date.now() - (events.length * 86400000);

                    events.push({
                      id: 'fb-event-' + eventId,
                      shortcode: eventId,
                      caption: caption,
                      timestamp: new Date(timestamp).toISOString(),
                      imageUrl: img,
                      isVideo: false,
                      videoUrl: '',
                      likes: 0,
                      comments: 0,
                      permalink: 'https://www.facebook.com/events/' + eventId,
                      author: sharedBy.replace('Shared by ', ''),
                    });
                  } catch(e) {}
                }

                return {
                  username: ${JSON.stringify(identifier)},
                  fullName: pageName || ${JSON.stringify(identifier)},
                  biography: 'Group Events (Upcoming)',
                  profilePicUrl: profilePic,
                  posts: events.slice(0, 15),
                };
              }

              // ════════════════════════════════════════════
              // TYPE 3: My Events / standalone events page
              // Cards with <object type="nested/pressable"><a href="/events/ID/">
              // Also works for facebook.com/events bookmark page
              // ════════════════════════════════════════════
              if (PAGE_TYPE === 'my_events') {
                // Find event cards via the nested/pressable pattern or direct links
                var eventAnchors = document.querySelectorAll('object[type="nested/pressable"] a[href*="/events/"]');
                // Fallback: any link to /events/ID
                if (eventAnchors.length === 0) {
                  eventAnchors = document.querySelectorAll('a[href*="/events/"][role="link"]');
                }

                var events = [];
                var seenEvents = new Set();

                for (var mi = 0; mi < eventAnchors.length; mi++) {
                  try {
                    var a = eventAnchors[mi];
                    var href = a.href || '';
                    var evMatch = href.match(/\\/events\\/(\\d+)/);
                    if (!evMatch) continue;
                    var eventId = evMatch[1];
                    if (seenEvents.has(eventId)) continue;
                    if (href.includes('/create')) continue;
                    seenEvents.add(eventId);

                    // Event title is the link text itself
                    var eventName = a.innerText.trim() || 'Event ' + eventId;

                    // Walk up to the card root
                    var card = a;
                    for (var up = 0; up < 12; up++) {
                      if (card.parentElement) card = card.parentElement;
                      if (card.querySelector('img') && card.offsetWidth > 250) break;
                    }

                    // Extract date — spans with date-like text
                    var eventDate = '';
                    var eventLocation = '';
                    var allSpans = card.querySelectorAll('span');
                    for (var si = 0; si < allSpans.length; si++) {
                      var spanText = allSpans[si].innerText.trim();
                      if (!eventDate && spanText.length > 5 && spanText.length < 60 &&
                          spanText.match(/(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow)/i) &&
                          spanText.match(/\\d/)) {
                        eventDate = spanText;
                        continue;
                      }
                      // Location: text that isn't the title, date, or engagement
                      if (!eventLocation && spanText.length > 2 && spanText.length < 80 &&
                          spanText !== eventName && spanText !== eventDate &&
                          !spanText.match(/interested|going|invite|share|more/i) &&
                          !spanText.match(/^\\d+ interested/)) {
                        // Check if it looks like a location
                        if (allSpans[si].closest('div[class*="xu06os2"]')) {
                          eventLocation = spanText;
                        }
                      }
                    }

                    // Interest/going counts
                    var interestText = '';
                    for (var it = 0; it < allSpans.length; it++) {
                      var itTxt = allSpans[it].innerText.trim();
                      if (itTxt.match(/\\d+\\s*interested/i)) {
                        interestText = itTxt;
                        break;
                      }
                    }

                    // Image
                    var img = '';
                    var imgEl = card.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
                    if (imgEl) img = imgEl.src || '';

                    // Build caption
                    var caption = eventName;
                    if (eventDate) caption += ' \\u2014 ' + eventDate;
                    if (eventLocation) caption += ' @ ' + eventLocation;
                    if (interestText) caption += ' (' + interestText + ')';

                    // Timestamp
                    var timestamp = null;
                    if (eventDate) {
                      var parsed = Date.parse(eventDate);
                      if (!isNaN(parsed)) timestamp = parsed;
                    }
                    if (!timestamp) timestamp = Date.now() - (events.length * 86400000);

                    events.push({
                      id: 'fb-event-' + eventId,
                      shortcode: eventId,
                      caption: caption,
                      timestamp: new Date(timestamp).toISOString(),
                      imageUrl: img,
                      isVideo: false,
                      videoUrl: '',
                      likes: 0,
                      comments: 0,
                      permalink: 'https://www.facebook.com/events/' + eventId,
                      author: '',
                    });
                  } catch(e) {}
                }

                return {
                  username: ${JSON.stringify(identifier)},
                  fullName: pageName || ${JSON.stringify(identifier)},
                  biography: 'Events',
                  profilePicUrl: profilePic,
                  posts: events.slice(0, 15),
                };
              }

              // Should not reach here, but safety net
              return {
                username: ${JSON.stringify(identifier)},
                fullName: pageName || ${JSON.stringify(identifier)},
                biography: '',
                profilePicUrl: profilePic,
                posts: [],
              };

            } catch(e) {
              return {
                username: ${JSON.stringify(identifier)},
                fullName: ${JSON.stringify(identifier)},
                biography: '',
                profilePicUrl: '',
                posts: [],
                error: e.message,
              };
            }

            function parseRelativeTime(str) {
              if (!str) return null;
              str = str.toLowerCase().trim();
              if (str === 'just now' || str === 'now') return 0;
              var match = str.match(/^(\\d+)\\s*(s|m|h|d|w|min|hr|sec|hour|day|week|minute|second)/);
              if (!match) return null;
              var n = parseInt(match[1]);
              var unit = match[2];
              if (unit.startsWith('s')) return n * 1000;
              if (unit.startsWith('min') || unit === 'm') return n * 60000;
              if (unit.startsWith('h')) return n * 3600000;
              if (unit.startsWith('d')) return n * 86400000;
              if (unit.startsWith('w')) return n * 604800000;
              return null;
            }
          })();
        `);

        clearTimeout(timeout);
        resolve(data);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to extract Facebook data: ${err.message}`));
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load Facebook page: ${desc} (${code})`));
    });

    win.loadURL(profileUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { scrapeFacebookProfile };
