const { BrowserWindow, session } = require('electron');
const path = require('path');

/**
 * Custom Website Scraper
 *
 * Two modes:
 *   1) Interactive wizard — opens a visible browser window so the user can
 *      log in, navigate to a page, and visually select repeating items.
 *   2) Headless refresh — re-scrapes a page using a previously saved CSS
 *      selector (for auto-refresh / manual refresh).
 */

// ── Interactive Wizard ─────────────────────────────────────────────────────

/**
 * Open the Custom Website Wizard.
 * @param {string} siteUrl – The URL the user entered
 * @param {BrowserWindow} parentWindow – The main app window
 * @returns {Promise<{pageUrl, selector, feedName, profileData}>}
 */
function startCustomWizard(siteUrl, parentWindow) {
  return new Promise((resolve, reject) => {
    // Normalise URL
    if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;

    let origin;
    try {
      const u = new URL(siteUrl);
      origin = u.origin;
    } catch (_) {
      origin = siteUrl;
    }

    const wizardWin = new BrowserWindow({
      width: 1280,
      height: 900,
      parent: parentWindow,
      title: 'UnSocial — Custom Feed Wizard',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-custom.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    wizardWin.setMenuBarVisibility(false);

    // ── State machine ────────────────────────────────────────────────────
    let step = 'login';   // login → navigate → select → done
    let targetUrl = siteUrl;
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(result);
      if (!wizardWin.isDestroyed()) wizardWin.destroy();
    };

    // ── Re-inject toolbar whenever a page finishes loading ──────────────
    wizardWin.webContents.on('did-finish-load', () => {
      // After a navigation-loading completes, transition to navigate (with Select Items button)
      if (step === 'navigate-loading') step = 'navigate';
      // Update targetUrl to reflect where the browser actually ended up
      if (step === 'navigate' || step === 'select') {
        const currentUrl = wizardWin.webContents.getURL();
        if (currentUrl && !currentUrl.startsWith('about:')) targetUrl = currentUrl;
      }
      injectToolbar(wizardWin, step, targetUrl).catch(() => {});
    });

    // ── Messages from injected JS (via preload bridge) ──────────────────
    wizardWin.webContents.on('ipc-message', (_event, channel, subChannel, data) => {
      if (channel !== 'custom-wizard-msg') return;

      switch (subChannel) {
        case 'login-done':
          step = 'navigate';
          injectToolbar(wizardWin, step, targetUrl).catch(() => {});
          break;

        case 'navigate-to': {
          targetUrl = data;
          step = 'navigate-loading';
          wizardWin.loadURL(data);
          break;
        }

        case 'start-selector':
          step = 'select';
          injectSelector(wizardWin).catch(() => {});
          break;

        case 'confirm-items': {
          // data = { selector, items: [...], feedName }
          // Transition to scroll step so user can optionally configure scrolling
          step = 'scroll';
          // Stash the selection data for after the scroll step
          wizardWin.__unsocialSelectionData = data;
          injectScrollStep(wizardWin, targetUrl).catch(() => {});
          break;
        }

        case 'finish-scroll': {
          // data = { scrollSelector, scrollCount }
          step = 'done';
          const selData = wizardWin.__unsocialSelectionData || {};
          const scrollSelector = (data && data.scrollSelector) || null;
          const scrollCount = (data && data.scrollCount) || 0;
          const profileData = buildProfileData(selData.items, selData.feedName, targetUrl);
          finish(null, {
            pageUrl: targetUrl,
            selector: selData.selector,
            feedName: selData.feedName || deriveFeedName(targetUrl),
            scrollSelector,
            scrollCount,
            profileData,
          });
          break;
        }

        case 'cancel':
          finish(new Error('Custom feed wizard was cancelled'));
          break;
      }
    });

    wizardWin.on('closed', () => {
      finish(new Error('Custom feed wizard was closed'));
    });

    // Spoof a real Chrome user agent to avoid bot-detection blocks
    const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    wizardWin.webContents.session.setUserAgent(chromeUA);
    wizardWin.webContents.setUserAgent(chromeUA);

    // Load the site (user will log in here)
    wizardWin.loadURL(origin);
  });
}

// ── Headless Refresh ───────────────────────────────────────────────────────

/**
 * Re-scrape a custom website using a saved CSS selector.
 * Runs in a hidden window, sharing the default session (login cookies).
 * @param {string} pageUrl – The page to load
 * @param {string} selector – CSS selector for repeating items
 * @param {string} feedName – Feed display name
 * @param {string|null} scrollSelector – CSS selector of the scrollable container (null = window)
 * @param {number} scrollCount – Number of scroll-down actions to perform before extracting
 * @returns {Promise<{fullName, biography, posts[]}>}
 */
async function scrapeCustomSiteHeadless(pageUrl, selector, feedName, scrollSelector, scrollCount) {
  const hidden = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  // Spoof user agent
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  hidden.webContents.session.setUserAgent(chromeUA);
  hidden.webContents.setUserAgent(chromeUA);

  try {
    await loadPage(hidden, pageUrl);
    // Wait for dynamic content to render
    await sleep(4000);

    // Perform scrolling if configured
    const numScrolls = parseInt(scrollCount, 10) || 0;
    if (numScrolls > 0) {
      for (let i = 0; i < numScrolls; i++) {
        await hidden.webContents.executeJavaScript(`
          (function() {
            var scrollSel = ${JSON.stringify(scrollSelector || null)};
            var target = scrollSel ? document.querySelector(scrollSel) : null;
            if (target) {
              target.scrollBy({ top: target.clientHeight || 800, behavior: 'smooth' });
            } else {
              window.scrollBy({ top: window.innerHeight || 800, behavior: 'smooth' });
            }
          })();
        `);
        // Wait between scrolls for lazy-loaded content to appear
        await sleep(2000);
      }
      // Extra wait after all scrolls for final content to render
      await sleep(2000);
    }

    const items = await hidden.webContents.executeJavaScript(`
      (function() {
        var els = document.querySelectorAll(${JSON.stringify(selector)});
        var items = [];
        els.forEach(function(el, i) {
          ${EXTRACT_ITEM_JS}
          items.push(item);
        });
        return items;
      })();
    `);

    return buildProfileData(items, feedName, pageUrl);
  } finally {
    if (!hidden.isDestroyed()) hidden.destroy();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadPage(win, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out loading page')), 30000);

    win.webContents.on('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to load page: ${desc} (${code})`));
    });
    win.loadURL(url);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function deriveFeedName(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch (_) {
    return 'custom-feed';
  }
}

function buildProfileData(items, feedName, pageUrl) {
  const posts = (items || []).map((item, i) => ({
    id: item.link || `${pageUrl}#item-${i}`,
    shortcode: `item-${i}`,
    caption: item.title || item.text || '(no title)',
    timestamp: (function() {
      if (!item.date) return new Date().toISOString();
      // Strip IANA timezone annotations like [America/Edmonton]
      var cleaned = item.date.replace(/\[.*?\]/g, '').trim();
      var d = new Date(cleaned);
      return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })(),
    timestampEstimated: !item.date,
    imageUrl: item.image || '',
    isVideo: false,
    videoUrl: null,
    likes: 0,
    comments: 0,
    permalink: item.link || pageUrl,
  }));

  return {
    fullName: feedName || deriveFeedName(pageUrl),
    biography: `Custom feed from ${pageUrl}`,
    posts,
  };
}

// ── Extraction JS (shared between interactive + headless) ──────────────────

const EXTRACT_ITEM_JS = `
  // Extract meaningful content from a single list-item element
  var item = { title: '', text: '', link: '', image: '', date: '' };

  // Link: first <a> with a real href
  var aTag = el.querySelector('a[href]');
  if (aTag) {
    var href = aTag.href;
    if (href && !href.startsWith('javascript:')) item.link = href;
  }

  // Title: first heading, or first <a> text, or first bold text
  var heading = el.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    item.title = heading.innerText.trim();
  } else if (aTag) {
    item.title = aTag.innerText.trim();
  } else {
    var bold = el.querySelector('b, strong');
    if (bold) item.title = bold.innerText.trim();
  }

  // Image: first <img>
  var img = el.querySelector('img[src]');
  if (img) item.image = img.src;

  // Date: <time> element or text matching date patterns
  var timeEl = el.querySelector('time[datetime]');
  if (timeEl) {
    item.date = timeEl.getAttribute('datetime');
  } else {
    var timeEl2 = el.querySelector('time');
    if (timeEl2) item.date = timeEl2.innerText.trim();
  }

  // Text: all remaining visible text (truncated)
  var fullText = el.innerText.trim();
  if (fullText.length > 0 && fullText !== item.title) {
    item.text = fullText.substring(0, 500);
  }
`;

// ── Toolbar & Selector Injection ───────────────────────────────────────────

async function injectToolbar(win, step, targetUrl) {
  if (win.isDestroyed()) return;

  const js = `
    (function() {
      // Remove previous toolbar
      var old = document.getElementById('__unsocial_toolbar');
      if (old) old.remove();

      var bar = document.createElement('div');
      bar.id = '__unsocial_toolbar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.5);';

      // Push page content down
      if (!document.getElementById('__unsocial_spacer')) {
        var spacer = document.createElement('div');
        spacer.id = '__unsocial_spacer';
        spacer.style.cssText = 'height:52px;';
        document.body.prepend(spacer);
      }

      var step = ${JSON.stringify(step)};
      var targetUrl = ${JSON.stringify(targetUrl)};

      if (step === 'login') {
        bar.innerHTML =
          '<span style="flex:1;">🔐 <b>Step 1:</b> Log in to this website, then click <b>Continue</b></span>' +
          '<button id="__us_btn_continue" style="background:#e1306c;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Continue →</button>' +
          '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

        bar.querySelector('#__us_btn_continue').onclick = function() {
          window.unsocial.send('login-done');
        };
        bar.querySelector('#__us_btn_cancel').onclick = function() {
          window.unsocial.send('cancel');
        };
      }

      else if (step === 'navigate') {
        bar.innerHTML =
          '<span>📍 <b>Step 2:</b> Navigate to the page with items</span>' +
          '<input id="__us_url_input" type="text" value="' + targetUrl.replace(/"/g, '&quot;') + '" style="flex:1;background:#111;color:#fff;border:1px solid #444;padding:8px 12px;border-radius:6px;font-size:13px;font-family:monospace;" />' +
          '<button id="__us_btn_go" style="background:#e1306c;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Go</button>' +
          '<button id="__us_btn_select" style="background:#4ade80;color:#111;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Select Items ✦</button>' +
          '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

        bar.querySelector('#__us_btn_go').onclick = function() {
          var url = bar.querySelector('#__us_url_input').value.trim();
          if (url) window.unsocial.send('navigate-to', url);
        };
        bar.querySelector('#__us_url_input').addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            var url = this.value.trim();
            if (url) window.unsocial.send('navigate-to', url);
          }
        });
        bar.querySelector('#__us_btn_select').onclick = function() {
          window.unsocial.send('start-selector');
        };
        bar.querySelector('#__us_btn_cancel').onclick = function() {
          window.unsocial.send('cancel');
        };
      }

      else if (step === 'navigate-loading') {
        bar.innerHTML =
          '<span style="flex:1;">⏳ Loading page…</span>' +
          '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';
        bar.querySelector('#__us_btn_cancel').onclick = function() {
          window.unsocial.send('cancel');
        };
      }

      document.body.appendChild(bar);
    })();
  `;

  try {
    await win.webContents.executeJavaScript(js);
  } catch (_) {}
}

async function injectSelector(win) {
  if (win.isDestroyed()) return;

  const js = `
    (function() {
      // ── Remove toolbar, replace with selector toolbar ──
      var old = document.getElementById('__unsocial_toolbar');
      if (old) old.remove();

      var bar = document.createElement('div');
      bar.id = '__unsocial_toolbar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.5);';

      bar.innerHTML =
        '<span id="__us_instructions" style="flex:1;">🎯 <b>Step 3:</b> Hover over items and click on <b>one repeating item</b> (e.g. one post, one article, one card)</span>' +
        '<span id="__us_count" style="display:none;flex:1;color:#4ade80;font-weight:600;">✓ Found <b id="__us_num">0</b> similar items</span>' +
        '<input id="__us_name_input" type="text" placeholder="Feed name (optional)" style="display:none;background:#111;color:#fff;border:1px solid #444;padding:8px 12px;border-radius:6px;font-size:13px;width:200px;" />' +
        '<button id="__us_btn_confirm" style="display:none;background:#4ade80;color:#111;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Create Feed</button>' +
        '<button id="__us_btn_reset" style="display:none;background:#f59e0b;color:#111;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">↺ Reset</button>' +
        '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

      document.body.appendChild(bar);

      // ── Hover highlight ──
      var hoverOverlay = document.createElement('div');
      hoverOverlay.id = '__unsocial_hover';
      hoverOverlay.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;border:2px solid #e1306c;background:rgba(225,48,108,0.08);border-radius:4px;transition:all 0.1s ease;display:none;';
      document.body.appendChild(hoverOverlay);

      var selectedSelector = null;
      var selectedEls = [];
      var selectorMode = true;

      // Compute a best-effort CSS selector for an element's "repeating container"
      function findRepeatingContainer(el) {
        var current = el;
        var maxDepth = 15;
        var depth = 0;
        var bestResult = null;

        while (current && current !== document.body && current !== document.documentElement && depth < maxDepth) {
          var parent = current.parentElement;
          if (!parent) break;

          var tag = current.tagName;
          var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === tag; });

          if (siblings.length >= 2) {
            // Strategy 1: data attributes shared among siblings (React, Next.js, etc.)
            var dataAttrs = ['data-testid', 'data-element-name', 'data-type', 'role', 'data-qa', 'data-id'];
            for (var ai = 0; ai < dataAttrs.length; ai++) {
              var attr = dataAttrs[ai];
              var attrVal = current.getAttribute(attr);
              if (attrVal) {
                var siblingsWithAttr = siblings.filter(function(s) { return s.getAttribute(attr) === attrVal; });
                if (siblingsWithAttr.length >= 2) {
                  var sel = tag.toLowerCase() + '[' + attr + '="' + attrVal.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]';
                  try {
                    var matches = document.querySelectorAll(sel);
                    if (matches.length >= 2 && matches.length <= 500) {
                      return { container: current, selector: sel, count: matches.length };
                    }
                  } catch(e) { /* invalid selector, skip */ }
                }
              }
            }

            // Strategy 2: shared CSS classes — filter out Tailwind state/responsive prefixes & escape
            var currentClasses = Array.from(current.classList);
            var stableClasses = currentClasses.filter(function(cls) {
              return !/^(hover:|active:|focus:|focus-within:|group-hover:|group-focus:|disabled:|visited:|checked:|open:|sm:|md:|lg:|xl:|2xl:|xs:|dark:|motion-|aria-|data-\\[)/.test(cls);
            });

            if (stableClasses.length > 0) {
              var sharedClasses = stableClasses.filter(function(cls) {
                var count = siblings.filter(function(s) { return s.classList.contains(cls); }).length;
                return count >= Math.max(2, siblings.length * 0.5);
              });

              if (sharedClasses.length > 0) {
                // Build selector with CSS.escape for each class
                var sel = tag.toLowerCase() + '.' + sharedClasses.map(function(c) { return CSS.escape(c); }).join('.');
                try {
                  var matches = document.querySelectorAll(sel);
                  if (matches.length >= 2 && matches.length <= 500) {
                    // Prefer results closer to the content (shallower = better containers)
                    if (!bestResult || matches.length <= bestResult.count) {
                      bestResult = { container: current, selector: sel, count: matches.length };
                    }
                    // If this looks like a good card-level container (has image + text), return it
                    if (current.querySelector('img') && current.querySelector('a[href]')) {
                      return bestResult;
                    }
                  }
                  // Too many matches — try scoping with parent
                  if (matches.length > 500) {
                    var parentSel = getSimpleSelector(parent);
                    if (parentSel) {
                      var scopedSel = parentSel + ' > ' + sel;
                      try {
                        var scopedMatches = document.querySelectorAll(scopedSel);
                        if (scopedMatches.length >= 2 && scopedMatches.length <= 500) {
                          return { container: current, selector: scopedSel, count: scopedMatches.length };
                        }
                      } catch(e2) {}
                    }
                  }
                } catch(e) { /* invalid selector, skip */ }
              }
            }

            // Strategy 3: parent > tag (direct child)
            var parentSel = getSimpleSelector(parent);
            if (parentSel) {
              var sel = parentSel + ' > ' + tag.toLowerCase();
              try {
                var matches = document.querySelectorAll(sel);
                if (matches.length >= 2 && matches.length <= 500) {
                  if (!bestResult || matches.length <= bestResult.count) {
                    bestResult = { container: current, selector: sel, count: matches.length };
                  }
                }
              } catch(e) { /* skip */ }
            }
          }

          current = parent;
          depth++;
        }

        return bestResult;
      }

      function getSimpleSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        // Try data-testid first
        var testId = el.getAttribute('data-testid');
        if (testId) {
          var sel = el.tagName.toLowerCase() + '[data-testid="' + testId.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]';
          try { if (document.querySelectorAll(sel).length <= 3) return sel; } catch(e) {}
        }
        if (el.classList.length > 0) {
          var sel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).map(function(c) { return CSS.escape(c); }).join('.');
          try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
        }
        // Try tag with class subset
        if (el.classList.length > 0) {
          for (var i = 0; i < el.classList.length; i++) {
            var sel = el.tagName.toLowerCase() + '.' + CSS.escape(el.classList[i]);
            try { if (document.querySelectorAll(sel).length <= 3) return sel; } catch(e) {}
          }
        }
        return null;
      }

      function highlightElements(els, color) {
        els.forEach(function(el) {
          el.style.outline = '3px solid ' + color;
          el.style.outlineOffset = '-2px';
          el.dataset.__unsocialHighlight = '1';
        });
      }

      function clearHighlights() {
        document.querySelectorAll('[data-__unsocial-highlight]').forEach(function(el) {
          el.style.outline = '';
          el.style.outlineOffset = '';
          delete el.dataset.__unsocialHighlight;
        });

        // Also clear old-style highlights
        document.querySelectorAll('[data-__unsocialhighlight]').forEach(function(el) {
          el.style.outline = '';
          el.style.outlineOffset = '';
          delete el.dataset.__unsocialhighlight;
        });
      }

      // ── Mouse event handlers ──
      function onMouseMove(e) {
        if (!selectorMode) return;
        var target = e.target;

        // Ignore our own toolbar
        if (target.closest('#__unsocial_toolbar') || target.id === '__unsocial_hover' || target.id === '__unsocial_spacer') return;

        var rect = target.getBoundingClientRect();
        hoverOverlay.style.display = 'block';
        hoverOverlay.style.left = (rect.left + window.scrollX) + 'px';
        hoverOverlay.style.top = (rect.top + window.scrollY) + 'px';
        hoverOverlay.style.width = rect.width + 'px';
        hoverOverlay.style.height = rect.height + 'px';
      }

      function onMouseLeave() {
        hoverOverlay.style.display = 'none';
      }

      function onClick(e) {
        if (!selectorMode) return;

        var target = e.target;
        // Ignore our own UI
        if (target.closest('#__unsocial_toolbar') || target.id === '__unsocial_hover' || target.id === '__unsocial_spacer') return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        try {
        // Find the repeating container — walk up from the click target
        var result = findRepeatingContainer(target);
        if (!result) {
          // Try one level up
          if (target.parentElement) {
            result = findRepeatingContainer(target.parentElement);
          }
        }
        // Try two more levels up if still nothing
        if (!result && target.parentElement && target.parentElement.parentElement) {
          result = findRepeatingContainer(target.parentElement.parentElement);
        }

        if (!result) {
          alert('Could not find repeating items from this element. Try clicking on a different part of the item (e.g. the title or image).');
          return;
        }

        // Switch to confirm mode
        selectorMode = false;
        selectedSelector = result.selector;
        selectedEls = Array.from(document.querySelectorAll(result.selector));

        // Hide hover overlay
        hoverOverlay.style.display = 'none';

        // Highlight all found items
        highlightElements(selectedEls, '#4ade80');

        // Scroll the clicked item into view
        result.container.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Update toolbar
        document.getElementById('__us_instructions').style.display = 'none';
        document.getElementById('__us_count').style.display = '';
        document.getElementById('__us_num').textContent = selectedEls.length;
        document.getElementById('__us_btn_confirm').style.display = '';
        document.getElementById('__us_btn_reset').style.display = '';
        document.getElementById('__us_name_input').style.display = '';
        } catch(err) {
          console.error('[UnSocial] Selector click error:', err);
          alert('Error detecting items: ' + err.message + '. Try clicking on a different element.');
        }
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseleave', onMouseLeave, true);
      document.addEventListener('click', onClick, true);

      // ── Confirm button ──
      bar.querySelector('#__us_btn_confirm').onclick = function(e) {
        e.stopPropagation();

        // Extract data from each item
        var items = [];
        selectedEls.forEach(function(el, i) {
          ${EXTRACT_ITEM_JS}
          items.push(item);
        });

        var feedName = document.getElementById('__us_name_input').value.trim() || '';

        // Clean up
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseleave', onMouseLeave, true);
        document.removeEventListener('click', onClick, true);
        clearHighlights();

        window.unsocial.send('confirm-items', {
          selector: selectedSelector,
          items: items,
          feedName: feedName,
        });
      };

      // ── Reset button ──
      bar.querySelector('#__us_btn_reset').onclick = function(e) {
        e.stopPropagation();
        selectorMode = true;
        selectedSelector = null;
        selectedEls = [];
        clearHighlights();

        document.getElementById('__us_instructions').style.display = '';
        document.getElementById('__us_count').style.display = 'none';
        document.getElementById('__us_btn_confirm').style.display = 'none';
        document.getElementById('__us_btn_reset').style.display = 'none';
        document.getElementById('__us_name_input').style.display = 'none';
      };

      // ── Cancel button ──
      bar.querySelector('#__us_btn_cancel').onclick = function(e) {
        e.stopPropagation();
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseleave', onMouseLeave, true);
        document.removeEventListener('click', onClick, true);
        clearHighlights();
        window.unsocial.send('cancel');
      };
    })();
  `;

  try {
    await win.webContents.executeJavaScript(js);
  } catch (_) {}
}

module.exports = { startCustomWizard, scrapeCustomSiteHeadless };

// ── Scroll Step Injection ──────────────────────────────────────────────────

async function injectScrollStep(win) {
  if (win.isDestroyed()) return;

  const js = `
    (function() {
      // ── Remove old toolbar ──
      var old = document.getElementById('__unsocial_toolbar');
      if (old) old.remove();
      var oldHover = document.getElementById('__unsocial_hover');
      if (oldHover) oldHover.remove();

      // Clear any green outlines from the selector step
      document.querySelectorAll('[data-__unsocialhighlight]').forEach(function(el) {
        el.style.outline = ''; el.style.outlineOffset = ''; delete el.dataset.__unsocialhighlight;
      });
      document.querySelectorAll('[data-__unsocial-highlight]').forEach(function(el) {
        el.style.outline = ''; el.style.outlineOffset = ''; delete el.dataset.__unsocialHighlight;
      });

      var bar = document.createElement('div');
      bar.id = '__unsocial_toolbar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.5);flex-wrap:wrap;';

      bar.innerHTML =
        '<span id="__us_scroll_instructions" style="flex:1;min-width:200px;">📜 <b>Step 4:</b> Does this page need scrolling to load more items? Click the <b>scrollable area</b>, or <b>Skip</b> if not needed.</span>' +
        '<span id="__us_scroll_selected" style="display:none;color:#4ade80;font-weight:600;flex:1;min-width:200px;">✓ Scroll area selected</span>' +
        '<label style="display:flex;align-items:center;gap:6px;white-space:nowrap;"><span style="font-size:13px;">Scrolls:</span>' +
        '<input id="__us_scroll_count" type="number" min="0" max="100" value="3" style="width:60px;background:#111;color:#fff;border:1px solid #444;padding:6px 8px;border-radius:6px;font-size:13px;text-align:center;" />' +
        '</label>' +
        '<button id="__us_scroll_whole_page" style="background:#6366f1;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;" title="Scroll the whole page instead of a specific area">Whole Page</button>' +
        '<button id="__us_btn_scroll_done" style="background:#4ade80;color:#111;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Done</button>' +
        '<button id="__us_btn_scroll_skip" style="background:transparent;color:#aaa;border:1px solid #555;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Skip (no scroll)</button>' +
        '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

      document.body.appendChild(bar);

      // ── Hover overlay for scroll area selection ──
      var hoverOverlay = document.createElement('div');
      hoverOverlay.id = '__unsocial_hover';
      hoverOverlay.style.cssText = 'position:absolute;pointer-events:none;z-index:2147483646;border:2px dashed #6366f1;background:rgba(99,102,241,0.08);border-radius:4px;transition:all 0.1s ease;display:none;';
      document.body.appendChild(hoverOverlay);

      var scrollSelector = null;
      var scrollSelectMode = true;

      function getScrollableSelector(el) {
        // Walk up to find the scrollable container
        var current = el;
        var maxDepth = 8;
        var depth = 0;
        while (current && current !== document.body && current !== document.documentElement && depth < maxDepth) {
          var style = window.getComputedStyle(current);
          var overflowY = style.overflowY;
          var isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight;
          if (isScrollable) {
            // Build a selector for this element
            if (current.id) return '#' + CSS.escape(current.id);
            var testId = current.getAttribute('data-testid');
            if (testId) return current.tagName.toLowerCase() + '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]';
            if (current.classList.length > 0) {
              for (var i = 0; i < current.classList.length; i++) {
                var sel = current.tagName.toLowerCase() + '.' + CSS.escape(current.classList[i]);
                try { if (document.querySelectorAll(sel).length <= 3) return sel; } catch(e) {}
              }
            }
            // Fallback: use a generic selector with index
            var parent = current.parentElement;
            if (parent) {
              var children = Array.from(parent.children);
              var idx = children.indexOf(current);
              var parentSel = parent.id ? '#' + CSS.escape(parent.id) : null;
              if (parentSel) return parentSel + ' > ' + current.tagName.toLowerCase() + ':nth-child(' + (idx+1) + ')';
            }
            return null;
          }
          current = current.parentElement;
          depth++;
        }
        return null;
      }

      function onMouseMove(e) {
        if (!scrollSelectMode) return;
        var target = e.target;
        if (target.closest('#__unsocial_toolbar') || target.id === '__unsocial_hover' || target.id === '__unsocial_spacer') return;

        // Walk up to find a meaningful container (not tiny inline elements)
        var el = target;
        while (el && el !== document.body && el.clientHeight < 100) {
          el = el.parentElement;
        }
        if (!el || el === document.body) el = target;

        var rect = el.getBoundingClientRect();
        hoverOverlay.style.display = 'block';
        hoverOverlay.style.left = (rect.left + window.scrollX) + 'px';
        hoverOverlay.style.top = (rect.top + window.scrollY) + 'px';
        hoverOverlay.style.width = rect.width + 'px';
        hoverOverlay.style.height = rect.height + 'px';
      }

      function onMouseLeave() {
        hoverOverlay.style.display = 'none';
      }

      function onClick(e) {
        if (!scrollSelectMode) return;
        var target = e.target;
        if (target.closest('#__unsocial_toolbar') || target.id === '__unsocial_hover' || target.id === '__unsocial_spacer') return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Walk up from click target to find a scrollable container
        var sel = getScrollableSelector(target);

        if (!sel) {
          // The clicked area itself might not be scrollable, try walking up bigger
          var el = target;
          while (el && el !== document.body) {
            sel = getScrollableSelector(el);
            if (sel) break;
            el = el.parentElement;
          }
        }

        if (!sel) {
          // Fallback: use the whole page
          scrollSelector = null;
          scrollSelectMode = false;
          hoverOverlay.style.display = 'none';
          document.getElementById('__us_scroll_instructions').style.display = 'none';
          var selSpan = document.getElementById('__us_scroll_selected');
          selSpan.style.display = '';
          selSpan.innerHTML = '✓ Scroll area: <b>whole page</b> (no specific scroller found — this is fine!)';
          return;
        }

        scrollSelector = sel;
        scrollSelectMode = false;
        hoverOverlay.style.display = 'none';

        // Highlight the selected scroll container
        try {
          var scrollEl = document.querySelector(sel);
          if (scrollEl) {
            scrollEl.style.outline = '3px dashed #6366f1';
            scrollEl.style.outlineOffset = '-2px';
          }
        } catch(e) {}

        document.getElementById('__us_scroll_instructions').style.display = 'none';
        var selSpan = document.getElementById('__us_scroll_selected');
        selSpan.style.display = '';
        selSpan.innerHTML = '✓ Scroll area: <b>' + sel.substring(0, 50) + '</b>';
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseleave', onMouseLeave, true);
      document.addEventListener('click', onClick, true);

      function cleanup() {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseleave', onMouseLeave, true);
        document.removeEventListener('click', onClick, true);
        hoverOverlay.style.display = 'none';
        // Remove scroll highlight
        if (scrollSelector) {
          try {
            var scrollEl = document.querySelector(scrollSelector);
            if (scrollEl) { scrollEl.style.outline = ''; scrollEl.style.outlineOffset = ''; }
          } catch(e) {}
        }
      }

      // "Whole Page" button — use window scroll, no specific container
      bar.querySelector('#__us_scroll_whole_page').onclick = function(e) {
        e.stopPropagation();
        scrollSelector = null;
        scrollSelectMode = false;
        hoverOverlay.style.display = 'none';
        document.getElementById('__us_scroll_instructions').style.display = 'none';
        var selSpan = document.getElementById('__us_scroll_selected');
        selSpan.style.display = '';
        selSpan.innerHTML = '✓ Scroll area: <b>whole page</b>';
      };

      // "Done" button — finish with scroll config
      bar.querySelector('#__us_btn_scroll_done').onclick = function(e) {
        e.stopPropagation();
        cleanup();
        var count = parseInt(document.getElementById('__us_scroll_count').value, 10) || 0;
        window.unsocial.send('finish-scroll', {
          scrollSelector: scrollSelector,
          scrollCount: count,
        });
      };

      // "Skip" button — no scrolling
      bar.querySelector('#__us_btn_scroll_skip').onclick = function(e) {
        e.stopPropagation();
        cleanup();
        window.unsocial.send('finish-scroll', {
          scrollSelector: null,
          scrollCount: 0,
        });
      };

      // Cancel
      bar.querySelector('#__us_btn_cancel').onclick = function(e) {
        e.stopPropagation();
        cleanup();
        window.unsocial.send('cancel');
      };
    })();
  `;

  try {
    await win.webContents.executeJavaScript(js);
  } catch (_) {}
}
