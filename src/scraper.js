const { BrowserWindow } = require('electron');

/**
 * Scrape an Instagram profile using a hidden Electron BrowserWindow.
 * This loads the page in a real browser (with full JS execution and
 * authenticated session cookies), then extracts post data from the
 * rendered DOM and any embedded JSON / XHR responses.
 *
 * Much more reliable than raw HTTP requests since Instagram requires
 * full JavaScript execution to render post grids.
 */
async function scrapeInstagramProfile(username, _cookieString) {
  const profileUrl = `https://www.instagram.com/${username}/`;

  // Create a hidden browser window that shares the default session (logged-in cookies)
  const hidden = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      // Default session → picks up Instagram login cookies automatically
    },
  });

  try {
    const result = await loadAndExtract(hidden, profileUrl, username);
    return result;
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

/**
 * Navigate to the profile page, wait for it to render, then pull data out.
 */
function loadAndExtract(win, profileUrl, username) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading @${username}'s profile`));
    }, 30000);

    let handled = false;
    win.webContents.on('did-finish-load', async () => {
      if (handled) return;
      handled = true;
      // Give the SPA time to render posts (Instagram loads them async)
      await sleep(4000);

      try {
        // ── Extract all data from the fully rendered page ──
        const data = await win.webContents.executeJavaScript(`
          (function() {
            try {
              // ── Query the DOM for post links ──
              var postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
              var posts = [];
              var seen = new Set();

              postLinks.forEach(function(a) {
                var href = a.getAttribute('href');
                var match = href.match(/\\/(p|reel)\\/([A-Za-z0-9_-]+)/);
                if (!match) return;
                var shortcode = match[2];
                if (seen.has(shortcode)) return;
                seen.add(shortcode);

                var img = a.querySelector('img');
                var imgSrc = img ? img.src : '';
                var altText = img ? (img.alt || '') : '';
                // Don't treat Instagram's AI image description as post caption
                var caption = '';
                if (altText && !altText.startsWith('Photo by') && !altText.startsWith('Photo shared by') && !altText.startsWith('May be') && altText !== 'No photo description available.') {
                  caption = altText;
                }

                posts.push({
                  shortcode: shortcode,
                  imageUrl: imgSrc,
                  caption: caption,
                  type: match[1],
                });
              });

              // ── Profile info from meta tags ──
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

              // ── Search embedded JSON script tags for rich post data ──
              var embeddedPosts = [];
              try {
                var scripts = document.querySelectorAll('script[type="application/json"]');
                scripts.forEach(function(s) {
                  try {
                    var json = JSON.parse(s.textContent);
                    var str = JSON.stringify(json);
                    if (str.includes('edge_owner_to_timeline_media') ||
                        str.includes('xdt_api__v1__feed__user_timeline_graphql_connection') ||
                        str.includes('taken_at_timestamp') ||
                        str.includes('shortcode')) {
                      embeddedPosts.push(json);
                    }
                  } catch(_) {}
                });
              } catch(_) {}

              var sharedData = null;
              try { sharedData = window._sharedData; } catch(_) {}
              var additionalData = null;
              try { additionalData = window.__additionalData; } catch(_) {}

              return {
                domPosts: posts,
                embeddedPosts: embeddedPosts,
                sharedData: sharedData,
                additionalData: additionalData,
                ogTitle: ogTitle,
                ogDesc: ogDesc,
                ogImage: ogImage,
              };
            } catch(e) {
              return { error: e.message, domPosts: [], embeddedPosts: [] };
            }
          })();
        `);

        clearTimeout(timeout);

        // ── Build profile from extracted data ──
        const profileData = buildProfileData(username, data);

        // Enrich any posts that lack a timestamp, lack a real caption, or have an AI accessibility caption
        const postsToEnrich = profileData.posts.filter(
          (p) => !p.timestamp || !p.caption || isAccessibilityCaption(p.caption)
        );
        if (postsToEnrich.length > 0) {
          await enrichPostDetails(postsToEnrich.slice(0, 12));
        }

        // If still no posts, scroll down and retry once
        if (profileData.posts.length === 0) {
          await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
          await sleep(2500);

          const retryPosts = await win.webContents.executeJavaScript(`
            (function() {
              var postLinks = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
              var posts = [];
              var seen = new Set();
              postLinks.forEach(function(a) {
                var href = a.getAttribute('href');
                var match = href.match(/\\/(p|reel)\\/([A-Za-z0-9_-]+)/);
                if (!match) return;
                var shortcode = match[2];
                if (seen.has(shortcode)) return;
                seen.add(shortcode);
                var img = a.querySelector('img');
                var altText = img ? (img.alt || '') : '';
                var caption = '';
                if (altText && !altText.startsWith('Photo by') && !altText.startsWith('Photo shared by') && !altText.startsWith('May be') && altText !== 'No photo description available.') {
                  caption = altText;
                }
                posts.push({
                  shortcode: shortcode,
                  imageUrl: img ? img.src : '',
                  caption: caption,
                  type: match[1],
                });
              });
              return posts;
            })();
          `);

          if (retryPosts && retryPosts.length > 0) {
            profileData.posts = retryPosts.map((p) => ({
              id: p.shortcode,
              shortcode: p.shortcode,
              caption: p.caption || '',
              timestamp: null,
              imageUrl: p.imageUrl || '',
              isVideo: p.type === 'reel',
              videoUrl: null,
              likes: 0,
              comments: 0,
              permalink: `https://www.instagram.com/p/${p.shortcode}/`,
            }));
            await enrichPostDetails(profileData.posts.slice(0, 12));
          }
        }

        resolve(profileData);
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to extract data for @${username}: ${err.message}`));
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load @${username}'s profile: ${desc} (${code})`));
    });

    win.loadURL(profileUrl);
  });
}

