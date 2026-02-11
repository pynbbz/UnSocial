const { net } = require('electron');

/**
 * Fetch and parse a remote .txt changelog file into RSS-compatible profile data.
 * No login required — uses a simple HTTP GET.
 *
 * Supports changelog formats where entries look like:
 *   VERSION - DATE
 *   Description line 1
 *   Description line 2
 *
 * The parser detects version headers by looking for lines that start with a
 * digit and contain " - " followed by a recognisable date.
 */
async function scrapeTxtFile(url) {
  const text = await fetchText(url);
  const entries = parseChangelog(text, url);

  // Derive a friendly name from the URL
  let hostName = '';
  try {
    const u = new URL(url);
    hostName = u.hostname.replace(/^www\./, '');
  } catch (_) {
    hostName = url;
  }

  const fileName = url.split('/').pop() || 'changelog.txt';

  return {
    fullName: `${hostName} – ${fileName}`,
    biography: `Changelog from ${url}`,
    posts: entries,
  };
}

// ── HTTP fetch using Electron's net module ────────────────────────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    try {
      const request = net.request(url);
      let body = '';

      request.on('response', (response) => {
        // Follow redirects are handled automatically by net.request
        if (response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString('utf-8');
        });
        response.on('end', () => resolve(body));
        response.on('error', (err) => reject(err));
      });

      request.on('error', (err) => reject(new Error(`Network error fetching ${url}: ${err.message}`)));
      setTimeout(() => reject(new Error(`Timeout fetching ${url}`)), 15000);
      request.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Changelog parser ──────────────────────────────────────────────────────

// Matches lines like:
//   7.6.5.0 - 11 Feb 2026
//   v2.3.1 - January 5, 2025
//   1.0 - 2025-01-15
//   7.6.4.9 - 10 Feb 2026 (macOS)
const VERSION_LINE_RE = /^v?(\d+[\d.]*\S*)\s*[-–—]\s*(.+)/i;

// Date patterns we try to parse from the header
const MONTH_NAMES = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function parseDateString(raw) {
  // Strip trailing parenthetical like "(macOS)" or "(Windows)"
  const cleaned = raw.replace(/\s*\(.*?\)\s*$/, '').trim();

  // Try ISO-style: 2025-01-15
  const isoMatch = cleaned.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
  }

  // Try "11 Feb 2026" or "Feb 11, 2026" or "February 5, 2025"
  const dmy = cleaned.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmy) {
    const m = MONTH_NAMES[dmy[2].toLowerCase()];
    if (m !== undefined) return new Date(+dmy[3], m, +dmy[1]);
  }

  const mdy = cleaned.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const m = MONTH_NAMES[mdy[1].toLowerCase()];
    if (m !== undefined) return new Date(+mdy[3], m, +mdy[2]);
  }

  // Fallback: let JS try
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

function parseChangelog(text, sourceUrl) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    const versionMatch = line.match(VERSION_LINE_RE);
    if (versionMatch) {
      // Save previous entry
      if (current) entries.push(current);

      const version = versionMatch[1];
      const dateRaw = versionMatch[2];
      const date = parseDateString(dateRaw);

      current = {
        version,
        title: line.trim(),
        bodyLines: [],
        timestamp: date ? date.toISOString() : new Date().toISOString(),
        timestampEstimated: !date,
        permalink: `${sourceUrl}#${encodeURIComponent(version)}`,
      };
    } else if (current) {
      // Continuation line — skip leading blanks before first content
      if (current.bodyLines.length === 0 && line.trim() === '') continue;
      current.bodyLines.push(line);
    }
    // Lines before the first version header are ignored (e.g. notes)
  }
  if (current) entries.push(current);

  // Trim trailing blank lines from each entry's body
  for (const e of entries) {
    while (e.bodyLines.length && e.bodyLines[e.bodyLines.length - 1].trim() === '') {
      e.bodyLines.pop();
    }
  }

  // Convert to the profileData.posts format used by the rest of the app
  return entries.map((e) => ({
    caption: e.bodyLines.length > 0
      ? `${e.title}\n${e.bodyLines.join('\n')}`
      : e.title,
    timestamp: e.timestamp,
    timestampEstimated: e.timestampEstimated || false,
    permalink: e.permalink,
    imageUrl: '',
    isVideo: false,
    videoUrl: '',
    likes: 0,
    comments: 0,
  }));
}

module.exports = { scrapeTxtFile };
