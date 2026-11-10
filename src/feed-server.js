const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getFeedDir } = require('./rss-generator');
const { resolveFeedBaseUrl } = require('./feed-url-base');
const {
  startRemoteWizard,
  clickRemoteWizard,
  scrollRemoteWizard,
  confirmRemoteWizard,
  cancelRemoteWizard,
} = require('./remote-custom-wizard');

let server = null;
const sessionSecret = crypto.randomBytes(32).toString('hex');

function createSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + 30 * 86400 * 1000 })
  ).toString('base64url');
  const hmac = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${hmac}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, hmac] = parts;
  const expectedHmac = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
  if (hmac !== expectedHmac) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const list = {};
  if (!header) return list;
  header.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * Start the Express server that serves generated RSS feeds and the
 * remote mobile Web UI.
 *
 * @param {object} store - electron-store instance
 * @param {object} bridge - bridge object with main process callbacks
 */
function startFeedServer(store, bridge = {}) {
  const port = store.get('serverPort') || 3845;
  const app = express();

  // Parse body
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
  });

  // Transparently normalize /remote sub-paths for API and Feed requests
  app.use((req, _res, next) => {
    if (req.url.startsWith('/remote/api/') || req.url.startsWith('/remote/feed/')) {
      req.url = req.url.slice('/remote'.length);
    } else if (req.url === '/remote/feeds.json') {
      req.url = '/feeds.json';
    }
    next();
  });

  // Serve remote web static assets on both /remote-assets and /remote/remote-assets.
  // In packaged builds with asarUnpack, resolve to app.asar.unpacked to avoid temporary file extraction.
  const unpackedWebDir = path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'remote-web');
  const remoteWebDir = fs.existsSync(unpackedWebDir)
    ? unpackedWebDir
    : path.join(__dirname, 'remote-web');
  const staticMiddleware = express.static(remoteWebDir);
  app.use('/remote-assets', staticMiddleware);
  app.use('/remote/remote-assets', staticMiddleware);

  // ── Public RSS Feed Endpoint ───────────────────────────────────────────────
  const feedHandler = (req, res, next) => {
    const expectedToken = store.get('feedToken');
    if (expectedToken) {
      const queryToken = req.query.token;
      const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null;
      if (queryToken !== expectedToken && headerToken !== expectedToken) {
        return res.status(401).json({ error: 'Unauthorized — valid token required' });
      }
    }

    let { username } = req.params;
    if (username.endsWith('.rss.xml')) username = username.slice(0, -8);
    else if (username.endsWith('.atom.xml')) username = username.slice(0, -9);
    else if (username.endsWith('.xml')) username = username.slice(0, -4);

    const format = req.query.format === 'atom' || (req.params.username && req.params.username.endsWith('.atom.xml')) ? 'atom' : 'rss';
    const ext = format === 'atom' ? 'atom.xml' : 'rss.xml';
    const filePath = path.join(getFeedDir(), `${username}.${ext}`);

    if (!fs.existsSync(filePath)) {
      if (typeof next === 'function') return next();
      return res.status(404).send(`Feed not found for @${username}`);
    }

    const contentType =
      format === 'atom' ? 'application/atom+xml' : 'application/rss+xml';
    res.header('Content-Type', `${contentType}; charset=utf-8`);
    res.sendFile(filePath);
  };

  app.get('/feed/:username', feedHandler);
  app.get('/remote/feed/:username', feedHandler);
  // Also match when Tailscale Funnel /feed strips the /feed prefix:
  app.get('/:username([a-zA-Z0-9_.-]+)', (req, res, next) => {
    const u = req.params.username;
    if (u === 'feeds.json' || u === 'remote' || u === 'remote-assets' || u.startsWith('api')) {
      return next();
    }
    return feedHandler(req, res, next);
  });

  // ── Auth Endpoints ────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const expectedUser = store.get('remoteUsername') || 'admin';
    const expectedPass = store.get('remotePassword') || '';

    if (!expectedPass) {
      return res.status(500).json({ error: 'Remote password not configured on Mac Mini' });
    }

    if (username === expectedUser && password === expectedPass) {
      const token = createSessionToken(username);
      res.cookie('unsocial_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 3600 * 1000,
      });
      return res.json({ success: true, token, username });
    }

    return res.status(401).json({ error: 'Invalid username or password' });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie('unsocial_session', { path: '/' });
    res.json({ success: true });
  });

  // ── Auth Middleware for Remote API ────────────────────────────────────────
  function requireWebAuth(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies['unsocial_session'];
    const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const token = cookieToken || headerToken;

    const session = verifySessionToken(token);
    if (session) {
      req.user = session;
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized — valid session required' });
  }

  app.get('/api/session', requireWebAuth, (req, res) => {
    res.json({ authenticated: true, username: req.user.u });
  });

  // ── Remote API: Platforms Status ──────────────────────────────────────────
  app.get('/api/platforms', requireWebAuth, async (_req, res) => {
    try {
      const logins = bridge.checkPlatforms ? await bridge.checkPlatforms() : {};
      res.json({ logins });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/telegram/channels', requireWebAuth, async (_req, res) => {
    try {
      if (!bridge.listTelegramChannels) {
        throw new Error('Telegram channel listing not available');
      }
      const channels = await bridge.listTelegramChannels();
      res.json({ channels });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Remote API: Feeds List ────────────────────────────────────────────────
  app.get('/api/feeds', requireWebAuth, (_req, res) => {
    const feeds = store.get('feeds') || [];
    const feedBase = resolveFeedBaseUrl(store);
    const token = store.get('feedToken');
    const tokenSuffix = token ? `?token=${token}` : '';
    const atomTokenSuffix = token ? `&token=${token}` : '';

    const enrichedFeeds = feeds.map((f) => {
      const key = f.feedKey || f.username;
      return {
        ...f,
        rssUrl: `${feedBase}/feed/${key}${tokenSuffix}`,
        atomUrl: `${feedBase}/feed/${key}?format=atom${atomTokenSuffix}`,
      };
    });

    res.json({ feeds: enrichedFeeds });
  });

  // ── Remote API: Add Feed ──────────────────────────────────────────────────
  app.post('/api/feed/add', requireWebAuth, async (req, res) => {
    try {
      if (!bridge.addFeed) {
        throw new Error('Feed addition not available in current process');
      }
      const entry = await bridge.addFeed(req.body);
      const feedBase = resolveFeedBaseUrl(store);
      const token = store.get('feedToken');
      const tokenSuffix = token ? `?token=${token}` : '';
      const key = entry.feedKey || entry.username;

      res.json({
        success: true,
        feed: entry,
        rssUrl: `${feedBase}/feed/${key}${tokenSuffix}`,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Remote API: Refresh Feed ──────────────────────────────────────────────
  app.post('/api/feed/refresh', requireWebAuth, async (req, res) => {
    try {
      const { username, platform } = req.body || {};
      if (!username) throw new Error('Username required');
      if (!bridge.refreshFeed) throw new Error('Feed refresh not available');

      const updated = await bridge.refreshFeed(username, platform);
      res.json({ success: true, feed: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/feed/refresh-all', requireWebAuth, async (_req, res) => {
    try {
      if (!bridge.refreshAll) throw new Error('Refresh all not available');
      const results = await bridge.refreshAll();
      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Remote API: Rename Feed ───────────────────────────────────────────────
  app.post('/api/feed/rename', requireWebAuth, async (req, res) => {
    try {
      const { username, platform, newAlias, filterKeywords, usesLogin } = req.body || {};
      if (!username) throw new Error('Username required');
      if (!bridge.renameFeed) throw new Error('Feed rename not available in bridge');

      const feeds = await bridge.renameFeed(username, platform, newAlias, filterKeywords, usesLogin);
      const plat = platform || 'instagram';
      const target = (feeds || []).find(
        (f) => f.username === username && (f.platform || 'instagram') === plat
      );

      const feedBase = resolveFeedBaseUrl(store);
      const token = store.get('feedToken');
      const tokenSuffix = token ? `?token=${token}` : '';
      const atomTokenSuffix = token ? `&token=${token}` : '';
      const key = target ? (target.feedKey || target.username) : username;

      res.json({
        success: true,
        feed: target ? {
          ...target,
          rssUrl: `${feedBase}/feed/${key}${tokenSuffix}`,
          atomUrl: `${feedBase}/feed/${key}?format=atom${atomTokenSuffix}`,
        } : null,
        feeds: (feeds || []).map((f) => {
          const k = f.feedKey || f.username;
          return {
            ...f,
            rssUrl: `${feedBase}/feed/${k}${tokenSuffix}`,
            atomUrl: `${feedBase}/feed/${k}?format=atom${atomTokenSuffix}`,
          };
        }),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Remote API: Confirm Custom Feed Login ─────────────────────────────────
  app.post('/api/feed/confirm-login', requireWebAuth, async (req, res) => {
    try {
      const { username } = req.body || {};
      if (!username) throw new Error('Username required');
      if (!bridge.confirmCustomLogin) throw new Error('Confirm custom login not available in bridge');

      const result = await bridge.confirmCustomLogin(username);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Remote Custom Website Studio Endpoints ────────────────────────────────
  app.post('/api/custom-wizard/start', requireWebAuth, async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url) throw new Error('URL required');
      const result = await startRemoteWizard(url);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/custom-wizard/click', requireWebAuth, async (req, res) => {
    try {
      const { wizardId, x, y, percentX, percentY, selector } = req.body || {};
      if (!wizardId) throw new Error('wizardId required');
      const result = await clickRemoteWizard(wizardId, { x, y, percentX, percentY, selector });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/custom-wizard/scroll', requireWebAuth, async (req, res) => {
    try {
      const { wizardId, scrollCount } = req.body || {};
      if (!wizardId) throw new Error('wizardId required');
      const result = await scrollRemoteWizard(wizardId, { scrollCount });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/custom-wizard/confirm', requireWebAuth, async (req, res) => {
    try {
      const { wizardId, feedName } = req.body || {};
      if (!wizardId) throw new Error('wizardId required');
      const confirmedData = await confirmRemoteWizard(wizardId, { feedName });

      if (!bridge.saveCustomFeed) {
        throw new Error('Save custom feed not available in bridge');
      }

      const entry = await bridge.saveCustomFeed(confirmedData);
      const feedBase = resolveFeedBaseUrl(store);
      const token = store.get('feedToken');
      const tokenSuffix = token ? `?token=${token}` : '';
      const key = entry.feedKey || entry.username;

      res.json({
        success: true,
        feed: entry,
        rssUrl: `${feedBase}/feed/${key}${tokenSuffix}`,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/custom-wizard/cancel', requireWebAuth, (req, res) => {
    try {
      const { wizardId } = req.body || {};
      if (wizardId) cancelRemoteWizard(wizardId);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Feeds Discovery (JSON) & Root Web Handler ─────────────────────────────
  app.get('/feeds.json', (req, res) => {
    const expectedToken = store.get('feedToken');
    if (expectedToken) {
      const queryToken = req.query.token;
      const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null;
      if (queryToken !== expectedToken && headerToken !== expectedToken) {
        return res.status(401).json({ error: 'Unauthorized — valid token required' });
      }
    }

    const feedDir = getFeedDir();
    if (!fs.existsSync(feedDir)) return res.json({ feeds: [] });

    const files = fs
      .readdirSync(feedDir)
      .filter((f) => f.endsWith('.rss.xml'))
      .map((f) => f.replace('.rss.xml', ''));

    const feedBase = resolveFeedBaseUrl(store);
    const token = store.get('feedToken');
    const tokenSuffix = token ? `?token=${token}` : '';
    const atomTokenSuffix = token ? `&token=${token}` : '';
    const feeds = files.map((username) => ({
      username,
      rss: `${feedBase}/feed/${username}${tokenSuffix}`,
      atom: `${feedBase}/feed/${username}?format=atom${atomTokenSuffix}`,
    }));

    res.json({ feeds });
  });

  // Root route: Serve HTML Web App for browsers, or JSON discovery for automated tools
  app.get('/', (req, res) => {
    const accept = req.headers.accept || '';
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      return res.redirect(307, '/feeds.json');
    }

    // Serve Mobile Web UI
    const indexPath = path.join(remoteWebDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.redirect('/feeds.json');
    }
  });

  app.get(['/remote', '/remote/'], (_req, res) => {
    const indexPath = path.join(remoteWebDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.redirect('/');
    }
  });

  // Listen on 0.0.0.0 so Tailscale Funnel / Tailscale IP and LAN can connect
  server = app.listen(port, '0.0.0.0', () => {
    console.log(`UnSocial feed & remote server running at http://localhost:${port}/ and network interfaces`);
  });

  server.on('error', (err) => {
    console.error('Feed server error:', err.message);
  });
}

function stopFeedServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { startFeedServer, stopFeedServer };
