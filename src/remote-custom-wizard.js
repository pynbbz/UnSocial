const { BrowserWindow } = require('electron');
const crypto = require('crypto');
const { getRealisticUserAgent } = require('./user-agent');
const { EXTRACT_ITEM_JS, buildProfileData, deriveFeedName } = require('./scraper-custom');

/**
 * Remote Custom Wizard Session Manager.
 *
 * Runs interactive custom website selection in a headless Electron BrowserWindow
 * on the Mac Mini, streaming snapshots and touch coordinates to the mobile Web UI.
 */

const activeSessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes idle timeout

// Periodic cleanup of abandoned sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      console.log(`[RemoteWizard] Cleaning up timed-out session ${id}`);
      try {
        if (session.win && !session.win.isDestroyed()) {
          session.win.destroy();
        }
      } catch (_) {}
      activeSessions.delete(id);
    }
  }
}, 60 * 1000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Injected Helper Script for Remote Inspection ─────────────────────────────
const REMOTE_INJECT_JS = `
(function() {
  window.__unsocial = window.__unsocial || {};

  window.__unsocial.clearHighlights = function() {
    document.querySelectorAll('[data-__unsocial-highlight]').forEach(function(el) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      delete el.dataset.__unsocialHighlight;
    });
    document.querySelectorAll('[data-__unsocialhighlight]').forEach(function(el) {
      el.style.outline = '';
      el.style.outlineOffset = '';
      delete el.dataset.__unsocialhighlight;
    });
  };

  window.__unsocial.highlightElements = function(els, color) {
    window.__unsocial.clearHighlights();
    els.forEach(function(el) {
      el.style.outline = '3px solid ' + (color || '#4ade80');
      el.style.outlineOffset = '-2px';
      el.dataset.__unsocialHighlight = '1';
    });
  };

  window.__unsocial.getSimpleSelector = function(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var sel = el.tagName.toLowerCase() + '[data-testid="' + testId.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]';
      try { if (document.querySelectorAll(sel).length <= 3) return sel; } catch(e) {}
    }
    if (el.classList.length > 0) {
      var sel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).map(function(c) { return CSS.escape(c); }).join('.');
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch(e) {}
    }
    if (el.classList.length > 0) {
      for (var i = 0; i < el.classList.length; i++) {
        var sel = el.tagName.toLowerCase() + '.' + CSS.escape(el.classList[i]);
        try { if (document.querySelectorAll(sel).length <= 3) return sel; } catch(e) {}
      }
    }
    return null;
  };

  window.__unsocial.findRepeatingContainer = function(el) {
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
        // Strategy 1: data attributes
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
              } catch(e) {}
            }
          }
        }

        // Strategy 2: stable classes
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
            var sel = tag.toLowerCase() + '.' + sharedClasses.map(function(c) { return CSS.escape(c); }).join('.');
            try {
              var matches = document.querySelectorAll(sel);
              if (matches.length >= 2 && matches.length <= 500) {
                if (!bestResult || matches.length <= bestResult.count) {
                  bestResult = { container: current, selector: sel, count: matches.length };
                }
                if (current.querySelector('img') && current.querySelector('a[href]')) {
                  return bestResult;
                }
              }
              if (matches.length > 500) {
                var parentSel = window.__unsocial.getSimpleSelector(parent);
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
            } catch(e) {}
          }
        }

        // Strategy 3: parent > tag
        var parentSel = window.__unsocial.getSimpleSelector(parent);
        if (parentSel) {
          var sel = parentSel + ' > ' + tag.toLowerCase();
          try {
            var matches = document.querySelectorAll(sel);
            if (matches.length >= 2 && matches.length <= 500) {
              if (!bestResult || matches.length <= bestResult.count) {
                bestResult = { container: current, selector: sel, count: matches.length };
              }
            }
          } catch(e) {}
        }
      }

      current = parent;
      depth++;
    }

    return bestResult;
  };

  // Auto-detect common candidate selectors on initial load
  window.__unsocial.detectCandidates = function() {
    var candidates = [];
    var commonSelectors = [
      'article',
      '[class*="post" i]',
      '[class*="card" i]',
      '[class*="item" i]',
      '[class*="article" i]',
      '[class*="story" i]',
      '[class*="entry" i]',
      'main li',
      'ul > li',
      '.thing' // old reddit
    ];

    commonSelectors.forEach(function(sel) {
      try {
        var matches = Array.from(document.querySelectorAll(sel));
        if (matches.length >= 3 && matches.length <= 60) {
          // Check if at least 2 have links
          var withLinks = matches.filter(function(m) { return m.querySelector('a[href]'); });
          if (withLinks.length >= 2) {
            candidates.push({
              selector: sel,
              count: matches.length,
              sampleTitle: (withLinks[0].innerText || '').substring(0, 50).trim()
            });
          }
        }
      } catch(_) {}
    });

    // Deduplicate by count/sample
    var seen = new Set();
    return candidates.filter(function(c) {
      if (seen.has(c.selector)) return false;
      seen.add(c.selector);
      return true;
    }).slice(0, 5);
  };
})();
`;

