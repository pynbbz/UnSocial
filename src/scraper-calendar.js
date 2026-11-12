const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Windows Timezone to IANA Mapping (used by Outlook Live / Microsoft 365) ──
const WINDOWS_TO_IANA_TZ = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Calcutta',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};

/**
 * Parse and normalize any calendar input:
 * - Google Calendar iCal URL, embed URL, share URL (?cid=...), or Calendar ID
 * - Outlook Live / Office 365 published ICS or HTML URL
 * - Any http(s) or webcal(s) .ics URL
 * - Local .ics file path or file:// URL
 *
 * Returns null if the input does not look like a calendar source.
 */
function parseCalendarInput(input, options = {}) {
  if (!input) return null;
  const forceCalendar = Boolean(options.forceCalendar);

  if (typeof input === 'object' && input !== null) {
    const raw = (input.targetUrl || input.fullUrl || input.url || input.username || '').trim();
    const parsed = parseCalendarInput(raw, { forceCalendar: forceCalendar || input.platform === 'calendar' });
    if (!parsed) return null;
    return {
      ...parsed,
      ...input,
      platform: 'calendar',
      username: input.username || parsed.username,
      fullUrl: parsed.fullUrl,
      siteUrl: input.siteUrl || parsed.siteUrl || parsed.fullUrl,
      alias: input.alias || parsed.alias,
    };
  }

  let raw = String(input).trim();
  if (!raw) return null;

  // 1. Convert webcal:// or webcals:// to https://
  let isWebcal = false;
  if (/^webcals?:\/\//i.test(raw)) {
    isWebcal = true;
    raw = raw.replace(/^webcals?:\/\//i, 'https://');
  }

  // 2. Local .ics file path or file:// URI
  if (/^file:\/\//i.test(raw) || (/\.(?:ics|ical|ifb|vcs)$/i.test(raw) && !/^https?:\/\//i.test(raw) && (raw.startsWith('/') || raw.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(raw)))) {
    let filePath = raw;
    if (/^file:\/\//i.test(filePath)) {
      try {
        const u = new URL(filePath);
        filePath = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
      } catch (_) {
        filePath = filePath.replace(/^file:\/\/\/?/i, '');
      }
    } else if (filePath.startsWith('~/')) {
      const os = require('os');
      filePath = path.join(os.homedir(), filePath.slice(2));
    }

    const baseName = path.basename(filePath).replace(/\.(?:ics|ical|ifb|vcs)$/i, '') || 'calendar';
    const slug = sanitizeSlug(`local-${baseName}`);
    const fileUrl = filePath.startsWith('/') ? `file://${filePath}` : `file:///${filePath.replace(/\\/g, '/')}`;
    return {
      username: slug,
      platform: 'calendar',
      calendarProvider: 'ics-file',
      calendarProviderLabel: 'ICS File',
      fullUrl: filePath,
      siteUrl: fileUrl,
      alias: baseName,
    };
  }

  // 3. Google Calendar URLs
  // 3a. Google Calendar iCal URL: https://calendar.google.com/calendar/ical/<calId>/<vis>/basic.ics
  const gcalIcalMatch = raw.match(/^(?:https?:\/\/)?calendar\.google\.com\/calendar\/ical\/([^/]+)\/([^/]+)\/([^?#]+)/i);
  if (gcalIcalMatch) {
    const calId = safeDecodeURIComponent(gcalIcalMatch[1]);
    const fullUrl = raw.startsWith('http') ? raw : `https://${raw}`;
    const siteUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calId)}`;
    const readableName = deriveGoogleCalReadableName(calId);
    const slug = sanitizeSlug(`gcal-${readableName}`);
    return {
      username: slug,
      platform: 'calendar',
      calendarProvider: 'google',
      calendarProviderLabel: 'Google Calendar',
      fullUrl,
      siteUrl,
      alias: readableName,
    };
  }

  // 3b. Google Calendar Embed or Share URL:
  //     https://calendar.google.com/calendar/embed?src=...
  //     https://calendar.google.com/calendar/u/0/embed?src=...
  //     https://calendar.google.com/calendar/u/0?cid=...
  //     https://calendar.google.com/calendar/r?cid=...
  if (/(?:https?:\/\/)?(?:www\.)?calendar\.google\.com\/calendar/i.test(raw) || /(?:https?:\/\/)?(?:www\.)?google\.com\/calendar/i.test(raw)) {
    const normalizedUrl = raw.startsWith('http') ? raw : `https://${raw}`;
    try {
      const u = new URL(normalizedUrl);
      const srcParam = u.searchParams.get('src');
      const cidParam = u.searchParams.get('cid');
      let calId = srcParam || '';

      if (!calId && cidParam) {
        calId = decodeGoogleCid(cidParam);
      }

      if (calId) {
        const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calId)}/public/basic.ics`;
        const siteUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calId)}`;
        const readableName = deriveGoogleCalReadableName(calId);
        const slug = sanitizeSlug(`gcal-${readableName}`);
        return {
          username: slug,
          platform: 'calendar',
          calendarProvider: 'google',
          calendarProviderLabel: 'Google Calendar',
          fullUrl: icsUrl,
          siteUrl,
          alias: readableName,
        };
      }
    } catch (_) {}
  }

  // 4. Outlook Live / Microsoft 365 Published Calendar URLs
  //    Examples:
  //    https://outlook.live.com/owa/calendar/<guid>/<token>/cid-<id>/reachcalendar.ics
  //    https://outlook.live.com/owa/calendar/<guid>/<token>/calendar.ics
  //    https://outlook.live.com/owa/calendar/<guid>/<token>/calendar.html
  //    https://outlook.office365.com/owa/calendar/.../calendar.ics
  //    https://outlook.office.com/owa/calendar/.../calendar.ics
  const outlookMatch = raw.match(/^(?:https?:\/\/)?(outlook\.(?:live|office365|office)\.com\/owa\/calendar\/.+)$/i);
  if (outlookMatch) {
    let fullUrl = raw.startsWith('http') ? raw : `https://${raw}`;
    let siteUrl = fullUrl;
    if (/\.html(?=[?#]|$)/i.test(fullUrl)) {
      siteUrl = fullUrl;
      fullUrl = fullUrl.replace(/\.html(?=[?#]|$)/i, '.ics');
    } else if (/\.ics(?=[?#]|$)/i.test(fullUrl)) {
      siteUrl = fullUrl.replace(/\.ics(?=[?#]|$)/i, '.html');
    }
    const shortHash = crypto.createHash('sha1').update(fullUrl).digest('hex').slice(0, 8);
    return {
      username: `outlook-cal-${shortHash}`,
      platform: 'calendar',
      calendarProvider: 'outlook',
      calendarProviderLabel: 'Outlook Calendar',
      fullUrl,
      siteUrl,
      alias: 'Outlook Calendar',
    };
  }

  // 5. Any URL ending in .ics / .ical / .vcs or webcal:// URL or URL with format=ics
  const isIcsUrl = isWebcal || /^(?:https?:\/\/)?[^\s?#]+\.(?:ics|ical|ifb|vcs)(?:[?#].*)?$/i.test(raw) || /[?&](?:format|ical|ext)=ics\b/i.test(raw);
  if (isIcsUrl) {
    const fullUrl = raw.startsWith('http') ? raw : `https://${raw}`;
    let slug = 'calendar-feed';
    let alias = 'Calendar';
    let provider = 'ics';
    let providerLabel = 'Calendar';
    try {
      const u = new URL(fullUrl);
      const host = u.hostname.replace(/^www\./, '');
      if (host.includes('google.com')) {
        provider = 'google';
        providerLabel = 'Google Calendar';
      } else if (host.includes('outlook.') || host.includes('office365.') || host.includes('office.com')) {
        provider = 'outlook';
        providerLabel = 'Outlook Calendar';
      } else if (host.includes('icloud.com')) {
        provider = 'icloud';
        providerLabel = 'iCloud Calendar';
      }
      const parts = u.pathname.split('/').filter(Boolean);
      const lastPart = (parts.pop() || 'calendar').replace(/\.(?:ics|ical|ifb|vcs)$/i, '');
      const cleanLast = lastPart && !['basic', 'calendar', 'reachcalendar', 'public', 'feed'].includes(lastPart.toLowerCase())
        ? lastPart
        : (parts.pop() || host.split('.')[0] || 'calendar');
      alias = safeDecodeURIComponent(cleanLast).replace(/[-_]+/g, ' ');
      slug = sanitizeSlug(`${host.replace(/\./g, '-')}-${cleanLast}`);
    } catch (_) {}

    return {
      username: slug,
      platform: 'calendar',
      calendarProvider: provider,
      calendarProviderLabel: providerLabel,
      fullUrl,
      siteUrl: fullUrl,
      alias,
    };
  }

  // 6. If explicitly invoked from the Calendar Builder modal (forceCalendar = true):
  //    Allow bare Google Calendar IDs (e.g. "en.usa#holiday@group.v.calendar.google.com" or "example@gmail.com")
  //    or bare URLs that return ICS content.
  if (forceCalendar) {
    // Check if it looks like a Google Calendar ID (contains @, no slashes)
    if (!raw.includes('/') && raw.includes('@')) {
      const calId = raw;
      const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calId)}/public/basic.ics`;
      const siteUrl = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calId)}`;
      const readableName = deriveGoogleCalReadableName(calId);
      const slug = sanitizeSlug(`gcal-${readableName}`);
      return {
        username: slug,
        platform: 'calendar',
        calendarProvider: 'google',
        calendarProviderLabel: 'Google Calendar',
        fullUrl: icsUrl,
        siteUrl,
        alias: readableName,
      };
    }

    // Or any http(s) URL provided in the Calendar modal
    if (/^https?:\/\//i.test(raw) || /^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}\//.test(raw)) {
      const fullUrl = raw.startsWith('http') ? raw : `https://${raw}`;
      const shortHash = crypto.createHash('sha1').update(fullUrl).digest('hex').slice(0, 8);
      return {
        username: `calendar-${shortHash}`,
        platform: 'calendar',
        calendarProvider: 'ics',
        calendarProviderLabel: 'Calendar',
        fullUrl,
        siteUrl: fullUrl,
        alias: 'Calendar',
      };
    }
  }

  return null;
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

function decodeGoogleCid(cid) {
  const decoded = safeDecodeURIComponent(cid.trim());
  if (decoded.includes('@')) return decoded;
  try {
    const fromB64 = Buffer.from(decoded, 'base64').toString('utf8').trim();
    if (fromB64 && (fromB64.includes('@') || fromB64.includes('.')) && /^[\x20-\x7E]+$/.test(fromB64)) {
      return fromB64;
    }
  } catch (_) {}
  return decoded;
}

function deriveGoogleCalReadableName(calId) {
  if (!calId) return 'Google Calendar';
  const cleaned = calId
    .replace(/@group\.v\.calendar\.google\.com$/i, '')
    .replace(/@group\.calendar\.google\.com$/i, '')
    .replace(/@gmail\.com$/i, '')
    .replace(/#holiday$/i, ' Holidays')
    .replace(/#sports$/i, ' Sports')
    .replace(/^[a-z]{2}\./i, '');
  if (/^[a-f0-9]{20,}$/i.test(cleaned)) {
    return `Google Calendar (${cleaned.slice(0, 6)})`;
  }
  return cleaned.replace(/[._-]+/g, ' ').trim() || 'Google Calendar';
}

function sanitizeSlug(str) {
  return String(str || 'calendar')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'calendar';
}

// ── Fetch .ics Content (Remote HTTP/HTTPS or Local File) ──────────────────

async function fetchCalendarIcs(fullUrl) {
  // Check if local file path
  if (!/^https?:\/\//i.test(fullUrl)) {
    let filePath = fullUrl;
    if (/^file:\/\//i.test(filePath)) {
      try {
        const u = new URL(filePath);
        filePath = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
      } catch (_) {
        filePath = filePath.replace(/^file:\/\/\/?/i, '');
      }
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Calendar .ics file not found at: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  let text;
  try {
    text = await fetchTextHttp(fullUrl);
  } catch (err) {
    // If an Outlook .html link was converted to calendar.ics and 404'd, try reachcalendar.ics
    if (/outlook\.(?:live|office365|office)\.com/i.test(fullUrl) && /\/calendar\.ics$/i.test(fullUrl)) {
      const altUrl = fullUrl.replace(/\/calendar\.ics$/i, '/reachcalendar.ics');
      text = await fetchTextHttp(altUrl);
    } else {
      throw err;
    }
  }

  if (!text || !text.includes('BEGIN:VCALENDAR')) {
    if (fullUrl.includes('calendar.google.com')) {
      throw new Error(
        'Could not fetch a valid iCalendar (.ics) feed from Google Calendar. ' +
        'Make sure the calendar is set to "Make available to public" in Google Calendar settings, ' +
        'or use the "Secret address in iCal format" (.ics) link.'
      );
    }
    if (/outlook\.(?:live|office365|office)\.com/i.test(fullUrl)) {
      throw new Error(
        'Could not fetch a valid iCalendar (.ics) feed from Outlook. ' +
        'In Outlook Settings → Calendar → Shared calendars → Publish a calendar, copy the ICS link.'
      );
    }
    throw new Error('The URL did not return a valid iCalendar (.ics) file (missing BEGIN:VCALENDAR).');
  }

  return text;
}

function fetchTextHttp(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      done(reject, new Error(`Timeout fetching calendar ${url}`));
    }, 20000);

    try {
      const request = net.request({
        method: 'GET',
        url,
      });
      request.setHeader('Accept', 'text/calendar, text/plain, */*;q=0.8');
      request.setHeader('Cache-Control', 'no-cache');

      const chunks = [];

      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          done(reject, new Error(`HTTP ${response.statusCode} fetching calendar from ${url}`));
          return;
        }
        response.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          done(resolve, body);
        });
        response.on('error', (err) => done(reject, err));
      });

      request.on('error', (err) => {
        done(reject, new Error(`Network error fetching calendar ${url}: ${err.message}`));
      });

      request.end();
    } catch (err) {
      done(reject, err);
    }
  });
}

// ── RFC 5545 iCalendar Parser ────────────────────────────────────────────

/**
 * Unfold RFC 5545 lines (lines starting with space or tab continue previous line).
 */
function unfoldIcsLines(rawText) {
  const unfolded = rawText.replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/\r?\n/);
}

/**
 * Parse a single RFC 5545 content line into { name, params, value }.
 * Handles quoted parameter values containing colons or semicolons.
 */
function parseIcsLine(line) {
  if (!line || !line.trim()) return null;

  let colonIdx = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ':' && !inQuotes) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx === -1) return null;

  const left = line.slice(0, colonIdx);
  const rawValue = line.slice(colonIdx + 1);

  // Split left into property name and parameters (respecting quotes)
  const parts = [];
  let current = '';
  inQuotes = false;
  for (let i = 0; i < left.length; i++) {
    const ch = left[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const name = (parts[0] || '').trim().toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const eqIdx = p.indexOf('=');
    if (eqIdx !== -1) {
      const pKey = p.slice(0, eqIdx).trim().toUpperCase();
      let pVal = p.slice(eqIdx + 1).trim();
      if (pVal.startsWith('"') && pVal.endsWith('"')) {
        pVal = pVal.slice(1, -1);
      }
      params[pKey] = pVal;
    }
  }

  let value = rawValue;
  if (params.ENCODING === 'QUOTED-PRINTABLE') {
    value = decodeQuotedPrintable(value);
  }

  return { name, params, value };
}

function decodeQuotedPrintable(str) {
  try {
    const cleaned = str.replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
        bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(cleaned.charCodeAt(i));
      }
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch (_) {
    return str;
  }
}

function unescapeIcsText(val) {
  if (!val) return '';
  return String(val)
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Parse an offset string like "-0500", "+0200", "-05:00" into minutes from UTC.
 */
function parseUtcOffsetMinutes(offsetStr) {
  if (!offsetStr) return 0;
  const m = String(offsetStr).trim().match(/^([+-])(\d{2}):?(\d{2})(?::?\d{2})?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/**
 * Resolve a timezone identifier (IANA or Windows TZID) into a valid IANA timezone if possible.
 */
function resolveIanaTimezone(tzid) {
  if (!tzid) return null;
  const clean = tzid.replace(/^"|"$/g, '').trim();
  if (!clean) return null;

  if (WINDOWS_TO_IANA_TZ[clean]) {
    return WINDOWS_TO_IANA_TZ[clean];
  }

  // Strip leading slash if present (e.g. "/Americas/New_York" or "/freeassociation.sourceforge.net/America/New_York")
  const candidate = clean.replace(/^\/+/, '');
  for (const cand of [clean, candidate, candidate.split('/').slice(-2).join('/')]) {
    if (!cand) continue;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: cand });
      return cand;
    } catch (_) {}
  }
  return null;
}

/**
 * Convert local wall-clock components (year, month 1-12, day, hour, minute, second)
 * in a given IANA timezone (or VTIMEZONE offset fallback) into a UTC Date object.
 */
function wallClockToDate(parts, tzid, vtimezones = {}, defaultCalendarTz = null) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;

  const effectiveTz = tzid || defaultCalendarTz;
  const ianaTz = resolveIanaTimezone(effectiveTz);

  if (ianaTz) {
    try {
      // Guess UTC timestamp first, then measure the timezone's offset at that instant
      const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
      const offsetMs = getIanaOffsetMs(utcGuess, ianaTz);
      const adjusted = utcGuess - offsetMs;
      // Re-verify offset at the adjusted instant (handles DST transition boundaries accurately)
      const offsetMs2 = getIanaOffsetMs(adjusted, ianaTz);
      return new Date(utcGuess - offsetMs2);
    } catch (_) {}
  }

  // Check parsed VTIMEZONE definitions from the .ics file
  if (effectiveTz && vtimezones[effectiveTz]) {
    const vtz = vtimezones[effectiveTz];
    const offsetMins = vtz.standardOffsetMinutes ?? vtz.daylightOffsetMinutes ?? 0;
    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMins * 60 * 1000;
    return new Date(utcMs);
  }

  // Fallback: interpret in local system time
  return new Date(year, month - 1, day, hour, minute, second);
}

function getIanaOffsetMs(utcMs, ianaTz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const formatted = dtf.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of formatted) {
    if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - utcMs;
}

/**
 * Parse an iCalendar date or date-time value:
 * - "20261115" (all-day date)
 * - "20261115T143000Z" (UTC date-time)
 * - "20261115T143000" (local/TZID date-time)
 */
function parseIcsDateValue(rawVal, params = {}, vtimezones = {}, defaultCalendarTz = null) {
  if (!rawVal) return null;
  const val = String(rawVal).trim();

  // All-day date: YYYYMMDD
  const dateOnlyMatch = val.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnlyMatch || params.VALUE === 'DATE') {
    const m = val.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    // Represent all-day date in local midnight so date formatting matches the calendar day
    const date = new Date(year, month - 1, day, 0, 0, 0);
    return {
      date,
      isAllDay: true,
      parts: { year, month, day, hour: 0, minute: 0, second: 0 },
      tzid: null,
      dateKey: `${m[1]}-${m[2]}-${m[3]}`,
    };
  }

  // Date-time: YYYYMMDDTHHMMSS(Z)?
  const dtMatch = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i);
  if (dtMatch) {
    const year = parseInt(dtMatch[1], 10);
    const month = parseInt(dtMatch[2], 10);
    const day = parseInt(dtMatch[3], 10);
    const hour = parseInt(dtMatch[4], 10);
    const minute = parseInt(dtMatch[5], 10);
    const second = parseInt(dtMatch[6], 10);
    const isUtc = Boolean(dtMatch[7]);
    const tzid = isUtc ? 'UTC' : (params.TZID || null);

    const date = isUtc
      ? new Date(Date.UTC(year, month - 1, day, hour, minute, second))
      : wallClockToDate({ year, month, day, hour, minute, second }, tzid, vtimezones, defaultCalendarTz);

    return {
      date,
      isAllDay: false,
      isUtc,
      parts: { year, month, day, hour, minute, second },
      tzid,
      dateKey: `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`,
    };
  }

  // Fallback ISO parse
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    return {
      date: d,
      isAllDay: false,
      parts: {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
      },
      tzid: params.TZID || null,
      dateKey: d.toISOString().slice(0, 10),
    };
  }

  return null;
}