/**
 * Build a unified profile data object from the various extraction results.
 */
function buildProfileData(username, data) {
  let fullName = username;
  let biography = '';
  let profilePicUrl = '';

  // Parse profile info from meta tags
  if (data.ogTitle) {
    const nameMatch = data.ogTitle.match(/^(.+?)(?:\s*\(@)/);
    fullName = nameMatch ? nameMatch[1].trim() : data.ogTitle.split('•')[0].trim();
  }
  biography = data.ogDesc || '';
  profilePicUrl = data.ogImage || '';

  // ── Try embedded JSON first (has rich data with timestamps, likes, etc.) ──
  const richPosts = extractPostsFromEmbeddedJson(data.embeddedPosts || []);
  if (richPosts.length > 0) {
    return { username, fullName, biography, profilePicUrl, posts: richPosts.slice(0, 20) };
  }

  // ── Try sharedData / additionalData ──
  const sharedPosts = extractFromSharedData(data.sharedData, data.additionalData);
  if (sharedPosts.length > 0) {
    return { username, fullName, biography, profilePicUrl, posts: sharedPosts.slice(0, 20) };
  }

  // ── Fall back to DOM-scraped post links ──
  const posts = [];
  if (data.domPosts && data.domPosts.length > 0) {
    for (const p of data.domPosts.slice(0, 20)) {
      posts.push({
        id: p.shortcode,
        shortcode: p.shortcode,
        caption: p.caption || '',
        timestamp: null, // will be enriched later
        imageUrl: p.imageUrl || '',
        isVideo: p.type === 'reel',
        videoUrl: null,
        likes: 0,
        comments: 0,
        permalink: `https://www.instagram.com/p/${p.shortcode}/`,
      });
    }
  }

  return { username, fullName, biography, profilePicUrl, posts };
}

/**
 * Deep-search the array of embedded JSON blobs for post edges.
 */
function extractPostsFromEmbeddedJson(jsonBlobs) {
  const posts = [];

  for (const blob of jsonBlobs) {
    const edges = findEdges(blob);
    for (const edge of edges) {
      const node = edge.node || edge;
      let caption =
        node.edge_media_to_caption?.edges?.[0]?.node?.text ||
        node.caption?.text ||
        (typeof node.caption === 'string' ? node.caption : '') ||
        '';
      if (isAccessibilityCaption(caption)) {
        caption = '';
      }
      const timestamp = node.taken_at_timestamp || node.taken_at;
      const shortcode = node.shortcode || node.code;
      if (!shortcode) continue;

      posts.push({
        id: node.id || node.pk || shortcode,
        shortcode,
        caption,
        timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : null,
        imageUrl:
          node.display_url ||
          node.thumbnail_src ||
          node.image_versions2?.candidates?.[0]?.url ||
          '',
        isVideo: node.is_video || node.media_type === 2,
        videoUrl: node.video_url || null,
        likes: node.edge_media_preview_like?.count || node.like_count || 0,
        comments: node.edge_media_to_comment?.count || node.comment_count || 0,
        permalink: `https://www.instagram.com/p/${shortcode}/`,
      });
    }
    if (posts.length > 0) break;
  }

  return posts;
}

/**
 * Recursively find edge arrays that look like post data.
 */
function findEdges(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== 'object') return [];

  if (obj.edge_owner_to_timeline_media?.edges) {
    return obj.edge_owner_to_timeline_media.edges;
  }
  if (obj.edges && Array.isArray(obj.edges)) {
    const first = obj.edges[0];
    if (first?.node?.shortcode || first?.node?.code) {
      return obj.edges;
    }
  }

  const keys = Array.isArray(obj) ? [...obj.keys()] : Object.keys(obj);
  for (const key of keys) {
    const result = findEdges(obj[key], depth + 1);
    if (result.length > 0) return result;
  }
  return [];
}