/**
 * Capture high-resolution JPEG snapshot from a BrowserWindow.
 */
async function captureSnapshot(win) {
  const image = await win.webContents.capturePage();
  const buffer = image.toJPEG(80);
  return 'data:image/jpeg;base64,' + buffer.toString('base64');
}

/**
 * Start a new remote wizard session for a custom site.
 */
async function startRemoteWizard(siteUrl) {
  if (!siteUrl || typeof siteUrl !== 'string') {
    throw new Error('Valid URL is required');
  }
  siteUrl = siteUrl.trim();
  if (!/^https?:\/\//i.test(siteUrl)) {
    siteUrl = 'https://' + siteUrl;
  }

  const wizardId = crypto.randomBytes(12).toString('hex');

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const chromeUA = getRealisticUserAgent();
  win.webContents.session.setUserAgent(chromeUA);
  win.webContents.setUserAgent(chromeUA);

  // Load URL with timeout
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out loading ${siteUrl}`));
    }, 30000);

    win.webContents.on('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });

    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      clearTimeout(timeout);
      reject(new Error(`Failed to load page: ${desc} (${code})`));
    });

    win.loadURL(siteUrl);
  });

  // Wait 3.5s for dynamic content / SPAs to render
  await sleep(3500);

  // Inject helper scripts
  await win.webContents.executeJavaScript(REMOTE_INJECT_JS);

  const pageInfo = await win.webContents.executeJavaScript(`
    ({
      title: document.title || '',
      url: window.location.href || ${JSON.stringify(siteUrl)},
      candidates: window.__unsocial.detectCandidates(),
      scrollWidth: document.documentElement.scrollWidth || 1280,
      scrollHeight: document.documentElement.scrollHeight || 900
    })
  `);

  const screenshot = await captureSnapshot(win);

  const session = {
    wizardId,
    win,
    siteUrl,
    pageUrl: pageInfo.url,
    pageTitle: pageInfo.title,
    lastActive: Date.now(),
    currentSelector: null,
    currentItems: [],
    scrollCount: 0,
    scrollSelector: null,
  };

  activeSessions.set(wizardId, session);

  return {
    wizardId,
    pageUrl: pageInfo.url,
    pageTitle: pageInfo.title,
    viewport: { width: 1280, height: 900, scrollHeight: pageInfo.scrollHeight },
    screenshot,
    candidates: pageInfo.candidates || [],
  };
}

/**
 * Handle a tap or selector click on the remote custom wizard.
 */
async function clickRemoteWizard(wizardId, { x, y, percentX, percentY, selector }) {
  const session = activeSessions.get(wizardId);
  if (!session) throw new Error('Wizard session expired or not found. Please restart.');
  session.lastActive = Date.now();

  const win = session.win;
  if (!win || win.isDestroyed()) throw new Error('Wizard window is no longer active.');

  // Calculate target coordinates if percentage was sent
  let targetX = x;
  let targetY = y;
  if (typeof percentX === 'number' && typeof percentY === 'number') {
    targetX = Math.round(percentX * 1280);
    targetY = Math.round(percentY * 900);
  }

  const result = await win.webContents.executeJavaScript(`
    (function() {
      var sel = ${JSON.stringify(selector || null)};
      var targetX = ${typeof targetX === 'number' ? targetX : 'null'};
      var targetY = ${typeof targetY === 'number' ? targetY : 'null'};

      window.__unsocial.clearHighlights();

      if (!sel && targetX !== null && targetY !== null) {
        var el = document.elementFromPoint(targetX, targetY);
        if (!el || el === document.body || el === document.documentElement) {
          return { error: 'No item found at tap point. Try tapping directly on a headline, image, or card.' };
        }
        var rep = window.__unsocial.findRepeatingContainer(el);
        if (!rep && el.parentElement) rep = window.__unsocial.findRepeatingContainer(el.parentElement);
        if (!rep && el.parentElement && el.parentElement.parentElement) {
          rep = window.__unsocial.findRepeatingContainer(el.parentElement.parentElement);
        }
        if (!rep) {
          return { error: 'Could not detect repeating pattern from this element. Try tapping another element.' };
        }
        sel = rep.selector;
        if (rep.container && rep.container.scrollIntoView) {
          rep.container.scrollIntoView({ behavior: 'instant', block: 'center' });
        }
      }

      if (!sel) return { error: 'No selector provided or detected' };

      var matches = Array.from(document.querySelectorAll(sel));
      if (matches.length === 0) return { error: 'No items match selector: ' + sel };

      window.__unsocial.highlightElements(matches, '#4ade80');

      var items = [];
      matches.forEach(function(el, i) {
        ${EXTRACT_ITEM_JS}
        items.push(item);
      });

      return {
        selector: sel,
        count: matches.length,
        items: items
      };
    })();
  `);

  if (result.error) {
    return { error: result.error };
  }

  // Small pause for visual highlight outline to render before capturing
  await sleep(120);
  const screenshot = await captureSnapshot(win);

  session.currentSelector = result.selector;
  session.currentItems = result.items;

  return {
    selector: result.selector,
    count: result.count,
    items: result.items,
    screenshot,
  };
}

/**
 * Scroll down the page in the remote custom wizard.
 */
async function scrollRemoteWizard(wizardId, { scrollCount = 1 }) {
  const session = activeSessions.get(wizardId);
  if (!session) throw new Error('Wizard session expired or not found.');
  session.lastActive = Date.now();

  const win = session.win;
  if (!win || win.isDestroyed()) throw new Error('Wizard window is no longer active.');

  const scrolls = Math.min(Math.max(parseInt(scrollCount, 10) || 1, 1), 10);
  session.scrollCount = (session.scrollCount || 0) + scrolls;

  for (let i = 0; i < scrolls; i++) {
    await win.webContents.executeJavaScript(`
      window.scrollBy({ top: 800, behavior: 'instant' });
    `);
    await sleep(1500);
  }

  // If we already have a selector, re-extract and re-highlight
  let updatedData = null;
  if (session.currentSelector) {
    updatedData = await win.webContents.executeJavaScript(`
      (function() {
        var sel = ${JSON.stringify(session.currentSelector)};
        var matches = Array.from(document.querySelectorAll(sel));
        window.__unsocial.highlightElements(matches, '#4ade80');
        var items = [];
        matches.forEach(function(el, i) {
          ${EXTRACT_ITEM_JS}
          items.push(item);
        });
        return { count: matches.length, items: items };
      })();
    `);
    session.currentItems = updatedData.items;
  }

  await sleep(150);
  const screenshot = await captureSnapshot(win);

  return {
    selector: session.currentSelector,
    count: updatedData ? updatedData.count : 0,
    items: session.currentItems || [],
    screenshot,
    scrollCount: session.scrollCount,
  };
}

/**
 * Confirm and finalize the remote wizard session, returning data ready to create a feed.
 */
async function confirmRemoteWizard(wizardId, { feedName }) {
  const session = activeSessions.get(wizardId);
  if (!session) throw new Error('Wizard session expired or not found.');

  const win = session.win;
  const pageUrl = session.pageUrl;
  const selector = session.currentSelector;
  const items = session.currentItems || [];
  const scrollCount = session.scrollCount || 0;
  const finalFeedName = (feedName || '').trim() || deriveFeedName(pageUrl);

  if (!selector || items.length === 0) {
    throw new Error('Please select at least one item on the page first.');
  }

  const profileData = buildProfileData(items, finalFeedName, pageUrl);

  // Destroy window and cleanup
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch (_) {}
  activeSessions.delete(wizardId);

  return {
    pageUrl,
    selector,
    feedName: finalFeedName,
    scrollSelector: null,
    scrollCount,
    profileData,
  };
}

/**
 * Cancel and close a remote wizard session.
 */
function cancelRemoteWizard(wizardId) {
  const session = activeSessions.get(wizardId);
  if (session) {
    try {
      if (session.win && !session.win.isDestroyed()) session.win.destroy();
    } catch (_) {}
    activeSessions.delete(wizardId);
  }
  return { success: true };
}

module.exports = {
  startRemoteWizard,
  clickRemoteWizard,
  scrollRemoteWizard,
  confirmRemoteWizard,
  cancelRemoteWizard,
};