/**
 * Parse RFC 5545 DURATION string (e.g. "PT1H30M", "P1D", "P2W") into milliseconds.
 */
function parseIcsDurationMs(durStr) {
  if (!durStr) return 0;
  const m = String(durStr).trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = parseInt(m[2] || '0', 10);
  const days = parseInt(m[3] || '0', 10);
  const hours = parseInt(m[4] || '0', 10);
  const minutes = parseInt(m[5] || '0', 10);
  const seconds = parseInt(m[6] || '0', 10);
  const totalSeconds = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds;
  return sign * totalSeconds * 1000;
}

/**
 * Parse RRULE string (e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;UNTIL=20261231T235959Z")
 */
function parseRRule(rruleStr, vtimezones, defaultCalendarTz) {
  if (!rruleStr) return null;
  const rule = {};
  const parts = String(rruleStr).split(';');
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    const key = k.trim().toUpperCase();
    const val = v.trim();
    if (key === 'FREQ') rule.freq = val.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, parseInt(val, 10) || 1);
    else if (key === 'COUNT') rule.count = parseInt(val, 10);
    else if (key === 'UNTIL') {
      const parsedUntil = parseIcsDateValue(val, {}, vtimezones, defaultCalendarTz);
      if (parsedUntil) {
        // If UNTIL is a date-only value, include the whole day
        rule.until = parsedUntil.isAllDay
          ? new Date(parsedUntil.date.getTime() + 86399000)
          : parsedUntil.date;
      }
    } else if (key === 'BYDAY') {
      rule.byDay = val.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (key === 'BYMONTHDAY') {
      rule.byMonthDay = val.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    } else if (key === 'BYMONTH') {
      rule.byMonth = val.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }
  }
  if (!rule.freq) return null;
  rule.interval = rule.interval || 1;
  return rule;
}

const WEEKDAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Expand a recurring VEVENT into individual occurrences within [windowStart, windowEnd].
 */
function expandRecurringEvent(ev, windowStart, windowEnd, vtimezones, defaultCalendarTz) {
  const rule = parseRRule(ev.rrule, vtimezones, defaultCalendarTz);
  if (!rule || !ev.start) return [ev];

  const startParts = ev.start.parts;
  const durationMs = ev.end
    ? (ev.end.date.getTime() - ev.start.date.getTime())
    : (ev.durationMs || (ev.start.isAllDay ? 86400000 : 3600000));

  const exdateTimeSet = new Set(ev.exdates.map((d) => d.date.getTime()));
  const exdateKeySet = new Set(ev.exdates.map((d) => d.dateKey));

  const isExcluded = (occStart) => {
    if (exdateTimeSet.has(occStart.date.getTime())) return true;
    if (exdateKeySet.has(occStart.dateKey)) return true;
    return false;
  };

  const makeOccurrence = (year, month, day) => {
    const pad2 = (n) => String(n).padStart(2, '0');
    const dateKey = `${year}-${pad2(month)}-${pad2(day)}`;
    let occDate;
    if (ev.start.isAllDay) {
      occDate = new Date(year, month - 1, day, 0, 0, 0);
    } else if (ev.start.isUtc) {
      occDate = new Date(Date.UTC(year, month - 1, day, startParts.hour, startParts.minute, startParts.second));
    } else {
      occDate = wallClockToDate(
        { year, month, day, hour: startParts.hour, minute: startParts.minute, second: startParts.second },
        ev.start.tzid,
        vtimezones,
        defaultCalendarTz
      );
    }
    const occStart = {
      ...ev.start,
      date: occDate,
      parts: { ...startParts, year, month, day },
      dateKey,
    };
    const occEnd = {
      isAllDay: ev.start.isAllDay,
      date: new Date(occDate.getTime() + durationMs),
    };
    return { occStart, occEnd };
  };

  const occurrences = [];
  const maxTotalCount = rule.count || 600;
  let totalGenerated = 0;

  const baseDateUtc = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));

  // Helper to push a candidate Y-M-D if valid
  const tryPushDate = (y, m, d) => {
    if (totalGenerated >= maxTotalCount) return false;
    // Validate calendar date (e.g. Feb 30 doesn't exist)
    const testUtc = new Date(Date.UTC(y, m - 1, d));
    if (testUtc.getUTCFullYear() !== y || testUtc.getUTCMonth() !== m - 1 || testUtc.getUTCDate() !== d) {
      return true;
    }
    const { occStart, occEnd } = makeOccurrence(y, m, d);
    if (occStart.date.getTime() < ev.start.date.getTime() - 1000) {
      return true;
    }
    if (rule.until && occStart.date.getTime() > rule.until.getTime()) {
      return false; // past UNTIL
    }
    totalGenerated++;

    if (!isExcluded(occStart) && occEnd.date.getTime() >= windowStart.getTime() && occStart.date.getTime() <= windowEnd.getTime()) {
      occurrences.push({
        ...ev,
        start: occStart,
        end: occEnd,
        recurrenceKey: occStart.dateKey,
        isRecurringInstance: true,
        recurrenceFreq: rule.freq,
      });
    }
    if (occStart.date.getTime() > windowEnd.getTime()) {
      return false;
    }
    return totalGenerated < maxTotalCount;
  };

  if (rule.freq === 'DAILY') {
    let cursor = new Date(baseDateUtc.getTime());
    let safety = 0;
    while (safety++ < 2500) {
      const keepGoing = tryPushDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
      if (!keepGoing) break;
      cursor.setUTCDate(cursor.getUTCDate() + rule.interval);
    }
  } else if (rule.freq === 'WEEKLY') {
    const targetDays = (rule.byDay && rule.byDay.length > 0)
      ? rule.byDay.map((tok) => WEEKDAY_MAP[tok.slice(-2)]).filter((n) => n !== undefined).sort((a, b) => a - b)
      : [baseDateUtc.getUTCDay()];

    // Start at the beginning of the base week (Sunday)
    const weekStart = new Date(baseDateUtc.getTime());
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());

    let safety = 0;
    outerWeekly: while (safety++ < 600) {
      for (const dow of targetDays) {
        const dayDate = new Date(weekStart.getTime());
        dayDate.setUTCDate(weekStart.getUTCDate() + dow);
        if (dayDate.getTime() < baseDateUtc.getTime()) continue;
        const keepGoing = tryPushDate(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, dayDate.getUTCDate());
        if (!keepGoing) break outerWeekly;
      }
      weekStart.setUTCDate(weekStart.getUTCDate() + 7 * rule.interval);
    }
  } else if (rule.freq === 'MONTHLY') {
    let year = startParts.year;
    let month = startParts.month; // 1-12
    let safety = 0;
    outerMonthly: while (safety++ < 300) {
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      let candidateDays = [];

      if (rule.byMonthDay && rule.byMonthDay.length > 0) {
        for (const md of rule.byMonthDay) {
          const d = md > 0 ? md : (daysInMonth + 1 + md);
          if (d >= 1 && d <= daysInMonth) candidateDays.push(d);
        }
      } else if (rule.byDay && rule.byDay.length > 0) {
        for (const tok of rule.byDay) {
          const m = tok.match(/^([+-]?\d+)?([A-Z]{2})$/);
          if (!m) continue;
          const nth = m[1] ? parseInt(m[1], 10) : 0;
          const dow = WEEKDAY_MAP[m[2]];
          if (dow === undefined) continue;
          const matchingDays = [];
          for (let d = 1; d <= daysInMonth; d++) {
            if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === dow) {
              matchingDays.push(d);
            }
          }
          if (nth === 0) {
            candidateDays.push(...matchingDays);
          } else if (nth > 0 && matchingDays[nth - 1]) {
            candidateDays.push(matchingDays[nth - 1]);
          } else if (nth < 0 && matchingDays[matchingDays.length + nth]) {
            candidateDays.push(matchingDays[matchingDays.length + nth]);
          }
        }
      } else {
        candidateDays = [startParts.day];
      }

      candidateDays.sort((a, b) => a - b);
      for (const d of candidateDays) {
        const keepGoing = tryPushDate(year, month, d);
        if (!keepGoing) break outerMonthly;
      }

      month += rule.interval;
      while (month > 12) {
        month -= 12;
        year += 1;
      }
    }
  } else if (rule.freq === 'YEARLY') {
    let year = startParts.year;
    const targetMonths = (rule.byMonth && rule.byMonth.length > 0) ? rule.byMonth : [startParts.month];
    let safety = 0;
    outerYearly: while (safety++ < 100) {
      for (const m of targetMonths) {
        const keepGoing = tryPushDate(year, m, startParts.day);
        if (!keepGoing) break outerYearly;
      }
      year += rule.interval;
    }
  }

  return occurrences;
}

