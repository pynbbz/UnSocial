const express = require('express');
const fs = require('fs');
const path = require('path');
const { getFeedDir } = require('./rss-generator');

let server = null;

/**
 * Start a local Express server that serves the generated RSS/Atom feed files.
 * Any RSS reader can subscribe to:  http://localhost:<port>/feed/<username>
 *
 * @param {object} store   - electron-store instance
 * @param {object} [options]
 * @param {string} [options.host='127.0.0.1'] - Bind address ('0.0.0.0' for Docker)
 * @returns {object} The Express app instance (for adding management routes in headless mode)
 */
function startFeedServer(store, options) {
  const port = store.get('serverPort');
  const host = (options && options.host) || '127.0.0.1';
  const app = express();

  // CORS — allow RSS readers to fetch
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
  });

  // Token authentication — protects feed routes when a token is configured.
  // Accepts ?token=<value> query param  OR  Authorization: Bearer <value> header.
  // Skips /api/* routes so the management API can handle its own auth.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    const expectedToken = store.get('feedToken');
    if (!expectedToken) return next();

    const queryToken = req.query.token;
    const headerToken = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;

    if (queryToken === expectedToken || headerToken === expectedToken) {
      return next();
    }

    res.status(401).json({ error: 'Unauthorized — valid token required' });
  });

  // RSS feed endpoint
  app.get('/feed/:username', (req, res) => {
    const { username } = req.params;
    const format = req.query.format === 'atom' ? 'atom' : 'rss';
    const ext = format === 'atom' ? 'atom.xml' : 'rss.xml';
    const filePath = path.join(getFeedDir(), `${username}.${ext}`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send(`Feed not found for @${username}`);
    }

    const contentType =
      format === 'atom' ? 'application/atom+xml' : 'application/rss+xml';
    res.header('Content-Type', `${contentType}; charset=utf-8`);
    res.sendFile(filePath);
  });

  // List all available feeds (handy for discovery)
  app.get('/', (_req, res) => {
    const feedDir = getFeedDir();
    if (!fs.existsSync(feedDir)) {
      return res.json({ feeds: [] });
    }

    const files = fs
      .readdirSync(feedDir)
      .filter((f) => f.endsWith('.rss.xml'))
      .map((f) => f.replace('.rss.xml', ''));

    const port = store.get('serverPort');
    const token = store.get('feedToken');
    const tokenSuffix = token || '';
    const feeds = files.map((username) => ({
      username,
      rss: `http://localhost:${port}/feed/${username}` + (tokenSuffix ? `?token=${tokenSuffix}` : ''),
      atom: `http://localhost:${port}/feed/${username}?format=atom` + (tokenSuffix ? `&token=${tokenSuffix}` : ''),
    }));

    res.json({ feeds });
  });

  server = app.listen(port, host, () => {
    console.log(`RSS feed server running at http://${host}:${port}/`);
  });

  server.on('error', (err) => {
    console.error('Feed server error:', err.message);
  });

  return app;
}

function stopFeedServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { startFeedServer, stopFeedServer };
