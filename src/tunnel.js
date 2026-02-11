const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Manages a Cloudflare Tunnel (`cloudflared`) process that exposes the
 * local RSS feed server to the internet via a custom domain.
 *
 * Prerequisites (one-time setup by the user):
 *   1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 *   2. Run:  cloudflared tunnel login
 *   3. Run:  cloudflared tunnel create <tunnel-name>
 *   4. Add DNS route:  cloudflared tunnel route dns <tunnel-name> <your-domain>
 *   5. The app handles config file creation and running the tunnel.
 */

let tunnelProcess = null;
let tunnelStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
let tunnelLog = [];
let statusCallback = null;
const MAX_LOG_LINES = 200;

// Cache resolved path
let _resolvedCloudflaredPath = null;

/**
 * Find the cloudflared executable. Electron GUI apps on Windows often don't
 * inherit PATH changes made after boot, so we check known install locations.
 */
function getCloudflaredPath() {
  if (_resolvedCloudflaredPath) return _resolvedCloudflaredPath;

  const candidates = [
    // Common install locations on Windows
    path.join('C:', 'Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    path.join('C:', 'Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', '.cloudflared', 'cloudflared.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
    // Scoop / Chocolatey / winget
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'cloudflared.exe'),
    path.join('C:', 'ProgramData', 'chocolatey', 'bin', 'cloudflared.exe'),
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        _resolvedCloudflaredPath = `"${p}"`;
        return _resolvedCloudflaredPath;
      }
    } catch (_) {}
  }

  // Fallback: hope it's on PATH (works if user restarts the app after PATH edit)
  _resolvedCloudflaredPath = 'cloudflared';
  return 'cloudflared';
}

function getTunnelConfigDir() {
  return path.join(app.getPath('userData'), 'cloudflared');
}

function getTunnelConfigPath() {
  return path.join(getTunnelConfigDir(), 'config.yml');
}

/**
 * Write the cloudflared config file based on the user's settings.
 */
function writeTunnelConfig(store) {
  const configDir = getTunnelConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const domain = store.get('tunnelDomain');
  const tunnelName = store.get('tunnelName');
  const port = store.get('serverPort');

  // Find the credentials file — cloudflared stores it in its default config dir
  const defaultCloudflaredDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cloudflared'
  );

  // Look for credentials JSON file matching tunnel name
  let credentialsFile = '';
  if (fs.existsSync(defaultCloudflaredDir)) {
    const files = fs.readdirSync(defaultCloudflaredDir);
    const credFile = files.find(
      (f) => f.endsWith('.json') && f !== 'cert.pem'
    );
    if (credFile) {
      credentialsFile = path.join(defaultCloudflaredDir, credFile);
    }
  }

  const config = [
    `tunnel: ${tunnelName}`,
    credentialsFile ? `credentials-file: ${credentialsFile}` : `# credentials-file: <auto-detected>`,
    `protocol: http2`,
    '',
    'ingress:',
    `  - hostname: ${domain}`,
    `    service: http://localhost:${port}`,
    '  - service: http_status:404',
    '',
  ].join('\n');

  fs.writeFileSync(getTunnelConfigPath(), config, 'utf-8');
  return getTunnelConfigPath();
}

/**
 * Check if cloudflared is installed and accessible.
 */
async function checkCloudflaredInstalled() {
  // Reset cached path so we re-scan each time the user clicks check
  _resolvedCloudflaredPath = null;
  const exe = getCloudflaredPath();
  return new Promise((resolve) => {
    try {
      const proc = spawn(exe, ['version'], { shell: true });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => {
        resolve({
          installed: code === 0,
          version: output.trim().split('\n')[0] || '',
        });
      });
      proc.on('error', () => resolve({ installed: false, version: '' }));
    } catch {
      resolve({ installed: false, version: '' });
    }
  });
}

/**
 * Check if cloudflared has been authenticated (cert.pem exists).
 */