/**
 * Parse full .ics text into calendar metadata + expanded events.
 */
function parseIcsCalendar(icsText, sourceUrl) {
  const lines = unfoldIcsLines(icsText);

  let calName = '';
  let calDesc = '';
  let calTimezone = '';
  const vtimezones = {};
  const rawEvents = [];

  let inVTimezone = false;
  let currentTzId = '';
  let currentTzSub = '';
  let inVEvent = false;
  let inVAlarm = false;
  let currentEvent = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const upper = trimmed.toUpperCase();

    // Handle VALARM inside VEVENT (ignore alarm properties like DESCRIPTION/SUMMARY inside VALARM!)
    if (inVEvent) {
      if (upper === 'BEGIN:VALARM') {
        inVAlarm = true;
        continue;
      }
      if (upper === 'END:VALARM') {
        inVAlarm = false;
        continue;
      }
      if (inVAlarm) continue;
    }

    if (upper === 'BEGIN:VTIMEZONE') {
      inVTimezone = true;
      currentTzId = '';
      currentTzSub = '';
      continue;
    }
    if (upper === 'END:VTIMEZONE') {
      inVTimezone = false;
      currentTzId = '';
      currentTzSub = '';
      continue;
    }

    if (inVTimezone) {
      if (upper === 'BEGIN:STANDARD') {
        currentTzSub = 'STANDARD';
        continue;
      }
      if (upper === 'BEGIN:DAYLIGHT') {
        currentTzSub = 'DAYLIGHT';
        continue;
      }
      if (upper.startsWith('END:')) {
        currentTzSub = '';
        continue;
      }
      const parsed = parseIcsLine(rawLine);
      if (!parsed) continue;
      if (parsed.name === 'TZID') {
        currentTzId = parsed.value.trim();
        if (!vtimezones[currentTzId]) vtimezones[currentTzId] = {};
      } else if (parsed.name === 'TZOFFSETTO' && currentTzId) {
        const mins = parseUtcOffsetMinutes(parsed.value);
        if (currentTzSub === 'DAYLIGHT') {
          vtimezones[currentTzId].daylightOffsetMinutes = mins;
        } else {
          vtimezones[currentTzId].standardOffsetMinutes = mins;
        }
      }
      continue;
    }

    if (upper === 'BEGIN:VEVENT') {
      inVEvent = true;
      inVAlarm = false;
      currentEvent = {
        uid: '',
        summary: '',
        description: '',
        altRepDescription: '',
        location: '',
        url: '',
        status: '',
        organizer: '',
        categories: [],
        sequence: '0',
        dtstartRaw: null,
        dtendRaw: null,
        durationRaw: null,
        createdRaw: null,
        lastModifiedRaw: null,
        dtstampRaw: null,
        recurrenceIdRaw: null,
        rrule: null,
        exdatesRaw: [],
      };
      continue;
    }

    if (upper === 'END:VEVENT') {
      if (currentEvent) {
        rawEvents.push(currentEvent);
      }
      inVEvent = false;
      currentEvent = null;
      continue;
    }

    const parsed = parseIcsLine(rawLine);
    if (!parsed) continue;

    if (!inVEvent) {
      if (parsed.name === 'X-WR-CALNAME') calName = unescapeIcsText(parsed.value);
      else if (parsed.name === 'X-WR-CALDESC') calDesc = unescapeIcsText(parsed.value);
      else if (parsed.name === 'X-WR-TIMEZONE') calTimezone = unescapeIcsText(parsed.value);
      continue;
    }

    // Inside VEVENT
    switch (parsed.name) {
      case 'UID':
        currentEvent.uid = unescapeIcsText(parsed.value);
        break;
      case 'SUMMARY':
        currentEvent.summary = unescapeIcsText(parsed.value);
        break;
      case 'DESCRIPTION':
        currentEvent.description = unescapeIcsText(parsed.value);
        break;
      case 'X-ALT-DESC':
        if (! parsed.params.FMTTYPE || parsed.params.FMTTYPE.toLowerCase().includes('html')) {
          currentEvent.altRepDescription = unescapeIcsText(parsed.value);
        }
        break;
      case 'LOCATION':
        currentEvent.location = unescapeIcsText(parsed.value);
        break;
      case 'URL':
        currentEvent.url = unescapeIcsText(parsed.value);
        break;
      case 'STATUS':
        currentEvent.status = unescapeIcsText(parsed.value).toUpperCase();
        break;
      case 'SEQUENCE':
        currentEvent.sequence = unescapeIcsText(parsed.value);
        break;
      case 'ORGANIZER': {
        const cn = parsed.params.CN ? unescapeIcsText(parsed.params.CN) : '';
        const mail = unescapeIcsText(parsed.value).replace(/^mailto:/i, '');
        currentEvent.organizer = cn || mail;
        break;
      }
      case 'CATEGORIES': {
        const cats = parsed.value.split(',').map((c) => unescapeIcsText(c)).filter(Boolean);
        currentEvent.categories.push(...cats);
        break;
      }
      case 'DTSTART':
        currentEvent.dtstartRaw = parsed;
        break;
      case 'DTEND':
        currentEvent.dtendRaw = parsed;
        break;
      case 'DURATION':
        currentEvent.durationRaw = parsed.value;
        break;
      case 'CREATED':
        currentEvent.createdRaw = parsed;
        break;
      case 'LAST-MODIFIED':
        currentEvent.lastModifiedRaw = parsed;
        break;
      case 'DTSTAMP':
        currentEvent.dtstampRaw = parsed;
        break;
      case 'RECURRENCE-ID':
        currentEvent.recurrenceIdRaw = parsed;
        break;
      case 'RRULE':
        currentEvent.rrule = parsed.value;
        break;
      case 'EXDATE': {
        const vals = parsed.value.split(',').map((v) => v.trim()).filter(Boolean);
        for (const v of vals) {
          currentEvent.exdatesRaw.push({ value: v, params: parsed.params });
        }
        break;
      }
      default:
        break;
    }
  }

  // Convert raw VEVENTs into structured event objects
  const parsedEvents = [];
  for (const raw of rawEvents) {
    if (raw.status === 'CANCELLED') continue;
    if (!raw.dtstartRaw) continue;

    const start = parseIcsDateValue(raw.dtstartRaw.value, raw.dtstartRaw.params, vtimezones, calTimezone);
    if (!start || isNaN(start.date.getTime())) continue;

    let end = raw.dtendRaw
      ? parseIcsDateValue(raw.dtendRaw.value, raw.dtendRaw.params, vtimezones, calTimezone)
      : null;
    const durationMs = raw.durationRaw ? parseIcsDurationMs(raw.durationRaw) : 0;
    if (!end && durationMs > 0) {
      end = {
        date: new Date(start.date.getTime() + durationMs),
        isAllDay: start.isAllDay,
      };
    } else if (!end) {
      end = {
        date: new Date(start.date.getTime() + (start.isAllDay ? 86400000 : 3600000)),
        isAllDay: start.isAllDay,
      };
    }

    const created = raw.createdRaw
      ? parseIcsDateValue(raw.createdRaw.value, raw.createdRaw.params, vtimezones, calTimezone)?.date
      : null;
    const lastModified = raw.lastModifiedRaw
      ? parseIcsDateValue(raw.lastModifiedRaw.value, raw.lastModifiedRaw.params, vtimezones, calTimezone)?.date
      : null;
    const recurrenceId = raw.recurrenceIdRaw
      ? parseIcsDateValue(raw.recurrenceIdRaw.value, raw.recurrenceIdRaw.params, vtimezones, calTimezone)
      : null;
    const exdates = raw.exdatesRaw
      .map((ex) => parseIcsDateValue(ex.value, ex.params, vtimezones, calTimezone))
      .filter(Boolean);

    parsedEvents.push({
      uid: raw.uid || `${start.dateKey}-${ raw.summary || 'event' }`,
      summary: raw.summary || '(Untitled Event)',
      description: raw.description || '',
      altRepDescription: raw.altRepDescription || '',
      location: raw.location || '',
      url: raw.url || '',
      status: raw.status || 'CONFIRMED',
      organizer: raw.organizer || '',
      categories: raw.categories || [],
      sequence: raw.sequence || '0',
      start,
      end,
      durationMs,
      created,
      lastModified,
      recurrenceId,
      rrule: raw.rrule,
      exdates,
      recurrenceKey: recurrenceId ? recurrenceId.dateKey : start.dateKey,
    });
  }

  // Separate RECURRENCE-ID overrides from base events
  const overrideMap = new Map();
  const baseEvents = [];
  for (const ev of parsedEvents) {
    if (ev.recurrenceId) {
      overrideMap.set(`${ev.uid}::${ev.recurrenceId.dateKey}`, ev);
    } else {
      baseEvents.push(ev);
    }
  }

  // Expand recurring events within a generous window:
  // 45 days in the past to 180 days in the future
  const now = new Date();
  const windowStart = new Date(now.getTime() - 45 * 86400 * 1000);
  const windowEnd = new Date(now.getTime() + 180 * 86400 * 1000);

  const allOccurrences = [];
  for (const ev of baseEvents) {
    if (ev.rrule) {
      const expanded = expandRecurringEvent(ev, windowStart, windowEnd, vtimezones, calTimezone);
      for (const occ of expanded) {
        const overrideKey = `${occ.uid}::${occ.recurrenceKey}`;
        if (overrideMap.has(overrideKey)) {
          allOccurrences.push(overrideMap.get(overrideKey));
          overrideMap.delete(overrideKey);
        } else {
          allOccurrences.push(occ);
        }
      }
    } else {
      allOccurrences.push(ev);
    }
  }

  // Add any remaining overrides whose parent wasn't in baseEvents
  for (const overrideEv of overrideMap.values()) {
    allOccurrences.push(overrideEv);
  }

  // Filter to active window [windowStart, windowEnd], unless doing so would yield 0 events
  // (e.g., an archive calendar with only past or far-future events)
  let selectedEvents = allOccurrences.filter(
    (ev) => ev.end.date.getTime() >= windowStart.getTime() && ev.start.date.getTime() <= windowEnd.getTime()
  );

  if (selectedEvents.length === 0 && allOccurrences.length > 0) {
    // Fallback: sort by closeness to now and take up to 40
    selectedEvents = [...allOccurrences]
      .sort((a, b) => Math.abs(a.start.date.getTime() - now.getTime()) - Math.abs(b.start.date.getTime() - now.getTime()))
      .slice(0, 40);
  }

  // Sort events for the RSS feed:
  // Upcoming/ongoing events first (soonest upcoming first), followed by recent past events (most recent first)
  const nowMs = now.getTime();
  const upcoming = selectedEvents
    .filter((ev) => ev.end.date.getTime() >= nowMs)
    .sort((a, b) => a.start.date.getTime() - b.start.date.getTime());
  const recentPast = selectedEvents
    .filter((ev) => ev.end.date.getTime() < nowMs)
    .sort((a, b) => b.start.date.getTime() - a.start.date.getTime());

  const orderedEvents = [...upcoming.slice(0, 40), ...recentPast.slice(0, 15)].slice(0, 50);

  return {
    calName,
    calDesc,
    calTimezone,
    events: orderedEvents,
    totalParsedCount: allOccurrences.length,
    sourceUrl,
  };
}

