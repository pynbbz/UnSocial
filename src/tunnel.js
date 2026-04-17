/**
 * Tunnel dispatcher.
 *
 * Routes tunnel operations to the active provider (Cloudflare or Tailscale).
 * The provider is selected via the `tunnelProvider` store key and can be
 * switched at runtime from the Public Access overlay.
 *
 * Every provider exposes the same shape (see tunnel-cloudflare.js /
 * tunnel-tailscale.js) so the IPC layer and renderer don't have to care
 * which one is active.
 */

const cloudflare = require('./tunnel-cloudflare');
const tailscale = require('./tunnel-tailscale');

const PROVIDERS = {
  cloudflare,
  tailscale,
};

const DEFAULT_PROVIDER = 'cloudflare';

let activeProviderId = DEFAULT_PROVIDER;
let externalStatusCallback = null;

function getProviderId(store) {
  if (store) {
    const saved = store.get('tunnelProvider');
    if (saved && PROVIDERS[saved]) {
      activeProviderId = saved;
      return saved;
    }
  }
  return activeProviderId;
}

function getProvider(store) {
  const id = getProviderId(store);
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

function getAvailableProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * Switch providers. Stops the previous one first so we never leave two
 * tunnels running.
 */
async function setProvider(store, newId) {
  if (!PROVIDERS[newId]) throw new Error(`Unknown tunnel provider: ${newId}`);
  const currentId = getProviderId(store);
  if (currentId === newId) {
    return { provider: currentId, changed: false };
  }

  try {
    await PROVIDERS[currentId].stopTunnel();
  } catch (_) {}
  try {
    PROVIDERS[currentId].killOrphaned?.();
  } catch (_) {}

  activeProviderId = newId;
  store.set('tunnelProvider', newId);

  // Re-wire the status callback onto the new provider.
  if (externalStatusCallback) {
    PROVIDERS[newId].onStatusChange((data) =>
      externalStatusCallback({ ...data, provider: newId })
    );
  }

  return { provider: newId, changed: true };
}

// ── Provider API passthrough ────────────────────────────────────────────────

function checkInstalled(store) {
  return getProvider(store).checkInstalled();
}

function checkAuthenticated(store) {
  return getProvider(store).checkAuthenticated();
}

function checkSetup(store) {
  return getProvider(store).checkSetup(store);
}

function runSetupCommand(store, args) {
  return getProvider(store).runSetupCommand(args);
}

function runWizardStep(store, step) {
  return getProvider(store).runWizardStep(step, store);
}

function startTunnel(store) {
  return getProvider(store).startTunnel(store);
}

function stopTunnel(store) {
  return getProvider(store).stopTunnel();
}

function killOrphaned(store) {
  return getProvider(store).killOrphaned?.();
}

function getPublicUrl(store) {
  return getProvider(store).getPublicUrl(store);
}

async function getTunnelState(store) {
  const state = await getProvider(store).getTunnelState(store);
  return { ...state, provider: getProviderId(store) };
}

/**
 * Register a single status callback that fires for whichever provider is
 * active (including after a provider switch).
 */
function onTunnelStatusChange(cb) {
  externalStatusCallback = cb;
  const notify = (id) => (data) => cb({ ...data, provider: id });
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    provider.onStatusChange(notify(id));
  }
}

module.exports = {
  // Dispatcher helpers
  getProviderId,
  getAvailableProviders,
  setProvider,

  // Provider-agnostic API (unchanged signatures where possible)
  checkInstalled,
  checkCloudflaredInstalled: checkInstalled, // legacy alias
  checkAuthenticated,
  checkTunnelSetup: checkSetup, // legacy alias
  checkSetup,
  runSetupCommand,
  runWizardStep,
  startTunnel,
  stopTunnel,
  killOrphanedCloudflared: killOrphaned, // legacy alias
  killOrphaned,
  getPublicUrl,
  getTunnelState,
  onTunnelStatusChange,
};
