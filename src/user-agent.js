/**
 * Returns a realistic Chrome desktop User-Agent string tailored to the host OS.
 * Avoids default Electron tokens ("Electron/...", "UnSocial/...") which trigger
 * bot detection and security checkpoints on Meta (Facebook, Instagram), Twitter/X, and LinkedIn.
 */
function getRealisticUserAgent() {
  // Use the actual underlying Chromium version of this Electron build so that
  // the User-Agent string exactly matches Chromium's native Sec-CH-UA client hints
  // (e.g. Chrome/144.0.7559.134), preventing Cloudflare Turnstile mismatch detection.
  const chromeVersion = (process.versions && process.versions.chrome) || '144.0.7559.134';
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  } else if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  } else {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
}

module.exports = { getRealisticUserAgent };