/**
 * Extract from legacy window._sharedData or __additionalData.
 */
function extractFromSharedData(sharedData, additionalData) {
  const sources = [additionalData, sharedData].filter(Boolean);
  for (const src of sources) {
    const edges = findEdges(src);
    if (edges.length > 0) {
      return extractPostsFromEmbeddedJson([src]);
    }
  }
  return [];
}

/**
 * Detect whether a caption string is an Instagram AI-generated accessibility description.
 */
function isAccessibilityCaption(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (/^Photo (?:by|shared by) .+ on [A-Za-z]+ \d{1,2}, \d{4}\./i.test(trimmed)) return true;
  if (/^May be (?:an? |the )?(?:image|cartoon|graphic|photo|illustration|drawing|poster|text) of /i.test(trimmed)) return true;
  if (/^No photo description available/i.test(trimmed)) return true;
  return false;
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2019;/g, '\u2019')
    .replace(/&#x2018;/g, '\u2018')
    .replace(/&#x201c;/g, '\u201c')
    .replace(/&#x201d;/g, '\u201d')
    .replace(/&#x2014;/g, '\u2014')
    .replace(/&#x2022;/g, '\u2022')
    .replace(/&#064;/g, '@')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
}

/**
 * Fetch rich post details for a single shortcode without getting blocked.
 * 1. Primary: Fetches https://www.instagram.com/p/${shortcode}/ with a crawler User-Agent
 *    (Instagram returns static OpenGraph tags: og:description, og:title, og:image).
 * 2. Fallback: Fetches https://www.instagram.com/p/${shortcode}/embed/captioned/ with a crawler UA.
 */
async function enrichSinglePost(shortcode) {
  // Method 1: OpenGraph meta tags via Facebook crawler User-Agent
  try {
    const res = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (res.ok) {
      const html = await res.text();
      const mDesc = html.match(/<meta\s+(?:property|name)=["'](?:og:)?description["']\s+content=["']([^"']*)["']/i) ||
                    html.match(/content=["']([^"']*)["']\s+(?:property|name)=["'](?:og:)?description["']/i);
      const mTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ||
                     html.match(/content=["']([^"']*)["']\s+property=["']og:title["']/i);
      const mImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i) ||
                     html.match(/content=["']([^"']*)["']\s+property=["']og:image["']/i);

      let caption = '';
      let likes = 0;
      let comments = 0;
      let postDate = null;

      if (mDesc) {
        const rawDesc = decodeHtmlEntities(mDesc[1]);
        // Pattern: "681 likes, 215 comments - whatsgoodcalgary on September 23, 2026: \"Caption text here\"."
        const parsed = rawDesc.match(/^([\d,]+)\s+likes?,\s+([\d,]+)\s+comments?\s+-\s+([^\s]+)\s+on\s+([A-Za-z]+ \d{1,2}, \d{4}):\s*(?:["“']([\s\S]*?)["”'](?:\.\s*)?)?$/);
        if (parsed) {
          likes = parseInt(parsed[1].replace(/,/g, ''), 10) || 0;
          comments = parseInt(parsed[2].replace(/,/g, ''), 10) || 0;
          postDate = parsed[4];
          if (parsed[5]) caption = parsed[5].trim();
        } else {
          const likesMatch = rawDesc.match(/([\d,]+)\s+likes?/i);
          if (likesMatch) likes = parseInt(likesMatch[1].replace(/,/g, ''), 10) || 0;
          const commentsMatch = rawDesc.match(/([\d,]+)\s+comments?/i);
          if (commentsMatch) comments = parseInt(commentsMatch[1].replace(/,/g, ''), 10) || 0;

          const quoteMatch = rawDesc.match(/:\s*["“']([\s\S]*?)["”'](?:\.\s*)?$/);
          if (quoteMatch) caption = quoteMatch[1].trim();
        }
      }

      if (!caption && mTitle) {
        const rawTitle = decodeHtmlEntities(mTitle[1]);
        const titleMatch = rawTitle.match(/Instagram:\s*["“']([\s\S]*?)["”']$/);
        if (titleMatch) caption = titleMatch[1].trim();
      }

      if (caption && !isAccessibilityCaption(caption)) {
        return {
          caption,
          likes,
          comments,
          postDate,
          imageUrl: mImage ? decodeHtmlEntities(mImage[1]) : null,
        };
      }
    }
  } catch (_) {}

  // Method 2: Embed captioned fallback via Googlebot User-Agent
  try {
    const embedRes = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (embedRes.ok) {
      const html = await embedRes.text();
      const match = html.match(/class=["']Caption["'][^>]*>([\s\S]*?)<\/div>/i);
      if (match) {
        let text = match[1];
        text = text.replace(/<a class=["']CaptionUsername["'][^>]*>[\s\S]*?<\/a>/i, '');
        text = text.replace(/<div class=["']CaptionComments["'][\s\S]*$/i, '');
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        const caption = decodeHtmlEntities(text).trim();

        let likes = 0;
        const likesMatch = html.match(/>([\d,]+)\s+likes<\/a>/i);
        if (likesMatch) likes = parseInt(likesMatch[1].replace(/,/g, ''), 10) || 0;

        let comments = 0;
        const commentsMatch = html.match(/View all ([\d,]+) comments<\/a>/i);
        if (commentsMatch) comments = parseInt(commentsMatch[1].replace(/,/g, ''), 10) || 0;

        if (caption && !isAccessibilityCaption(caption)) {
          return { caption, likes, comments, postDate: null, imageUrl: null };
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Enrich posts missing real captions or timestamps by fetching their individual post pages.
 */
async function enrichPostDetails(posts) {
  for (const post of posts) {
    if (post.timestamp && post.caption && !isAccessibilityCaption(post.caption)) {
      continue; // already enriched with real caption and timestamp
    }

    try {
      const detail = await enrichSinglePost(post.shortcode);
      if (detail) {
        if (detail.caption && !isAccessibilityCaption(detail.caption)) {
          post.caption = detail.caption;
        }
        if (detail.likes !== undefined && detail.likes > 0) post.likes = detail.likes;
        if (detail.comments !== undefined && detail.comments > 0) post.comments = detail.comments;
        if (detail.imageUrl && !post.imageUrl) post.imageUrl = detail.imageUrl;
        if (detail.postDate && !post.timestamp) {
          const parsedDate = new Date(detail.postDate);
          if (!isNaN(parsedDate.getTime())) {
            post.timestamp = parsedDate.toISOString();
          }
        }
      }

      // Brief delay to be polite to the server
      await sleep(250);
    } catch (_) {
      // Continue to next post
    }
  }

  // Assign fallback timestamps for any posts still without one
  const now = Date.now();
  for (let i = 0; i < posts.length; i++) {
    if (!posts[i].timestamp) {
      posts[i].timestamp = new Date(now - i * 3600000).toISOString();
      posts[i].timestampEstimated = true;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scrapeInstagramProfile, isAccessibilityCaption, enrichPostDetails, enrichSinglePost };
