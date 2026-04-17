const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Tailscale Funnel provider.
 *
 * Uses `tailscale funnel` to expose the local feed server on a public URL of
 * the form `https://<machine>.<tailnet>.ts.net`. No domain config required:
 * Tailscale auto-assigns a hostname based on your tailnet.
 *
 * Prerequisites (one-time setup by the user):
 *   1. Install Tailscale: https://tailscale.com/download
 *   2. Run `tailscale up` (or log in via the GUI).
 *   3. Enable Funnel + HTTPS for the tailnet at https://login.tailscale.com
 *      (Admin console → DNS / ACLs: grant `funnel` to this device).
 *   4. This app will run `tailscale funnel --bg <port>` to expose the feed server.
 *
 * The state lives in the Tailscale daemon, not in a subprocess: `--bg` makes
 * Funnel persist across reboots until `tailscale funnel reset` is called.
 */

let tunnelStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
let tunnelLog = [];
let statusCallback = null;
let pollTimer = null;
const MAX_LOG_LINES = 200;

let _resolvedPath = null;

/**
 * Find the tailscale executable. The Windows installer doesn't always add the
 * CLI to PATH for GUI apps, so we probe common install locations.
 */
function getTailscalePath() {
  if (_resolvedPath) return _resolvedPath;

  if (process.platform === 'win32') {
    const candidates = [
      path.join('C:', 'Program Files', 'Tailscale', 'tailscale.exe'),
      path.join('C:', 'Program Files (x86)', 'Tailscale', 'tailscale.exe'),
      path.join(process.env.ProgramFiles || '', 'Tailscale', 'tailscale.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
      path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'tailscale.exe'),
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          _resolvedPath = p;
          return p;
        }
      } catch (_) {}
    }
    _resolvedPath = 'tailscale';
    return 'tailscale';
  }

  // macOS / Linux — the CLI is usually on PATH
  const unixCandidates = [
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const p of unixCandidates) {
    try {
      if (fs.existsSync(p)) {
        _resolvedPath = p;
        return p;
      }
    } catch (_) {}
  }
  _resolvedPath = 'tailscale';
  return 'tailscale';
}

/**
 * Run a tailscale command, returning stdout+stderr and exit code.
 */
function runCommand(args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let output = '';
    let proc;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { if (proc && !proc.killed) proc.kill(); } catch (_) {}
      resolve(result);
    };
    try {
      proc = spawn(getTailscalePath(), args);
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => finish({ success: code === 0, output: output.trim(), code }));
      proc.on('error', (err) => finish({ success: false, output: err.message, code: -1 }));
      setTimeout(() => finish({ success: false, output: output.trim() || 'timeout', code: -1 }), timeoutMs);
    } catch (err) {
      finish({ success: false, output: err.message, code: -1 });
    }
  });
}

/**
 * Check if tailscale CLI is installed.
 */
async function checkInstalled() {
  _resolvedPath = null;
  const r = await runCommand(['version']);
  return {
    installed: r.success,
    version: (r.output.split('\n')[0] || '').trim(),
  };
}

/**
 * Parse `tailscale status --json` safely.
 */
async function getStatusJson() {
  const r = await runCommand(['status', '--json']);
  if (!r.success) return null;
  try {
    return JSON.parse(r.output);
  } catch {
    return null;
  }
}

/**
 * Check if this node is logged in and online.
 */
async function checkAuthenticated() {
  const status = await getStatusJson();
  if (!status) return false;
  // Backend states we accept as "logged in": Running, Starting.
  const state = status.BackendState || '';
  if (state === 'NeedsLogin' || state === 'NoState' || state === 'Stopped') return false;
  return !!status.Self;
}

/**
 * Derive the tailnet hostname (e.g. "box.tail1234.ts.net") for this node.
 */
async function getHostname() {
  const status = await getStatusJson();
  if (!status || !status.Self) return '';
  const dns = status.Self.DNSName || '';
  return dns.replace(/\.$/, '');
}

/**
 * Check Funnel setup: node must be able to use funnel (policy grants it) and
 * the tailnet must have HTTPS enabled. We do this indirectly by running
 * `tailscale funnel status`: it will error on misconfigured tailnets.
 */
async function checkSetup(store) {
  const hostname = await getHostname();
  const r = await runCommand(['funnel', 'status']);
  // A healthy tailnet returns exit 0 even when no funnels are configured.
  // Unhealthy ones print an error like "HTTPS must be enabled" or
  // "Funnel is not allowed by the tailnet policy".
  const output = r.output || '';
  const ready = r.success && !/must be enabled|not allowed|not configured/i.test(output);
  return {
    exists: !!hostname && ready,
    hostname,
    output,
  };
}

/**
 * Is funnel currently forwarding our feed-server port?
 */
