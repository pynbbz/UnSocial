/**
 * Returns a realistic Chrome desktop User-Agent string tailored to the host OS.
 * Avoids default Electron tokens ("Electron/...", "UnSocial/...") which trigger
 * bot detection and security checkpoints on Meta (Facebook, Instagram), Twitter/X, and LinkedIn.
 */
function getRealisticUserAgent() {
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  } else if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  } else {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
}

module.exports = { getRealisticUserAgent };
