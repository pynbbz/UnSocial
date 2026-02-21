/**
 * Shared input parsing utilities.
 * Used by both the Electron desktop app (main.js) and the headless Docker entry (headless.js).
 */

function parseProfileInput(input) {
  input = input.trim().replace(/\/+$/, '');

  // Facebook group URL: https://www.facebook.com/groups/groupname
  const fbGroupMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(groups\/[a-zA-Z0-9._-]+)(?:\/(events|discussion|members|about|media|buy_sell_discussion))?/
  );
  if (fbGroupMatch) {
    const groupPath = fbGroupMatch[1];
    const subTab = fbGroupMatch[2] || null;
    return { username: groupPath, platform: 'facebook', subTab };
  }

  // Facebook "My Events" page
  const fbMyEventsMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/events\/?(?:\?.*)?$/
  );
  if (fbMyEventsMatch) {
    const fullUrl = input.startsWith('http') ? input : 'https://www.facebook.com/events/';
    return { username: 'events', platform: 'facebook', subTab: 'my_events', fullUrl };
  }

  // Facebook event URL: https://www.facebook.com/events/123456789
  const fbEventMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(events\/[a-zA-Z0-9._-]+)/
  );
  if (fbEventMatch) return { username: fbEventMatch[1], platform: 'facebook' };

  // Facebook page URL: https://www.facebook.com/pagename
  const fbMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]+)/
  );
  if (fbMatch) {
    const page = fbMatch[1];
    if (['login', 'groups', 'events', 'watch', 'marketplace', 'gaming', 'pages', 'profile.php'].includes(page)) return null;
    return { username: page, platform: 'facebook' };
  }

  // Twitter / X URL: https://x.com/username or https://twitter.com/username
  const twitterMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?(x|twitter)\.com\/([a-zA-Z0-9_]+)/
  );
  if (twitterMatch) {
    const user = twitterMatch[2];
    if (['i', 'home', 'explore', 'search', 'settings', 'messages'].includes(user)) return null;
    return { username: user, platform: 'twitter' };
  }

  // LinkedIn profile URL: https://www.linkedin.com/in/username/
  const liProfileMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9._-]+)/
  );
  if (liProfileMatch) return { username: liProfileMatch[1], platform: 'linkedin' };

  // LinkedIn company URL: https://www.linkedin.com/company/companyname/
  const liCompanyMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(company\/[a-zA-Z0-9._-]+)/
  );
  if (liCompanyMatch) return { username: liCompanyMatch[1], platform: 'linkedin' };

  // Instagram URL: https://www.instagram.com/username/
  const igMatch = input.match(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/
  );
  if (igMatch) return { username: igMatch[1], platform: 'instagram' };

  // .txt URL — any http(s) URL ending in .txt
  const txtMatch = input.match(/^(https?:\/\/.+\.txt)$/i);
  if (txtMatch) {
    const fullUrl = txtMatch[1];
    let fileName;
    try {
      const u = new URL(fullUrl);
      const pathParts = u.pathname.split('/').filter(Boolean);
      fileName = (pathParts.pop() || 'feed').replace(/\.txt$/i, '');
      const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
      fileName = `${host}-${fileName}`;
    } catch (_) {
      fileName = 'txt-feed';
    }
    return { username: fileName, platform: 'txt', fullUrl };
  }

  // Bare @username or username — default to Instagram
  const bare = input.replace(/^@/, '');
  if (/^[a-zA-Z0-9._]{1,30}$/.test(bare)) return { username: bare, platform: 'instagram' };

  // Any other URL — treat as custom website
  const anyUrlMatch = input.match(/^(https?:\/\/.+)/i) || input.match(/^([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}\/.+)/i);
  if (anyUrlMatch) {
    const fullUrl = anyUrlMatch[1].startsWith('http') ? anyUrlMatch[1] : 'https://' + anyUrlMatch[1];
    let siteName;
    try {
      const u = new URL(fullUrl);
      const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
      const pathSlug = u.pathname.replace(/^\/|\/$|\.[^.]+$/g, '').replace(/\//g, '-') || '';
      siteName = pathSlug ? `${host}-${pathSlug}` : host;
    } catch (_) {
      siteName = 'custom-feed';
    }
    return { username: siteName, platform: 'custom', fullUrl };
  }

  return null;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { parseProfileInput, escapeXml };
