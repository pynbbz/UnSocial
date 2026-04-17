const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Cloudflare Tunnel provider.
 *
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
    path.join('C:', 'Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    path.join('C:', 'Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', '.cloudflared', 'cloudflared.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'cloudflared.exe'),
    path.join('C:', 'ProgramData', 'chocolatey', 'bin', 'cloudflared.exe'),
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        _resolvedCloudflaredPath = p;
        return _resolvedCloudflaredPath;
      }
    } catch (_) {}
  }

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

  const defaultCloudflaredDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cloudflared'
  );

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
async function checkInstalled() {
  _resolvedCloudflaredPath = null;
  const exe = getCloudflaredPath();
  return new Promise((resolve) => {
    try {
      const proc = spawn(exe, ['version']);
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
 * Check if the tunnel has been created by looking for a local credentials file.
 */
async function checkSetup(store) {
  const defaultDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.cloudflared'
  );

  let credentialsFound = false;
  let tunnelId = '';
  try {
    if (fs.existsSync(defaultDir)) {
      const files = fs.readdirSync(defaultDir);
      const credFile = files.find(
        (f) => f.endsWith('.json') && f !== 'cert.pem'
      );
      if (credFile) {
        credentialsFound = true;
        tunnelId = credFile.replace('.json', '');
      }
    }
  } catch (_) {}

  if (credentialsFound && tunnelId) {
    try {
      const credPath = path.join(defaultDir, `${tunnelId}.json`);
      const credContent = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (credContent.AccountTag && credContent.TunnelID) {
        return { exists: true, tunnelId: credContent.TunnelID };
      }
    } catch (_) {
      return { exists: true, tunnelId };
    }
  }

  return { exists: credentialsFound, tunnelId };
}

/**
 * Run a one-time setup command (tunnel login, create, route dns).
 */
function runSetupCommand(args) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(getCloudflaredPath(), args);
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
 * Translate a wizard-level setup step into the cloudflared CLI args.
 */
function runWizardStep(step, store) {
  const tunnelName = store.get('tunnelName');
  const domain = store.get('tunnelDomain');

  switch (step) {
    case 'login':
      return runSetupCommand(['tunnel', 'login']);
    case 'create':
      return runSetupCommand(['tunnel', 'create', tunnelName]);
    case 'dns':
      return runSetupCommand(['tunnel', 'route', 'dns', tunnelName, domain]);
    default:
      return Promise.resolve({ success: false, output: `Unknown setup step: ${step}` });
  }
}

/**
 * Start the Cloudflare Tunnel.
 */
function startTunnel(store) {
  if (tunnelProcess) {
    return { status: tunnelStatus };
  }

  const configPath = writeTunnelConfig(store);

  setStatus('starting');
  tunnelLog = [];

  const tunnelName = store.get('tunnelName');
  try {
    const cleanup = spawn(getCloudflaredPath(), ['tunnel', 'cleanup', tunnelName]);
    cleanup.on('close', () => {
      appendLog('[cleanup] Stale connections cleaned');
    });
    cleanup.on('error', () => {});
  } catch (_) {}

  setTimeout(() => {
    if (tunnelProcess) return;

    tunnelProcess = spawn(
      getCloudflaredPath(),
      ['tunnel', '--config', configPath, 'run']
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
      if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
        setStatus('running');
      }
      if (line.includes('ERR') && tunnelStatus === 'starting') {
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
    const pid = tunnelProcess.pid;
    try {
      if (process.platform === 'win32' && pid) {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        tunnelProcess.kill('SIGTERM');
      }
    } catch (_) {}
    tunnelProcess = null;
  }
  killOrphaned();
  setStatus('stopped');
}

/**
 * Kill any orphaned cloudflared.exe processes.
 */
function killOrphaned() {
  if (process.platform !== 'win32') return;
  try {
    execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
  } catch (_) {}
}

/**
 * Public URL exposed by this provider, or '' if not configured.
 */
function getPublicUrl(store) {
  const domain = store.get('tunnelDomain');
  return domain ? `https://${domain}` : '';
}

/**
 * Get current tunnel state.
 */
function getTunnelState(store) {
  return {
    status: tunnelStatus,
    domain: store.get('tunnelDomain'),
    publicUrl: getPublicUrl(store),
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
  id: 'cloudflare',
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