// ── Event Formatting for FreshRSS ─────────────────────────────────────────

function formatEventDateForTitle(start, end) {
  const d = start.date;
  const datePart = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (start.isAllDay) {
    // Check if multi-day all-day event (DTEND in ICS is exclusive for DATE values)
    const diffDays = Math.round((end.date.getTime() - start.date.getTime()) / 86400000);
    if (diffDays > 1) {
      const inclusiveEnd = new Date(end.date.getTime() - 86400000);
      const endPart = inclusiveEnd.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      return `${datePart} – ${endPart} (All day)`;
    }
    return `${datePart} (All day)`;
  }

  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}

function formatEventDateRangeFull(start, end) {
  const s = start.date;
  const e = end.date;

  const startDateStr = s.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  if (start.isAllDay) {
    const diffDays = Math.round((e.getTime() - s.getTime()) / 86400000);
    if (diffDays > 1) {
      const inclusiveEnd = new Date(e.getTime() - 86400000);
      const endDateStr = inclusiveEnd.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      return `${startDateStr} – ${endDateStr} (All day, ${diffDays} days)`;
    }
    return `${startDateStr} (All day)`;
  }

  const startTimeStr = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const endTimeStr = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();

  if (sameDay) {
    return `${startDateStr}, ${startTimeStr} – ${endTimeStr}`;
  }

  const endDateStr = e.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${startDateStr}, ${startTimeStr} – ${endDateStr}, ${endTimeStr}`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDescriptionHtml(rawDesc) {
  if (!rawDesc) return '';
  const trimmed = rawDesc.trim();
  if (!trimmed) return '';

  // Google Calendar & Outlook sometimes embed basic HTML tags (<a href=...>, <br>, <p>, <b>, <ul>, <li>) in DESCRIPTION
  const looksLikeHtml = /<(?:a|br|p|div|ul|ol|li|b|strong|i|em|span)\b[^>]*>/i.test(trimmed);
  if (looksLikeHtml) {
    // Strip any script/style/iframe tags for safety while keeping clean formatting
    return trimmed
      .replace(/<(?:script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi, '')
      .replace(/\r?\n/g, '<br/>');
  }

  // Plain text: escape HTML and linkify URLs
  const escaped = escapeHtml(trimmed);
  const linkified = escaped.replace(
    /(https?:\/\/[^\s<]+)/gi,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
  );
  return linkified.replace(/\r?\n/g, '<br/>');
}

/**
 * Load existing firstSeenMap from `<feedKey>.data.json` so event discovery timestamps
 * stay stable across feed refreshes.
 */
function loadExistingFirstSeenMap(feedDir, feedKey) {
  const map = {};
  if (!feedDir || !feedKey) return map;
  try {
    const dataPath = path.join(feedDir, `${feedKey}.data.json`);
    if (fs.existsSync(dataPath)) {
      const saved = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      if (saved && saved.eventFirstSeenMap && typeof saved.eventFirstSeenMap === 'object') {
        Object.assign(map, saved.eventFirstSeenMap);
      }
      if (saved && Array.isArray(saved.posts)) {
        for (const p of saved.posts) {
          if (p.id && p.timestamp && !map[p.id]) {
            map[p.id] = p.timestamp;
          }
        }
      }
    }
  } catch (_) {}
  return map;
}

/**
 * Main scraper entry point for Calendar feeds.
 */
async function scrapeCalendar(feedOrInput, options = {}) {
  const parsed = parseCalendarInput(feedOrInput, { forceCalendar: true });
  if (!parsed) {
    throw new Error('Invalid calendar URL or .ics file');
  }

  const fullUrl = parsed.fullUrl;
  const siteUrl = parsed.siteUrl || fullUrl;
  const icsText = await fetchCalendarIcs(fullUrl);
  const calData = parseIcsCalendar(icsText, fullUrl);

  const feedKey = (parsed.feedKey || parsed.username || 'calendar').replace(/[^a-zA-Z0-9_-]/g, '-');
  const firstSeenMap = loadExistingFirstSeenMap(options.feedDir, feedKey);
  const nextFirstSeenMap = { ...firstSeenMap };

  const nowMs = Date.now();
  const thirtyDaysAgoMs = nowMs - 30 * 86400 * 1000;

  const posts = calData.events.map((ev) => {
    const dateLabelShort = formatEventDateForTitle(ev.start, ev.end);
    const dateRangeFull = formatEventDateRangeFull(ev.start, ev.end);

    // Content fingerprint so if an event is rescheduled or its location/title changes,
    // FreshRSS receives the updated item
    const fingerprint = crypto
      .createHash('sha1')
      .update(`${ev.summary}|${ev.start.date.toISOString()}|${ev.end.date.toISOString()}|${ev.location}|${ev.status}`)
      .digest('hex')
      .slice(0, 8);

    const safeUid = String(ev.uid).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    const itemId = `cal-${safeUid}-${ev.recurrenceKey}-${fingerprint}`;

    // Determine stable RSS <pubDate> (timestamp) suitable for FreshRSS:
    // - Never in the future (so FreshRSS doesn't pin future events above today's unread items)
    // - Never older than 30 days for upcoming events (so FreshRSS doesn't reject recurring series created years ago)
    // - 100% stable across refreshes via firstSeenMap
    let itemTimestamp;
    if (firstSeenMap[itemId]) {
      itemTimestamp = firstSeenMap[itemId];
    } else {
      const modDate = ev.lastModified || ev.created;
      const modMs = modDate && !isNaN(modDate.getTime()) ? modDate.getTime() : 0;
      const startMs = ev.start.date.getTime();

      if (startMs <= nowMs) {
        // Past or currently ongoing event: use the later of start time or modification time (capped at now)
        const bestMs = Math.min(nowMs, Math.max(startMs, modMs));
        itemTimestamp = new Date(bestMs).toISOString();
      } else {
        // Upcoming event in the future:
        // If created/modified within the last 30 days (and <= now), use that creation/modification time;
        // otherwise use current discovery time (and persist it in firstSeenMap so it never changes on refresh!)
        if (modMs >= thirtyDaysAgoMs && modMs <= nowMs) {
          itemTimestamp = new Date(modMs).toISOString();
        } else {
          itemTimestamp = new Date(nowMs).toISOString();
        }
      }
      nextFirstSeenMap[itemId] = itemTimestamp;
    }

    const title = `📅 ${ev.summary} — ${dateLabelShort}`;

    // Build plain-text caption for description preview
    const captionLines = [`🗓️ When: ${dateRangeFull}`];
    if (ev.location) captionLines.push(`📍 Where: ${ev.location}`);
    if (ev.organizer) captionLines.push(`👤 Organizer: ${ev.organizer}`);
    if (ev.description) captionLines.push('', ev.description);
    const caption = captionLines.join('\n');

    // Build rich HTML content for FreshRSS
    const htmlParts = [];
    htmlParts.push(`<p><strong>🗓️ When:</strong> ${escapeHtml(dateRangeFull)}</p>`);

    if (ev.location) {
      const isUrlLoc = /^https?:\/\//i.test(ev.location.trim());
      const locHtml = isUrlLoc
        ? `<a href="${escapeHtml(ev.location.trim())}" target="_blank" rel="noopener">${escapeHtml(ev.location.trim())}</a>`
        : `${escapeHtml(ev.location)} (<a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">Map</a>)`;
      htmlParts.push(`<p><strong>📍 Where:</strong> ${locHtml}</p>`);
    }

    if (ev.isRecurringInstance && ev.recurrenceFreq) {
      const freqLabel = ev.recurrenceFreq.charAt(0) + ev.recurrenceFreq.slice(1).toLowerCase();
      htmlParts.push(`<p><strong>🔁 Repeats:</strong> ${escapeHtml(freqLabel)}</p>`);
    }

    if (ev.organizer) {
      htmlParts.push(`<p><strong>👤 Organizer:</strong> ${escapeHtml(ev.organizer)}</p>`);
    }

    if (ev.categories && ev.categories.length > 0) {
      htmlParts.push(`<p><strong>🏷️ Categories:</strong> ${escapeHtml(ev.categories.join(', '))}</p>`);
    }

    if (ev.status && ev.status !== 'CONFIRMED') {
      htmlParts.push(`<p><strong>ℹ️ Status:</strong> ${escapeHtml(ev.status)}</p>`);
    }

    const descHtml = formatDescriptionHtml(ev.description);
    if (descHtml) {
      htmlParts.push(`<hr style="border:none;border-top:1px solid rgba(128,128,128,0.25);margin:12px 0;" />`);
      htmlParts.push(`<div>${descHtml}</div>`);
    }

    const baseLink = ev.url && /^https?:\/\//i.test(ev.url) ? ev.url : siteUrl;
    const permalink = baseLink.includes('#')
      ? `${baseLink}&event=${encodeURIComponent( itemId )}`
      : `${baseLink}#${encodeURIComponent( itemId )}`;

    if (ev.url && /^https?:\/\//i.test(ev.url)) {
      htmlParts.push(`<p><a href="${escapeHtml(ev.url)}" target="_blank" rel="noopener">🔗 Open Event Link</a></p>`);
    }

    return {
      id: itemId,
      title,
      caption,
      contentHtml: htmlParts.join('\n'),
      timestamp: itemTimestamp,
      timestampEstimated: false,
      eventStart: ev.start.date.toISOString(),
      eventEnd: ev.end.date.toISOString(),
      permalink,
      externalUrl: ev.url || '',
      imageUrl: '',
      isVideo: false,
      videoUrl: '',
      likes: 0,
      comments: 0,
    };
  });

  const displayFullName = calData.calName || parsed.alias || parsed.calendarProviderLabel || 'Calendar';
  const displayBio = calData.calDesc || `${parsed.calendarProviderLabel || 'Calendar'} feed (${ displayFullName })`;

  return {
    username: parsed.username,
    fullName: displayFullName,
    biography: displayBio,
    fullUrl,
    siteUrl,
    calendarProvider: parsed.calendarProvider || 'ics',
    calendarProviderLabel: parsed.calendarProviderLabel || 'Calendar',
    eventFirstSeenMap: nextFirstSeenMap,
    posts,
  };
}

module.exports = {
  parseCalendarInput,
  scrapeCalendar,
  parseIcsCalendar,
};

