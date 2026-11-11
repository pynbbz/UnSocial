const { BrowserWindow, session } = require('electron');
const path = require('path');
const { getRealisticUserAgent } = require('./user-agent');

/**
 * Custom Website Scraper
 *
 * Two modes:
 *   1) Interactive wizard — opens a visible browser window so the user can
 *      log in, navigate to a page, and visually select repeating items.
 *   2) Headless refresh — re-scrapes a page using a previously saved CSS
 *      selector (for auto-refresh / manual refresh).
 */

// ── Cookie & Login Detection Helpers ───────────────────────────────────────

const NOISE_COOKIE_REGEX = /^(_ga|_gid|_gat|_gcl_|_fbp|_fbc|__utma|__utmb|__utmc|__utmt|__utmz|_hj|mp_|ajs_|amplitude|intercom|hubspot|__cf_bm|cf_clearance|_cfuvid|Optanon|CookieConsent|cookie_notice|euconsent|gdpr|ccpa|_pk_|_sp_|_uet|_pin_|_ttp|mbox|s_cc|s_sq|s_vi|AMCV_|AMCVS_)/i;

const AUTH_COOKIE_REGEX = /(session|sess|token|auth|jwt|sid|uid|userid|user_id|logged_in|login|remember|pass|acct|account|credential|bearer|access_|refresh_|id_token|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|laravel_session|wordpress_logged_in|xf_user|xf_session|_forum_session|patron|member|sub_)/i;

// Stricter pattern used for auto-detection: requires the auth keyword to be a
// separate name segment, and excludes well-known tracking / anti-fraud cookies
// (which are present for anonymous visitors too).
// Includes '_t' which is Discourse's standard user authentication cookie token.
const STRICT_AUTH_COOKIE_REGEX = /(^|[_.-])(sid|sessionid|session|sess|auth|token|jwt|logged_?in|remember(_?me)?|user_?id|xf_user|wordpress_logged_in_[a-f0-9]+)([_.-]|$)|^(_?t)$/i;
const TRACKING_COOKIE_REGEX = /(stripe|sift|_rdt|ttcs|csrf|xsrf|__cf|gamera|fsuid|_ga|_fb|hubspot|intercom|amplitude|optimizely|segment|datadog|_dd_|newrelic|nr_|hotjar|_hj)/i;

function isStrictAuthCookieName(name) {
  return Boolean(name) && STRICT_AUTH_COOKIE_REGEX.test(name) && !TRACKING_COOKIE_REGEX.test(name);
}

/**
 * Check whether a set of cookies / domain belongs to a phpBB forum (such as Mobilism).
 * phpBB forums use paired cookies with identical prefixes ending in _u, _sid, and _k
 * (e.g. mob_u & mob_sid, or phpbb3_xxx_u & phpbb3_xxx_sid).
 */
