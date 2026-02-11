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

    win.webContents.on('did-finish-load', async () => {
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

                posts.push({
                  shortcode: shortcode,
                  imageUrl: imgSrc,
                  caption: altText,
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

        // If we found posts from the DOM but they have no timestamps,
        // fetch each post's individual page via XHR to get full details
        if (profileData.posts.length > 0 && !profileData.posts[0].timestamp) {
          await enrichPostDetails(win, profileData.posts.slice(0, 12));
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
                posts.push({
                  shortcode: shortcode,
                  imageUrl: img ? img.src : '',
                  caption: img ? (img.alt || '') : '',
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
            await enrichPostDetails(win, profileData.posts.slice(0, 12));
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
      const caption =
        node.edge_media_to_caption?.edges?.[0]?.node?.text ||
        node.caption?.text ||
        node.accessibility_caption ||
        '';
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
 * For posts where we only have shortcodes (from DOM scraping), visit each
 * post's individual page via XHR to get timestamp, caption, likes, etc.
 * This runs inside the hidden browser so it uses the authenticated session.
 */
async function enrichPostDetails(win, posts) {
  for (const post of posts) {
    if (post.timestamp && post.caption) continue; // already enriched

    try {
      const detail = await win.webContents.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'https://www.instagram.com/p/${post.shortcode}/?__a=1&__d=dis', true);
            xhr.setRequestHeader('X-IG-App-ID', '936619743392459');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.onload = function() {
              try {
                var data = JSON.parse(xhr.responseText);
                var item = data.items ? data.items[0] : (data.graphql ? data.graphql.shortcode_media : null);
                if (item) {
                  resolve({
                    caption: (item.caption ? item.caption.text : '') ||
                             (item.edge_media_to_caption && item.edge_media_to_caption.edges[0] ? item.edge_media_to_caption.edges[0].node.text : ''),
                    timestamp: item.taken_at_timestamp || item.taken_at || null,
                    likes: item.like_count || (item.edge_media_preview_like ? item.edge_media_preview_like.count : 0),
                    comments: item.comment_count || (item.edge_media_to_comment ? item.edge_media_to_comment.count : 0),
                    imageUrl: item.display_url || (item.image_versions2 && item.image_versions2.candidates[0] ? item.image_versions2.candidates[0].url : ''),
                    isVideo: item.is_video || item.media_type === 2,
                    videoUrl: item.video_url || null,
                  });
                } else { resolve(null); }
              } catch(_) { resolve(null); }
            };
            xhr.onerror = function() { resolve(null); };
            xhr.send();
          });
        })();
      `);

      if (detail) {
        if (detail.caption) post.caption = detail.caption;
        if (detail.timestamp) {
          post.timestamp = new Date(detail.timestamp * 1000).toISOString();
        }
        if (detail.likes) post.likes = detail.likes;
        if (detail.comments) post.comments = detail.comments;
        if (detail.imageUrl) post.imageUrl = detail.imageUrl;
        if (detail.isVideo !== undefined) post.isVideo = detail.isVideo;
        if (detail.videoUrl) post.videoUrl = detail.videoUrl;
      }

      // Small delay to avoid rate-limiting
      await sleep(500);
    } catch (_) {
      // Skip enrichment for this post silently
    }
  }

  // Assign fallback timestamps for any posts still without one
  const now = Date.now();
  for (let i = 0; i < posts.length; i++) {
    if (!posts[i].timestamp) {
      posts[i].timestamp = new Date(now - i * 3600000).toISOString();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scrapeInstagramProfile };