function checkAuthenticated() {
  const defaultDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cloudflared'
  );
  const certPath = path.join(defaultDir, 'cert.pem');
  return fs.existsSync(certPath);
}

/**
 * Check if the tunnel has been created and authenticated.
 */
async function checkTunnelSetup(store) {
  const tunnelName = store.get('tunnelName');
  return new Promise((resolve) => {
    try {
      const proc = spawn(getCloudflaredPath(), ['tunnel', 'list', '-o', 'json'], {
        shell: true,
      });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      proc.on('close', () => {
        try {
          const tunnels = JSON.parse(output);
          const found = tunnels.find(
            (t) => t.name === tunnelName && !t.deleted_at
          );
          resolve({ exists: !!found, tunnelId: found?.id || '' });
        } catch {
          resolve({ exists: false, tunnelId: '' });
        }
      });
      proc.on('error', () => resolve({ exists: false, tunnelId: '' }));
    } catch {
      resolve({ exists: false, tunnelId: '' });
    }
  });
}

/**
 * Run a one-time setup command (tunnel login, create, route dns).
 * Returns { success, output }.
 */
function runSetupCommand(args) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(getCloudflaredPath(), args, { shell: true });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      proc.on('close', (code) => {
        resolve({ success: code === 0, output: output.trim() });
      });
      proc.on('error', (err) => {
        resolve({ success: false, output: err.message });
      });
    } catch (err) {
      resolve({ success: false, output: err.message });
    }
  });
}

/**
 * Start the Cloudflare Tunnel.
 */
function startTunnel(store) {
  if (tunnelProcess) {
    return { status: tunnelStatus };
  }

  // Write/update config
  const configPath = writeTunnelConfig(store);

  setStatus('starting');
  tunnelLog = [];

  // Clean up stale connections before starting (fire-and-forget)
  const tunnelName = store.get('tunnelName');
  try {
    const cleanup = spawn(getCloudflaredPath(), ['tunnel', 'cleanup', tunnelName], { shell: true });
    cleanup.on('close', () => {
      appendLog('[cleanup] Stale connections cleaned');
    });
    cleanup.on('error', () => {});
  } catch (_) {}

  // Small delay to let cleanup finish before starting
  setTimeout(() => {
    if (tunnelProcess) return; // already started somehow

    tunnelProcess = spawn(
      getCloudflaredPath(),
      ['tunnel', '--config', configPath, 'run'],
      { shell: true }
    );

    tunnelProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      appendLog(line);
      if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
        setStatus('running');
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      appendLog(line);
      // cloudflared logs most info to stderr
      if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
        setStatus('running');
      }
      if (line.includes('ERR') && tunnelStatus === 'starting') {
        // Don't set error for transient connection messages
        if (line.includes('failed to connect') || line.includes('authentication')) {
          setStatus('error');
        }
      }
    });

    tunnelProcess.on('close', (code) => {
      appendLog(`[tunnel process exited with code ${code}]`);
      tunnelProcess = null;
      setStatus('stopped');
    });

    tunnelProcess.on('error', (err) => {
      appendLog(`[tunnel error: ${err.message}]`);
      tunnelProcess = null;
      setStatus('error');
    });
  }, 2000);

  return { status: tunnelStatus };
}

/**
 * Stop the Cloudflare Tunnel.
 */
function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill('SIGTERM');
    setTimeout(() => {
      if (tunnelProcess) {
        try { tunnelProcess.kill('SIGKILL'); } catch (_) {}
      }
    }, 5000);
  }
  tunnelProcess = null;
  setStatus('stopped');
}

/**
 * Get current tunnel state.
 */
function getTunnelState(store) {
  const domain = store.get('tunnelDomain');
  return {
    status: tunnelStatus,
    domain,
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

function onTunnelStatusChange(cb) {
  statusCallback = cb;
}

module.exports = {
  checkCloudflaredInstalled,
  checkAuthenticated,
  checkTunnelSetup,
  runSetupCommand,
  startTunnel,
  stopTunnel,
  getTunnelState,
  onTunnelStatusChange,
};
