const express = require('express');
const fs = require('fs');
const path = require('path');
const { getFeedDir } = require('./rss-generator');

let server = null;

/**
 * Start a local Express server that serves the generated RSS/Atom feed files.
 * Any RSS reader can subscribe to:  http://localhost:<port>/feed/<username>
 */
function startFeedServer(store) {
  const port = store.get('serverPort');
  const app = express();

  // CORS — allow RSS readers to fetch
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
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
    const feeds = files.map((username) => ({
      username,
      rss: `http://localhost:${port}/feed/${username}`,
      atom: `http://localhost:${port}/feed/${username}?format=atom`,
    }));

    res.json({ feeds });
  });

  server = app.listen(port, '127.0.0.1', () => {
    console.log(`RSS feed server running at http://localhost:${port}/`);
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