async function isFunnelActive(store) {
  const port = store.get('serverPort');
  const r = await runCommand(['funnel', 'status']);
  if (!r.success) return false;
  // Look for "http://127.0.0.1:<port>" or "http://localhost:<port>" in the
  // funnel status output. The status output lists active forwards per host.
  const re = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`);
  return re.test(r.output || '');
}

/**
 * Wizard steps for Tailscale. Most setup is done in the admin console, but we
 * can run `tailscale login` (and `up`) from here.
 */
function runWizardStep(step, _store) {
  switch (step) {
    case 'login':
      // `tailscale login` opens a browser and waits for auth. On Windows the
      // CLI defers to the GUI; on Linux/Mac it prints a URL.
      return runCommand(['login'], { timeoutMs: 5 * 60 * 1000 });
    case 'up':
      return runCommand(['up'], { timeoutMs: 5 * 60 * 1000 });
    case 'status':
      return runCommand(['status']);
    default:
      return Promise.resolve({ success: false, output: `Unknown setup step: ${step}` });
  }
}

/**
 * A pass-through for advanced callers who want to run raw tailscale commands.
 */
function runSetupCommand(args) {
  return runCommand(args);
}

/**
 * Start Funnel: `tailscale funnel --bg <port>`.
 *
 * Unlike cloudflared there's no long-running child process to manage — the
 * command just reconfigures the tailscaled daemon and returns. We then poll
 * `funnel status` to reflect "running" in the UI.
 */
async function startTunnel(store) {
  const port = store.get('serverPort');
  setStatus('starting');
  tunnelLog = [];
  appendLog(`[tailscale] funnel --bg ${port}`);

  // Reset any stale funnel config first so we don't pile up forwards across
  // port changes. This mirrors cloudflared's "cleanup" step.
  const reset = await runCommand(['funnel', 'reset']);
  if (reset.output) appendLog(`[reset] ${reset.output}`);

  const r = await runCommand(['funnel', '--bg', String(port)], { timeoutMs: 30000 });
  appendLog(r.output || (r.success ? 'Funnel started' : 'Funnel failed'));

  if (!r.success) {
    setStatus('error');
    return { status: tunnelStatus, error: r.output };
  }

  // Give tailscaled a moment to publish the forward and the tailnet DNS
  // record, then verify.
  startPolling(store);
  return { status: tunnelStatus };
}

/**
 * Stop Funnel by clearing all funnel configuration for this node.
 */
async function stopTunnel() {
  stopPolling();
  const r = await runCommand(['funnel', 'reset']);
  appendLog(r.output || 'Funnel reset');
  setStatus('stopped');
}

/**
 * No-op: Tailscale Funnel state lives in the daemon, there are no orphaned
 * processes to clean up.
 */
function killOrphaned() {
  /* intentionally empty */
}

/**
 * Start polling `funnel status` to detect when the funnel actually becomes
 * reachable (and to notice manual changes made outside the app).
 */
function startPolling(store) {
  stopPolling();
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts += 1;
    const active = await isFunnelActive(store);
    if (active) {
      setStatus('running');
      // Keep polling at a slower cadence to catch outside changes
      if (attempts < 9999) {
        clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          const stillActive = await isFunnelActive(store);
          if (!stillActive) {
            setStatus('stopped');
            stopPolling();
          }
        }, 15000);
      }
    } else if (attempts > 30) {
      // 30 * 1s = 30s with no success → treat as error
      setStatus('error');
      stopPolling();
    }
  }, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function getPublicUrl(store) {
  const hostname = await getHostname();
  return hostname ? `https://${hostname}` : '';
}

/**
 * Tunnel state for the UI. The `domain` field is populated from the tailnet
 * hostname so the renderer can reuse the same URL-rendering code for both
 * providers.
 */
async function getTunnelState(store) {
  const hostname = await getHostname();
  const publicUrl = hostname ? `https://${hostname}` : '';
  return {
    status: tunnelStatus,
    domain: hostname,
    publicUrl,
    log: tunnelLog.slice(-50),
  };
}

function setStatus(s) {
  tunnelStatus = s;
  if (statusCallback) statusCallback({ status: s });
}

function appendLog(line) {
  if (!line) return;
  tunnelLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (tunnelLog.length > MAX_LOG_LINES) {
    tunnelLog = tunnelLog.slice(-MAX_LOG_LINES);
  }
}

function onStatusChange(cb) {
  statusCallback = cb;
}

module.exports = {
  id: 'tailscale',
  checkInstalled,
  checkAuthenticated,
  checkSetup,
  runSetupCommand,
  runWizardStep,
  startTunnel,
  stopTunnel,
  killOrphaned,
  getPublicUrl,
  getTunnelState,
  onStatusChange,
};