function isPhpBBSite(cookies, domain = '') {
  const domLower = String(domain || '').toLowerCase();
  if (domLower.includes('mobilism.org') || domLower.includes('phpbb')) return true;
  if (!Array.isArray(cookies) || cookies.length === 0) return false;
  if (cookies.some(c => /phpbb/i.test(c.name))) return true;

  const uCookies = cookies.filter(c => /(^|_)u$/i.test(c.name));
  for (const uc of uCookies) {
    const prefix = uc.name.replace(/u$/i, '');
    if (prefix && cookies.some(c => c.name.toLowerCase() === `${prefix.toLowerCase()}sid`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the cookie jar represents an anonymous / guest session on known forum/CMS platforms.
 * For phpBB (e.g. Mobilism): [prefix]_u === '1' represents the ANONYMOUS user.
 */
function isGuestSession(cookies) {
  if (!Array.isArray(cookies)) return false;
  // phpBB: [prefix]_u === '1' means anonymous/guest
  const uCookie = cookies.find((c) => {
    if (!/(^|_)u$/i.test(c.name)) return false;
    const val = String(c.value || '').replace(/['"]/g, '').trim();
    return val === '1';
  });
  if (uCookie) {
    const kCookie = cookies.find((c) => /(^|_)k$/i.test(c.name) && String(c.value || '').replace(/['"]/g, '').trim().length > 0);
    if (!kCookie) return true;
  }
  return false;
}

/**
 * Check if the cookie jar contains a confirmed registered user session on phpBB.
 * In phpBB, [prefix]_u > 1 (e.g. 23412) is the registered user ID.
 */
function hasPhpBBUid(cookies) {
  if (!Array.isArray(cookies)) return false;
  const uCookie = cookies.find((c) => /(^|_)u$/i.test(c.name));
  if (uCookie) {
    const uid = parseInt(String(uCookie.value || '').replace(/['"]/g, '').trim(), 10);
    return !isNaN(uid) && uid > 1;
  }
  return false;
}

/**
 * In-page script that inspects the DOM for signs of being logged in or out.
 * Many sites (e.g. phpBB forums) hand out "session" cookies to guests too, so
 * cookies alone can't tell us whether the user is actually logged in.
 * Returns { state: 'logged-in' | 'logged-out' | 'unknown', hasLogout, hasLoginLink,
 *           hasPassword, loginRequiredMsg, lockedOut, detectedLoginUrl }.
 */
const DETECT_LOGIN_STATE_JS = `
  (function() {
    try {
      var LOGOUT_HREF = /(logout|log-out|log_out|signout|sign-out|sign_out|mode=logout|action=logout|do=logout)/i;
      var LOGOUT_TEXT = /\\b(log\\s*out|logout|sign\\s*out|signout|log\\s*off|sign\\s*off|disconnect)\\b/i;
      var LOGIN_HREF = /(\\/login|\\/signin|\\/sign-in|\\/log-in|mode=login|action=login|do=login|ucp\\.php\\?mode=login|wp-login\\.php)/i;
      var LOGIN_TEXT = /^\\s*(log\\s*in|login|sign\\s*in|signin|log\\s*in\\s*\\/\\s*register|login\\s*\\/\\s*register|sign\\s*in\\s*\\/\\s*register)\\s*$/i;
      var REQUIRED_MSG = /(you must be (registered and )?logged in|must be logged in|please (log|sign) in to|not (permitted|authori[sz]ed) to (use|view|access)|login required|sign in to continue|you need to (log|sign) in|session (has )?expired)/i;
      var LOCKOUT_MSG = /(too many (failed )?(login )?attempts|maximum (allowed )?number of login attempts|exceeded the maximum.*login|temporarily (locked|blocked)|try again later)/i;

      var hasLogout = false, hasLoginLink = false, detectedLoginUrl = '', hasUserIndicator = false;

      // 1. Check for modern user account/avatar indicators (Discourse, forums, SPA headers)
      try {
        var discourseUser = (window.Discourse && window.Discourse.User && typeof window.Discourse.User.current === 'function' && window.Discourse.User.current()) ||
                            (window.Discourse && window.Discourse.currentUser) ||
                            document.querySelector('meta[name="discourse-current-user"]');
        if (discourseUser) {
          hasUserIndicator = true;
        }
      } catch (_) {}

      try {
        var userEl = document.querySelector(
          '#current-user, .current-user, [data-user-id], [data-testid*="user-avatar" i], ' +
          '[data-testid*="profile-button" i], [aria-label*="account menu" i], [aria-label*="profile" i], ' +
          '.user-avatar, #user-menu, [aria-label*="user menu" i], .avatar-user, #wpadminbar, ' +
          'button#toggle-current-user, a.user-profile-link, .header-dropdown-toggle.current-user'
        );
        if (userEl && (!userEl.closest || !userEl.closest('#__unsocial_relogin_bar, #__unsocial_toolbar'))) {
          hasUserIndicator = true;
        }
      } catch (_) {}

      var links = document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]');
      for (var i = 0; i < links.length && i < 3000; i++) {
        var el = links[i];
        if (el.closest && el.closest('#__unsocial_relogin_bar, #__unsocial_toolbar')) continue;
        var href = el.getAttribute('href') || el.getAttribute('formaction') || '';
        var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (LOGOUT_HREF.test(href) || LOGOUT_TEXT.test(text)) {
          hasLogout = true;
        } else if (LOGIN_TEXT.test(text) || (LOGIN_HREF.test(href) && !href.startsWith('#') && !href.startsWith('javascript:'))) {
          hasLoginLink = true;
          if (!detectedLoginUrl && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            try {
              detectedLoginUrl = new URL(href, location.href).href;
            } catch (_) {}
          }
        }
      }
      var forms = document.querySelectorAll('form');
      for (var j = 0; j < forms.length; j++) {
        var action = forms[j].getAttribute('action') || '';
        if (LOGOUT_HREF.test(action)) hasLogout = true;
        if (!detectedLoginUrl && LOGIN_HREF.test(action)) {
          try {
            detectedLoginUrl = new URL(action, location.href).href;
          } catch (_) {}
        }
      }
      var hasPassword = !!document.querySelector('input[type="password"]');
      var bodyText = (document.body && document.body.innerText || '').slice(0, 25000);
      var loginRequiredMsg = REQUIRED_MSG.test(bodyText);
      var lockedOut = LOCKOUT_MSG.test(bodyText);

      var isLoginPage = /(\\/login|\\/signin|\\/sign-in|\\/log-in|mode=login|wp-login\\.php)/i.test(location.href);

      var state = 'unknown';
      if (hasLogout || hasUserIndicator) {
        state = 'logged-in';
      } else if (isLoginPage || hasPassword || loginRequiredMsg || lockedOut) {
        state = 'logged-out';
      } else if (hasLoginLink && !hasUserIndicator) {
        state = 'logged-out';
      }

      return {
        state: state,
        hasLogout: hasLogout,
        hasUserIndicator: hasUserIndicator,
        hasLoginLink: hasLoginLink,
        hasPassword: hasPassword,
        loginRequiredMsg: loginRequiredMsg,
        lockedOut: lockedOut,
        detectedLoginUrl: detectedLoginUrl,
        url: location.href
      };
    } catch (e) {
      return { state: 'unknown', error: String(e) };
    }
  })();
`;

async function detectLoginState(webContents) {
  try {
    if (!webContents || webContents.isDestroyed()) return { state: 'unknown' };
    return (await webContents.executeJavaScript(DETECT_LOGIN_STATE_JS)) || { state: 'unknown' };
  } catch (_) {
    return { state: 'unknown' };
  }
}

/**
 * Detects whether the current page in webContents is a Cloudflare verification challenge
 * (Cloudflare Turnstile, managed challenge, or bot detection page).
 * This check is strictly read-only and non-mutating to prevent triggering Cloudflare's
 * MutationObserver anti-tamper heuristics which loop the challenge.
 */
async function isCloudflareChallenge(webContents) {
  if (!webContents || webContents.isDestroyed()) return false;
  try {
    const url = (webContents.getURL() || '').toLowerCase();
    if (
      url.includes('challenges.cloudflare.com') ||
      url.includes('/cdn-cgi/challenge-platform/') ||
      url.includes('__cf_chl')
    ) {
      return true;
    }

    const title = (webContents.getTitle() || '').toLowerCase();
    if (
      title.includes('just a moment') ||
      title.includes('attention required! | cloudflare') ||
      (title.includes('cloudflare') && (title.includes('verify') || title.includes('checking') || title.includes('security')))
    ) {
      return true;
    }

    // Passive, non-mutating DOM check
    const isCf = await webContents.executeJavaScript(`(function() {
      try {
        if (document.getElementById('challenge-running') ||
            document.getElementById('challenge-form') ||
            document.getElementById('challenge-stage') ||
            document.getElementById('cf-wrapper') ||
            document.querySelector('.cf-turnstile') ||
            document.querySelector('[name="cf-turnstile-response"]') ||
            document.querySelector('input[name*="cf_chl"]') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
            document.querySelector('iframe[src*="turnstile"]')) {
          return true;
        }
        var t = (document.title || '').toLowerCase();
        if (t.indexOf('just a moment') !== -1) return true;
        var b = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 600).toLowerCase() : '';
        if (b.indexOf('verify you are human') !== -1 ||
            b.indexOf('checking if the site connection is secure') !== -1 ||
            b.indexOf('checking your browser before accessing') !== -1) {
          return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    })()`).catch(() => false);

    return Boolean(isCf);
  } catch (_) {
    return false;
  }
}

function getDomainPartsFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl);
    const hostname = u.hostname.toLowerCase();
    const parts = hostname.split('.');
    const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : hostname;
    return { hostname, baseDomain, origin: u.origin };
  } catch (_) {
    return { hostname: '', baseDomain: '', origin: '' };
  }
}

function cookieMatchesDomain(cookieDomain, hostname, baseDomain) {
  if (!cookieDomain || !hostname) return false;
  const clean = cookieDomain.replace(/^\./, '').toLowerCase();
  return (
    clean === hostname ||
    clean === baseDomain ||
    hostname.endsWith('.' + clean) ||
    clean.endsWith('.' + baseDomain)
  );
}

async function getSiteCookies(rawUrl) {
  const { hostname, baseDomain } = getDomainPartsFromUrl(rawUrl);
  if (!hostname) return { all: [], nonNoise: [], authLike: [], isGuest: false, isPhpBBLoggedIn: false };

  try {
    const allCookies = await session.defaultSession.cookies.get({});
    const nowSec = Date.now() / 1000;
    const matching = allCookies.filter((c) => {
      if (!c || !c.name || !c.value) return false;
      if (c.expirationDate && c.expirationDate < nowSec) return false;
      return cookieMatchesDomain(c.domain, hostname, baseDomain);
    });

    const isPhpBB = isPhpBBSite(matching, hostname);
    const isGuest = isPhpBB && isGuestSession(matching);
    const isPhpBBLoggedIn = isPhpBB && hasPhpBBUid(matching);
    const nonNoise = matching.filter((c) => !NOISE_COOKIE_REGEX.test(c.name));
    let authLike = nonNoise.filter((c) => isStrictAuthCookieName(c.name));

    if (isPhpBB && (isGuest || !isPhpBBLoggedIn)) {
      // Exclude guest/anonymous phpBB session cookies from authLike so guest visitors aren't treated as logged-in
      authLike = authLike.filter((c) => !/(^|_)sid$/i.test(c.name) && !/(^|_)u$/i.test(c.name) && !/(^|_)k$/i.test(c.name));
    }

    return { all: matching, nonNoise, authLike, isGuest, isPhpBBLoggedIn };
  } catch (_) {
    return { all: [], nonNoise: [], authLike: [], isGuest: false, isPhpBBLoggedIn: false };
  }
}

async function clearSiteCookiesAndStorage(rawUrl, preserveCloudflare = true) {
  const { hostname, baseDomain, origin } = getDomainPartsFromUrl(rawUrl);
  if (!hostname) return;

  try {
    if (origin) {
      // When preserving Cloudflare cookies, do not let Electron wipe the cookie jar
      const storages = preserveCloudflare
        ? ['localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
        : ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'];
      await session.defaultSession.clearStorageData({ origin, storages });
      const wwwOrigin = origin.replace('://', '://www.');
      if (wwwOrigin !== origin) {
        await session.defaultSession.clearStorageData({ origin: wwwOrigin, storages }).catch(() => {});
      }
    }
  } catch (_) {}

  try {
    const allCookies = await session.defaultSession.cookies.get({});
    for (const cookie of allCookies) {
      if (cookieMatchesDomain(cookie.domain, hostname, baseDomain)) {
        // Preserve Cloudflare clearance cookies so clearing session cookies doesn't trap the user in Cloudflare challenge loops
        if (preserveCloudflare && /^(__cf|cf_clearance|_cfuvid)/i.test(cookie.name)) {
          continue;
        }
        const cleanDomain = cookie.domain.replace(/^\./, '');
        const protocol = cookie.secure ? 'https' : 'http';
        const cookieUrl = `${protocol}://${cleanDomain}${cookie.path || '/'}`;
        await session.defaultSession.cookies.remove(cookieUrl, cookie.name).catch(() => {});
      }
    }
  } catch (_) {}
}

// ── Interactive Wizard ─────────────────────────────────────────────────────

/**
 * Open the Custom Website Wizard.
 * @param {string} siteUrl – The URL the user entered
 * @param {BrowserWindow} parentWindow – The main app window
 * @returns {Promise<{pageUrl, selector, feedName, usesLogin, authCookieNames, profileData}>}
 */
function startCustomWizard(siteUrl, parentWindow) {
  return new Promise(async (resolve, reject) => {
    // Normalise URL
    if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;

    let origin;
    try {
      const u = new URL(siteUrl);
      origin = u.origin;
    } catch (_) {
      origin = siteUrl;
    }

    const initialCookies = await getSiteCookies(siteUrl);
    const initialCookieNames = new Set(initialCookies.nonNoise.map((c) => c.name));

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
        backgroundThrottling: false,
      },
    });

    wizardWin.setMenuBarVisibility(false);

    // Allow OAuth popups (Google, Apple, SSO, etc.) during login
    wizardWin.webContents.setWindowOpenHandler(() => {
      return { action: 'allow' };
    });

    // ── State machine ────────────────────────────────────────────────────
    let step = 'login';   // login → navigate → select → done
    let targetUrl = siteUrl;
    let userMarkedLogin = null; // true | false | null
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
      injectToolbar(wizardWin, step, targetUrl).catch(() => { });
    });
    wizardWin.webContents.on('did-navigate', () => {
      injectToolbar(wizardWin, step, targetUrl).catch(() => { });
    });
    wizardWin.webContents.on('page-title-updated', (_event, title) => {
      const t = (title || '').toLowerCase();
      if (!t.includes('just a moment') && !t.includes('attention required! | cloudflare')) {
        injectToolbar(wizardWin, step, targetUrl).catch(() => { });
      }
    });

    // ── Messages from injected JS (via preload bridge) ──────────────────
    wizardWin.webContents.on('ipc-message', async (_event, channel, subChannel, data) => {
      if (channel !== 'custom-wizard-msg') return;

      switch (subChannel) {
        case 'login-done': {
          if (data && typeof data.usesLogin === 'boolean') {
            userMarkedLogin = data.usesLogin;
          }
          step = 'navigate';
          injectToolbar(wizardWin, step, targetUrl).catch(() => { });
          break;
        }

        case 'navigate-to': {
          targetUrl = data;
          step = 'navigate-loading';
          wizardWin.loadURL(data);
          break;
        }

        case 'start-selector': {
          step = 'select';
          // Pre-check "Uses Login" only if the user said they logged in, or the
          // page itself shows a logged-in session (logout link). Cookies alone
          // are unreliable — many sites give guests "session" cookies too.
          const pageLogin = await detectLoginState(wizardWin.webContents);
          const defaultUsesLogin = userMarkedLogin !== null
            ? userMarkedLogin
            : pageLogin.state === 'logged-in';
          injectSelector(wizardWin, defaultUsesLogin).catch(() => { });
          break;
        }

        case 'confirm-items': {
          // data = { selector, items: [...], feedName, usesLogin }
          // Transition to scroll step so user can optionally configure scrolling
          step = 'scroll';
          // Stash the selection data for after the scroll step
          wizardWin.__unsocialSelectionData = data;
          injectScrollStep(wizardWin, targetUrl).catch(() => { });
          break;
        }

        case 'finish-scroll': {
          // data = { scrollSelector, scrollCount }
          step = 'done';
          const selData = wizardWin.__unsocialSelectionData || {};
          const scrollSelector = (data && data.scrollSelector) || null;
          const scrollCount = (data && data.scrollCount) || 0;
          const profileData = buildProfileData(selData.items, selData.feedName, targetUrl);
          const finalCookies = await getSiteCookies(targetUrl);
          const usesLogin = typeof selData.usesLogin === 'boolean'
            ? selData.usesLogin
            : Boolean(userMarkedLogin);
          const authCookieNames = usesLogin
            ? (finalCookies.authLike.length > 0 ? finalCookies.authLike : finalCookies.nonNoise).map((c) => c.name)
            : [];
          const pageLogin = await detectLoginState(wizardWin.webContents);
          const isPhpBBLoggedIn = finalCookies.isPhpBBLoggedIn;
          const isGuest = finalCookies.isGuest;
          const loginState = (pageLogin.state === 'logged-in' || isPhpBBLoggedIn)
            ? 'logged-in'
            : (isGuest || pageLogin.state === 'logged-out')
              ? 'logged-out'
              : pageLogin.state;
          finish(null, {
            pageUrl: targetUrl,
            selector: selData.selector,
            feedName: selData.feedName || deriveFeedName(targetUrl),
            scrollSelector,
            scrollCount,
            usesLogin,
            authCookieNames,
            loginState,
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
    const chromeUA = getRealisticUserAgent();
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
async function scrapeCustomSiteHeadless(pageUrl, selector, feedName, scrollSelector, scrollCount, options = {}) {
  const MAX_ATTEMPTS = 2;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

    // Spoof user agent
    const chromeUA = getRealisticUserAgent();
    hidden.webContents.session.setUserAgent(chromeUA);
    hidden.webContents.setUserAgent(chromeUA);

    try {
      await loadPage(hidden, pageUrl);
      // Wait for dynamic content to render (6s for heavy SPAs like Meetup)
      await sleep(6000);

      // Detect if Cloudflare security verification is active
      const isCf = await isCloudflareChallenge(hidden.webContents);
      if (isCf) {
        const err = new Error(
          `"${feedName || pageUrl}" — Cloudflare security check required. Click Re-login on the feed card to complete verification.`
        );
        err.isLoginError = true;
        err.isCloudflare = true;
        throw err;
      }

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
                var prevY = window.scrollY;
                window.scrollBy({ top: window.innerHeight || 800, behavior: 'smooth' });
                // Fallback if window doesn't scroll (e.g. Angular Material md-content.main-wrapper)
                if (window.scrollY === prevY && document.documentElement.scrollHeight <= window.innerHeight + 50) {
                  var allEls = document.querySelectorAll('md-content, main, [class*="scroll" i], [class*="wrapper" i], [class*="content" i], div');
                  var bestEl = null;
                  var bestArea = 0;
                  for (var j = 0; j < allEls.length; j++) {
                    var el = allEls[j];
                    if (el === document.body || el === document.documentElement) continue;
                    if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
                      var style = window.getComputedStyle(el);
                      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || el.tagName === 'MD-CONTENT') {
                        var area = el.clientWidth * el.clientHeight;
                        if (area > bestArea) {
                          bestArea = area;
                          bestEl = el;
                        }
                      }
                    }
                  }
                  if (bestEl) {
                    bestEl.scrollBy({ top: bestEl.clientHeight || 800, behavior: 'smooth' });
                  }
                }
              }
            })();
          `);
          // Wait between scrolls for lazy-loaded content to appear
          await sleep(2000);
        }
        // Extra wait after all scrolls for final content to render
        await sleep(2000);
      }

      const extractionResult = await hidden.webContents.executeJavaScript(`
        (function() {
          var els = document.querySelectorAll(${JSON.stringify(selector)});
          var items = [];
          els.forEach(function(el, i) {
            ${EXTRACT_ITEM_JS}
            items.push(item);
          });
          var hasPasswordInput = !!document.querySelector('input[type="password"]');
          var currentUrl = window.location.href || '';
          return {
            items: items,
            hasPasswordInput: hasPasswordInput,
            currentUrl: currentUrl,
          };
        })();
      `);
      const loginInfo = await detectLoginState(hidden.webContents);
      const siteCookies = await getSiteCookies(pageUrl);

      const items = (extractionResult && extractionResult.items) || [];
      const currentUrl = (extractionResult && extractionResult.currentUrl) || hidden.webContents.getURL() || '';
      const loginUrlPattern = /\/(login|signin|sign-in|log-in|auth|authenticate|sso|checkpoint|session\/new)\b|mode=login/i;
      const redirectedToLogin = !loginUrlPattern.test(pageUrl || '') && loginUrlPattern.test(currentUrl);

      const hasPasswordInput = Boolean(extractionResult && extractionResult.hasPasswordInput);
      const isLoggedOut = Boolean(
        redirectedToLogin ||
        loginInfo.lockedOut ||
        siteCookies.isGuest ||
        (items.length === 0 && (loginInfo.state === 'logged-out' || hasPasswordInput))
      );

      // For feeds that depend on a login, verify the page actually shows a
      // logged-in session. Sites like phpBB forums still render a few generic
      // items for guests, so "found items" alone doesn't prove we're logged in.
      if (options.usesLogin && isLoggedOut) {
        const err = new Error(
          loginInfo.lockedOut
            ? `"${feedName || pageUrl}" — website reports too many login attempts. Auto-refresh paused; wait for the lockout to expire, then re-login.`
            : redirectedToLogin
              ? `"${feedName || pageUrl}" — website redirected to its login page. Session expired; auto-refresh paused until you re-login.`
              : siteCookies.isGuest
                ? `"${feedName || pageUrl}" — guest session detected. Session expired; auto-refresh paused until you re-login.`
                : `"${feedName || pageUrl}" — page shows you are not logged in. Session expired; auto-refresh paused until you re-login.`
        );
        err.isLoginError = true;
        err.lockedOut = Boolean(loginInfo.lockedOut);
        throw err;
      }

      if (items.length === 0) {
        const hasPassword = Boolean(extractionResult && extractionResult.hasPasswordInput);
        const isLoginIssue = Boolean(isLoggedOut || hasPassword || options.usesLogin);

        const errMsg = loginInfo.lockedOut
          ? `"${feedName || pageUrl}" — website reports too many login attempts. Auto-refresh paused; wait for the lockout to expire, then re-login.`
          : redirectedToLogin
            ? `Website redirected to login page (${feedName || pageUrl}) — session expired, please re-login.`
            : isLoginIssue
              ? `Found no items for "${feedName || pageUrl}" — login session may have expired. Click Re-login on the feed card.`
              : `Found no items for "${feedName || pageUrl}" matching selector "${selector}".`;
        const err = new Error(errMsg);
        err.isLoginError = isLoginIssue;
        err.lockedOut = Boolean(loginInfo.lockedOut);
        throw err;
      }

      const profileData = buildProfileData(items, feedName, pageUrl);
      profileData.loginState = (loginInfo.state === 'logged-in' || siteCookies.isPhpBBLoggedIn)
        ? 'logged-in'
        : (isLoggedOut ? 'logged-out' : loginInfo.state);
      return profileData;
    } catch (err) {
      lastError = err;
      console.error(`[Custom-scraper] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${pageUrl}: ${err.message}`);
      // Never retry login failures — repeated hits can trigger the site's
      // login-attempt lockout.
      if (err.isLoginError) break;
      if (attempt < MAX_ATTEMPTS) {
        // Wait before retrying to let transient issues resolve
        await sleep(3000);
      }
    } finally {
      if (!hidden.isDestroyed()) hidden.destroy();
    }
  }

  throw lastError;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadPage(win, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out loading page')), 30000);

    win.webContents.on('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return;  // Ignore sub-frame failures (ads, iframes, etc.)
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
    title: item.title || '',
    caption: item.text || item.title || '(no title)',
    timestamp: (function () {
      if (!item.date) return new Date().toISOString();
      // Strip IANA timezone annotations like [America/Edmonton] and "@" symbols
      var cleaned = item.date
        .replace(/\[.*?\]/g, '')
        .replace(/^(?:Starts|Ends):\s*/i, '')
        .replace(/\s*@\s*/g, ' ')
        .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1')
        .replace(/\s+[A-Z]{2,4}$/, '') // strip trailing timezone abbr like MT, EST if Date.parse chokes on it
        .trim();
      var d = new Date(cleaned);
      if (isNaN(d.getTime())) {
        // Fallback: try parsing without stripping trailing tz
        d = new Date(item.date.replace(/\[.*?\]/g, '').replace(/\s*@\s*/g, ' ').trim());
      }
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

  // ── Title: first heading, title-like class, or bold text ──
  var heading = el.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="-name" i], [class*="_name" i], [itemprop="name"]');
  var titleText = '';
  if (heading && heading.innerText.trim().length > 0 && heading.innerText.trim().length < 200) {
    titleText = heading.innerText.trim();
  } else {
    var bold = el.querySelector('b, strong');
    if (bold) titleText = bold.innerText.trim();
  }

  // ── Link: score all <a> tags (including el itself if it is an <a>) and pick the best one ──
  var allLinks = Array.from(el.querySelectorAll('a[href]'));
  if (el.tagName === 'A' && (el.hasAttribute('href') || el.href)) {
    allLinks.unshift(el);
  }
  var bestLink = null;
  var bestScore = -1;

  for (var li = 0; li < allLinks.length; li++) {
    var a = allLinks[li];
    var h = a.href;
    if (!h || h.startsWith('javascript:')) continue;

    var score = 0;
    var aText = a.innerText.trim();
    var aClass = (a.className || '').toLowerCase();

    // If the container element itself is the <a> wrapping the card, give it high priority
    if (a === el) score += 75;

    // Highest priority: class name contains "title" (e.g. "topictitle")
    if (aClass.indexOf('title') !== -1) score += 100;

    // High priority: the link text matches the title we already found
    if (titleText && aText.length > 0 && aText === titleText) score += 80;

    // Medium priority: link has meaningful visible text (not just icons)
    if (aText.length > 3) {
      score += 10 + Math.min(aText.length, 50);
    }

    // Deprioritise links that only wrap an icon/image (no real text)
    if (aText.length === 0) score -= 10;

    // Deprioritise profile / member links
    if (h.indexOf('memberlist') !== -1 || h.indexOf('profile') !== -1) score -= 20;

    // Deprioritise links with a fragment that looks like an anchor jump
    if (/#(?!$)/.test(h) && aText.length < 3) score -= 5;

    if (score > bestScore) {
      bestScore = score;
      bestLink = a;
    }
  }

  // Fallback: first <a> if nothing scored well, or closest ancestor <a[href]>
  if (!bestLink && allLinks.length > 0) {
    for (var fi = 0; fi < allLinks.length; fi++) {
      var fh = allLinks[fi].href;
      if (fh && !fh.startsWith('javascript:')) { bestLink = allLinks[fi]; break; }
    }
  }
  if (!bestLink && el.closest) {
    var parentLink = el.closest('a[href]');
    if (parentLink && parentLink.href && !parentLink.href.startsWith('javascript:')) {
      bestLink = parentLink;
    }
  }

  if (bestLink) {
    item.link = bestLink.href;
  }

  // ── Title: prefer heading, then title-class link, then bold, then first line of link/card text ──
  var bestLinkClass = bestLink ? (bestLink.className || '').toLowerCase() : '';
  if (bestLink && bestLink !== el && bestLinkClass.indexOf('title') !== -1 && bestLink.innerText.trim().length > 0) {
    item.title = bestLink.innerText.trim();
  } else if (titleText) {
    item.title = titleText;
  } else if (bestLink && bestLink.innerText.trim().length > 0) {
    item.title = bestLink.innerText.trim().split(/\\r?\\n/)[0].trim();
  }

  // Image: first <img> (prefer src, fallback to currentSrc or data-src)
  var img = el.querySelector('img[src], img[ng-src], img[data-src]');
  if (img) item.image = img.currentSrc || img.src || img.getAttribute('data-src') || '';

  // Date: <time> element or element with date class
  var timeEl = el.querySelector('time[datetime]');
  if (timeEl) {
    item.date = timeEl.getAttribute('datetime');
  } else {
    var timeEl2 = el.querySelector('time, [class*="date" i], [itemprop="startDate"]');
    if (timeEl2) {
      item.date = timeEl2.getAttribute('datetime') || timeEl2.getAttribute('content') || timeEl2.innerText.trim();
    } else {
      // Fallback: check if the element text contains a clear YYYY-MM-DD or DD/MM/YYYY date
      var dateMatch = el.innerText.match(/\\b(\\d{4}-\\d{2}-\\d{2})\\b/);
      if (dateMatch) item.date = dateMatch[1];
    }
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

  // If page is currently showing Cloudflare Turnstile or security challenge,
  // do NOT inject any toolbar or spacers — DOM mutations cause Turnstile to loop.
  const isCf = await isCloudflareChallenge(win.webContents);
  if (isCf) {
    console.log('[Custom Wizard] Cloudflare challenge active — withholding wizard toolbar injection to prevent challenge loop.');
    try {
      await win.webContents.executeJavaScript(`(function() {
        var old = document.getElementById('__unsocial_toolbar');
        if (old) old.remove();
        var spacer = document.getElementById('__unsocial_spacer');
        if (spacer) spacer.remove();
      })()`).catch(() => {});
    } catch (_) {}
    try {
      win.setTitle('Cloudflare Verification — Complete check to continue');
    } catch (_) {}
    return;
  }
  try {
    win.setTitle('UnSocial — Custom Feed Wizard');
  } catch (_) {}

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
          '<span style="flex:1;">🔐 <b>Step 1:</b> Log in to this website (if needed), then continue:</span>' +
          '<button id="__us_btn_logged_in" style="background:#4ade80;color:#111;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;" title="Mark this feed as using login credentials">🔐 I Logged In →</button>' +
          '<button id="__us_btn_continue" style="background:#e1306c;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;" title="Continue without marking as login-required">Skip Login (Public) →</button>' +
          '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

        bar.querySelector('#__us_btn_logged_in').onclick = function() {
          window.unsocial.send('login-done', { usesLogin: true });
        };
        bar.querySelector('#__us_btn_continue').onclick = function() {
          window.unsocial.send('login-done', { usesLogin: false });
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
  } catch (_) { }
}

async function injectSelector(win, defaultUsesLogin = false) {
  if (win.isDestroyed()) return;

  const js = `
    (function() {
      // ── Remove toolbar, replace with selector toolbar ──
      var old = document.getElementById('__unsocial_toolbar');
      if (old) old.remove();

      var bar = document.createElement('div');
      bar.id = '__unsocial_toolbar';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;box-shadow:0 2px 12px rgba(0,0,0,0.5);';

      var defaultUsesLogin = ${JSON.stringify(Boolean(defaultUsesLogin))};

      bar.innerHTML =
        '<span id="__us_instructions" style="flex:1;">🎯 <b>Step 3:</b> Hover over items and click on <b>one repeating item</b> (e.g. one post, one article, one card)</span>' +
        '<span id="__us_count" style="display:none;flex:1;color:#4ade80;font-weight:600;">✓ Found <b id="__us_num">0</b> similar items</span>' +
        '<button id="__us_btn_expand" style="display:none;background:#6366f1;color:#fff;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;" title="Select a larger parent container (e.g. whole card instead of inner text)">⬆ Expand Area</button>' +
        '<label id="__us_login_label" style="display:none;align-items:center;gap:6px;cursor:pointer;background:rgba(255,255,255,0.06);border:1px solid #444;padding:6px 10px;border-radius:6px;font-size:12px;user-select:none;" title="Mark this feed as using login credentials so UnSocial indicates login status and alerts if session expires">' +
          '<input id="__us_uses_login" type="checkbox" ' + (defaultUsesLogin ? 'checked' : '') + ' style="cursor:pointer;accent-color:#4ade80;" />' +
          '<span>🔐 Uses Login</span>' +
        '</label>' +
        '<input id="__us_name_input" type="text" placeholder="Feed name (optional)" style="display:none;background:#111;color:#fff;border:1px solid #444;padding:8px 12px;border-radius:6px;font-size:13px;width:200px;" />' +
        '<button id="__us_btn_confirm" style="display:none;background:#4ade80;color:#111;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">Create Feed</button>' +
        '<button id="__us_btn_reset" style="display:none;background:#f59e0b;color:#111;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">↺ Reset</button>' +
        '<button id="__us_btn_cancel" style="background:transparent;color:#888;border:1px solid #444;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>';

      document.body.appendChild(bar);

      // ── Hover highlight ──
      var hoverOverlay = document.createElement('div');
      hoverOverlay.id = '__unsocial_hover';
      hoverOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #e1306c;background:rgba(225,48,108,0.08);border-radius:4px;transition:all 0.1s ease;display:none;';
      document.body.appendChild(hoverOverlay);

      var selectedSelector = null;
      var selectedEls = [];
      var lastMatchedContainer = null;
      var selectorMode = true;

      // Helper: check if an element is an inner split column (e.g. left image / right details)
      // inside a single card or repeating row, rather than a standalone repeating item
      function isSubItemSplit(el, siblings) {
        var parent = el.parentElement;
        if (!parent) return false;
        // If parent is a semantic single-item card/article, its direct children are sub-parts of one item
        if (/^(ARTICLE|A|TR)$/.test(parent.tagName)) return true;
        // If parent itself is inside a repeating list item (LI, ARTICLE, TR) or has a sibling-repeating ancestor
        var repeatingAncestor = parent.closest('li, article, tr, [class*="event-row" i], [class*="item" i], [class*="card" i]');
        if (repeatingAncestor && repeatingAncestor !== document.body && repeatingAncestor.parentElement) {
          var ancTag = repeatingAncestor.tagName;
          var ancSibs = Array.from(repeatingAncestor.parentElement.children).filter(function(c) { return c.tagName === ancTag; });
          if (ancSibs.length >= 2 && siblings.length <= 3) {
            // Check if siblings have different roles (e.g. one has img/date, the other has title/details)
            var withLinks = siblings.filter(function(s) {
              return (s.tagName === 'A' && s.href) || !!s.querySelector('a[href]');
            }).length;
            if (withLinks < siblings.length) return true;
          }
        }
        return false;
      }

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

          if (siblings.length >= 2 && !isSubItemSplit(current, siblings)) {
            // Strategy 1: data attributes shared among siblings (React, Next.js, Angular, etc.)
            var dataAttrs = ['data-testid', 'data-element-name', 'data-type', 'role', 'data-qa', 'data-id', 'ng-repeat', 'data-ng-repeat'];
            for (var ai = 0; ai < dataAttrs.length; ai++) {
              var attr = dataAttrs[ai];
              var attrVal = current.getAttribute(attr);
              // Ignore generic layout/tab ARIA roles when we already found a tighter repeating item
              if (attr === 'role' && /^(tabpanel|tab|tablist|region|main|navigation|banner|contentinfo|dialog|menu|menubar|presentation|none|group)$/i.test(attrVal || '')) {
                continue;
              }
              if (attrVal) {
                var siblingsWithAttr = siblings.filter(function(s) { return s.getAttribute(attr) === attrVal; });
                if (siblingsWithAttr.length >= 2) {
                  var sel = tag.toLowerCase() + '[' + attr + '="' + attrVal.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]';
                  try {
                    var matches = document.querySelectorAll(sel);
                    if (matches.length >= 2 && matches.length <= 500) {
                      if (!bestResult) {
                        return { container: current, selector: sel, count: matches.length };
                      }
                    }
                  } catch(e) { /* invalid selector, skip */ }
                }
              }
            }

            // Strategy 2: shared CSS classes — filter out Tailwind/Angular/WP state, modifier & grid utility classes
            var currentClasses = Array.from(current.classList);
            var stableClasses = currentClasses.filter(function(cls) {
              return !/^(hover:|active:|focus:|focus-within:|group-hover:|group-focus:|disabled:|visited:|checked:|open:|sm:|md:|lg:|xl:|2xl:|xs:|dark:|motion-|aria-|data-\\[|ng-|post-\\d+|cat_|tribe_events_cat-|status-|has-|hentry$|type-)/.test(cls) &&
                     !/--(featured|active|selected|current|first|last|odd|even| sticky)$/i.test(cls) &&
                     !/^(col|row|g-col|g-row|grid-col|flex-col|tribe-common-g-col|tribe-common-g-row)$/i.test(cls);
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
                  // Scope to parent if the class selector also leaks into hidden/other tabs or containers
                  if (matches.length > siblings.length) {
                    var parentSelForScope = getSimpleSelector(parent);
                    if (parentSelForScope) {
                      var scopedCandidate = parentSelForScope + ' > ' + sel;
                      try {
                        var scopedCandidateMatches = document.querySelectorAll(scopedCandidate);
                        if (scopedCandidateMatches.length >= 2 && scopedCandidateMatches.length <= 500) {
                          sel = scopedCandidate;
                          matches = scopedCandidateMatches;
                        }
                      } catch(eScope) {}
                    }
                  }
                  if (matches.length >= 2 && matches.length <= 500) {
                    // Prefer results closer to the content (shallower = better containers)
                    if (!bestResult || matches.length <= bestResult.count) {
                      bestResult = { container: current, selector: sel, count: matches.length };
                    }
                    // If this looks like a good card-level container (has image + link, or is itself an <a>), return it
                    var hasLink = (current.tagName === 'A' && (current.hasAttribute('href') || current.href)) || !!current.querySelector('a[href]');
                    var hasImgOrHeading = !!current.querySelector('img') || !!current.querySelector('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="-name" i]');
                    if (hasLink && hasImgOrHeading) {
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
            var parentSel = getSimpleSelector(parent) || getStructuralSelector(parent);
            if (parentSel) {
              var sel = parentSel + ' > ' + tag.toLowerCase();
              try {
                var matches = document.querySelectorAll(sel);
                if (matches.length >= 2 && matches.length <= 500) {
                  // Only skip if current is a single-column cell (TD/TH) inside a multi-column row (TR)
                  // where the row itself is the true repeating item
                  var isCellInRow = /^(TD|TH)$/.test(tag) && parent.tagName === 'TR' && parent.parentElement &&
                    Array.from(parent.parentElement.children).filter(function(r) { return r.tagName === 'TR'; }).length >= 2;
                  if (!isCellInRow) {
                    if (!bestResult || matches.length <= bestResult.count) {
                      bestResult = { container: current, selector: sel, count: matches.length };
                    }
                    var hasLink3 = (current.tagName === 'A' && (current.hasAttribute('href') || current.href)) || !!current.querySelector('a[href]');
                    if (hasLink3) {
                      return bestResult;
                    }
                  }
                }
              } catch(e) { /* skip */ }
            }

            // Strategy 3b: table structures — when parent is TBODY/THEAD/TFOOT
            // with no id/classes, try the grandparent TABLE for a selector
            if (/^(TBODY|THEAD|TFOOT)$/.test(parent.tagName)) {
              var tableEl = parent.parentElement;
              if (tableEl && tableEl.tagName === 'TABLE') {
                var tableSel = getSimpleSelector(tableEl) || getStructuralSelector(tableEl);
                if (tableSel) {
                  var sel = tableSel + ' > ' + parent.tagName.toLowerCase() + ' > ' + tag.toLowerCase();
                  try {
                    var matches = document.querySelectorAll(sel);
                    if (matches.length >= 2 && matches.length <= 500) {
                      if (!bestResult || matches.length <= bestResult.count) {
                        bestResult = { container: current, selector: sel, count: matches.length };
                      }
                      if (current.querySelector('a[href]')) {
                        return bestResult;
                      }
                    }
                  } catch(e) { /* skip */ }
                }
              }
            }
          }

          current = parent;
          depth++;
        }

        return bestResult;
      }

      function getStructuralSelector(el) {
        var direct = getSimpleSelector(el);
        if (direct) return direct;

        // Build a unique nth-of-type path up to 8 levels deep (for classless nested tables/lists)
        var parts = [];
        var cur = el;
        var depth = 0;
        while (cur && cur !== document.body && cur !== document.documentElement && depth < 8) {
          var simple = getSimpleSelector(cur);
          if (simple && document.querySelectorAll(simple).length === 1) {
            parts.unshift(simple);
            var candidate = parts.join(' > ');
            try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch(e) {}
            break;
          }
          var p = cur.parentElement;
          if (!p) break;
          var tag = cur.tagName.toLowerCase();
          var sameTagSibs = Array.from(p.children).filter(function(c) { return c.tagName === cur.tagName; });
          if (sameTagSibs.length > 1) {
            var idx = sameTagSibs.indexOf(cur) + 1;
            parts.unshift(tag + ':nth-of-type(' + idx + ')');
          } else {
            parts.unshift(tag);
          }
          var candidatePath = parts.join(' > ');
          try { if (document.querySelectorAll(candidatePath).length === 1) return candidatePath; } catch(e) {}
          cur = p;
          depth++;
        }
        if (parts.length > 0) {
          var full = 'body > ' + parts.join(' > ');
          try { if (document.querySelectorAll(full).length === 1) return full; } catch(e) {}
        }
        return null;
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
        clearHighlights();
        els.forEach(function(el) {
          var rect = el.getBoundingClientRect();
          // If the matched element is an inline wrapper (e.g. <a> without display:block) wrapping a block card,
          // apply the outline directly to its single block child so CSS outline renders cleanly and scrolls natively.
          var targetEl = (rect.width < 10 || rect.height < 10) && el.children.length === 1 ? el.children[0] : el;
          if (el.tagName === 'A' && window.getComputedStyle(el).display === 'inline' && el.children.length > 0) {
            targetEl = el.children.length === 1 ? el.children[0] : el;
          }
          targetEl.style.outline = '3px solid ' + color;
          targetEl.style.outlineOffset = '-2px';
          targetEl.dataset.__unsocialHighlight = '1';
        });
      }

      function clearHighlights() {
        var oldContainer = document.getElementById('__unsocial_highlights_container');
        if (oldContainer) oldContainer.remove();

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

        // Preview the actual repeating item container that clicking here would select
        var previewEl = target;
        try {
          var rep = findRepeatingContainer(target);
          if (rep && rep.container) previewEl = rep.container;
        } catch (_) {}

        var rect = previewEl.getBoundingClientRect();
        if ((rect.width < 10 || rect.height < 10) && previewEl.children.length === 1) {
          rect = previewEl.children[0].getBoundingClientRect();
        }
        hoverOverlay.style.display = 'block';
        hoverOverlay.style.left = rect.left + 'px';
        hoverOverlay.style.top = rect.top + 'px';
        hoverOverlay.style.width = rect.width + 'px';
        hoverOverlay.style.height = rect.height + 'px';
      }

      function onMouseLeave() {
        hoverOverlay.style.display = 'none';
      }

      function applySelectionResult(result) {
        selectorMode = false;
        selectedSelector = result.selector;
        lastMatchedContainer = result.container;
        selectedEls = Array.from(document.querySelectorAll(result.selector));

        hoverOverlay.style.display = 'none';
        result.container.scrollIntoView({ behavior: 'instant', block: 'center' });
        highlightElements(selectedEls, '#4ade80');

        document.getElementById('__us_instructions').style.display = 'none';
        document.getElementById('__us_count').style.display = '';
        document.getElementById('__us_num').textContent = selectedEls.length;
        document.getElementById('__us_btn_expand').style.display = '';
        document.getElementById('__us_login_label').style.display = 'inline-flex';
        document.getElementById('__us_btn_confirm').style.display = '';
        document.getElementById('__us_btn_reset').style.display = '';
        document.getElementById('__us_name_input').style.display = '';
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

        applySelectionResult(result);
        } catch(err) {
          console.error('[UnSocial] Selector click error:', err);
          alert('Error detecting items: ' + err.message + '. Try clicking on a different element.');
        }
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseleave', onMouseLeave, true);
      document.addEventListener('click', onClick, true);

      // ── Expand Area button (walk up to next repeating ancestor) ──
      bar.querySelector('#__us_btn_expand').onclick = function(e) {
        e.stopPropagation();
        if (!lastMatchedContainer || !lastMatchedContainer.parentElement) return;
        var parentResult = findRepeatingContainer(lastMatchedContainer.parentElement);
        if (parentResult && parentResult.selector !== selectedSelector) {
          applySelectionResult(parentResult);
        } else {
          alert('Already at the outermost repeating container for this item.');
        }
      };

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
        var usesLoginEl = document.getElementById('__us_uses_login');
        var usesLogin = usesLoginEl ? Boolean(usesLoginEl.checked) : false;

        // Clean up
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseleave', onMouseLeave, true);
        document.removeEventListener('click', onClick, true);
        clearHighlights();

        window.unsocial.send('confirm-items', {
          selector: selectedSelector,
          items: items,
          feedName: feedName,
          usesLogin: usesLogin,
        });
      };

      // ── Reset button ──
      bar.querySelector('#__us_btn_reset').onclick = function(e) {
        e.stopPropagation();
        selectorMode = true;
        selectedSelector = null;
        selectedEls = [];
        lastMatchedContainer = null;
        clearHighlights();

        document.getElementById('__us_instructions').style.display = '';
        document.getElementById('__us_count').style.display = 'none';
        document.getElementById('__us_btn_expand').style.display = 'none';
        document.getElementById('__us_login_label').style.display = 'none';
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
  } catch (_) { }
}

module.exports = {
  startCustomWizard,
  scrapeCustomSiteHeadless,
  getSiteCookies,
  clearSiteCookiesAndStorage,
  getDomainPartsFromUrl,
  detectLoginState,
  isStrictAuthCookieName,
  isPhpBBSite,
  isCloudflareChallenge,
  DETECT_LOGIN_STATE_JS,
  EXTRACT_ITEM_JS,
  buildProfileData,
  deriveFeedName,
};

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
      var oldHighlightsContainer = document.getElementById('__unsocial_highlights_container');
      if (oldHighlightsContainer) oldHighlightsContainer.remove();
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
      hoverOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px dashed #6366f1;background:rgba(99,102,241,0.08);border-radius:4px;transition:all 0.1s ease;display:none;';
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
        hoverOverlay.style.left = rect.left + 'px';
        hoverOverlay.style.top = rect.top + 'px';
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
  } catch (_) { }
}
