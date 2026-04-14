/**
 * Optional public/LAN base URL for feed self-links and discovery URLs.
 * When unset, callers use http://localhost:<serverPort> (legacy behaviour).
 */

function normalizeFeedPublicBaseUrlInput(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  let candidate = s.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const u = new URL(candidate);
    if (!u.host) return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function resolveFeedBaseUrl(store) {
  const port = store.get('serverPort');
  const custom = normalizeFeedPublicBaseUrlInput(store.get('feedPublicBaseUrl') || '');
  if (!custom) return `http://localhost:${port}`;
  return custom;
}

module.exports = { normalizeFeedPublicBaseUrlInput, resolveFeedBaseUrl };
