// ── DOM References ──────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

// Platform status badges (clickable for login/logout)
const igStatusEl = $('#ig-login-status');
const twStatusEl = $('#tw-login-status');
const fbStatusEl = $('#fb-login-status');
const liStatusEl = $('#li-login-status');

const inputUrl = $('#input-url');
const btnAdd = $('#btn-add');
const addError = $('#add-error');
const feedsList = $('#feeds-list');
const emptyState = $('#empty-state');
const feedCount = $('#feed-count');
const btnRefreshAll = $('#btn-refresh-all');
const btnCopyOpml = $('#btn-copy-opml');
const btnBlurToggle = $('#btn-blur-toggle');
let urlsBlurred = false;


// Tunnel elements
const tunnelStatusBadge = $('#tunnel-status-badge');
const tunnelStatusText = $('#tunnel-status-text');
const btnTunnelToggle = $('#btn-tunnel-toggle');
const btnTunnelSetup = $('#btn-tunnel-setup');
const logoLink = $('#logo-link');
const tunnelWizard = $('#tunnel-setup-wizard');
const btnCfLogin = $('#btn-cf-login');
const btnCfCreate = $('#btn-cf-create');
const btnCfDns = $('#btn-cf-dns');
const linkCloudflared = $('#link-cloudflared');

// Notification elements
const btnBell = $('#btn-bell');
const bellBadge = $('#bell-badge');
const notifPanel = $('#notification-panel');
const notifList = $('#notif-panel-list');
const btnNotifClear = $('#btn-notif-clear');
let notifPanelOpen = false;
let notifications = [];

let serverPort = 3845;
let igLoggedIn = false;
let twLoggedIn = false;
let fbLoggedIn = false;
let liLoggedIn = false;
let tunnelDomain = '';
let tunnelRunning = false;
let feedToken = '';

// Track which feed groups are collapsed (default: all collapsed)
const groupCollapsed = {};
let groupCollapseInitialized = false;

// ── Init ────────────────────────────────────────────────────────────────

(async function init() {
  serverPort = await window.api.getServerPort();

  // Load notifications
  notifications = await window.api.getNotifications();
  renderNotifications();

  // Load feed token
  feedToken = await window.api.getFeedToken();
  updateTokenUI();

  // Load tunnel settings
  const tunnelSettings = await window.api.tunnelGetSettings();
  tunnelDomain = tunnelSettings.domain || '';
  updateDomainDisplay();

  // Populate domain input
  const domainInput = $('#tunnel-domain-input');
  if (domainInput) domainInput.value = tunnelDomain;
  const tunnelNameInput = $('#tunnel-name-input');
  if (tunnelNameInput) tunnelNameInput.value = tunnelSettings.tunnelName || 'unsocial-tunnel';

  $('#wizard-domain').textContent = tunnelDomain || '<your-domain>';
  $('#wizard-tunnel-name').textContent = tunnelSettings.tunnelName || 'unsocial-tunnel';

  // Check tunnel state
  const tState = await window.api.tunnelState();
  updateTunnelUI(tState.status);

  // Check logins
  await window.api.checkLogin();
  await window.api.checkTwitterLogin();
  await window.api.checkFacebookLogin();
  await window.api.checkLinkedInLogin();

  // Load feeds
  await renderFeeds();
})();

// ── Login Status Updates ────────────────────────────────────────────────

window.api.onLoginStatus(({ platform, loggedIn }) => {
  if (platform === 'twitter') {
    twLoggedIn = loggedIn;
    updatePlatformLoginUI('twitter', loggedIn);
  } else if (platform === 'facebook') {
    fbLoggedIn = loggedIn;
    updatePlatformLoginUI('facebook', loggedIn);
  } else if (platform === 'linkedin') {
    liLoggedIn = loggedIn;
    updatePlatformLoginUI('linkedin', loggedIn);
  } else {
    igLoggedIn = loggedIn;
    updatePlatformLoginUI('instagram', loggedIn);
  }
  // Re-render feeds so logged-out platforms show red background
  renderFeeds();
});

window.api.onTunnelStatus(({ status }) => {
  updateTunnelUI(status);
  // Update DNS step checkmark when tunnel connects
  if (status === 'running') {
    const dnsStatus = $('#step-dns-status');
    if (dnsStatus) {
      dnsStatus.textContent = '✓ Routed';
      dnsStatus.className = 'step-status ok';
      const dnsStep = $('#wizard-step-dns');
      if (dnsStep) dnsStep.classList.add('done');
    }
  }
});

// Auto-refresh: re-render feeds when main process refreshes them
if (window.api.onFeedsUpdated) {
  window.api.onFeedsUpdated(() => renderFeeds());
}

// Live notification updates from main process
if (window.api.onNotificationsUpdated) {
  window.api.onNotificationsUpdated((data) => {
    notifications = data;
    renderNotifications();
  });
}

function updateTunnelUI(status) {
  tunnelRunning = status === 'running';
  tunnelStatusText.textContent =
    status === 'running' ? 'Connected' :
    status === 'starting' ? 'Connecting…' :
    status === 'error' ? 'Error' : 'Stopped';
  tunnelStatusBadge.className =
    'status-badge ' + (status === 'running' ? 'online' : 'offline');
  btnTunnelToggle.textContent =
    status === 'running' ? '⏹ Stop Tunnel' :
    status === 'starting' ? '⏳ Connecting…' : '▶ Start Tunnel';
  btnTunnelToggle.disabled = status === 'starting';
  updateTunnelUrls();
}

function updateDomainDisplay() {
  const wizardDomain = $('#wizard-domain');
  if (wizardDomain) wizardDomain.textContent = tunnelDomain || '<your-domain>';
}

function tokenQueryString(prefix) {
  if (!feedToken) return '';
  return prefix + 'token=' + feedToken;
}

function updateTunnelUrls() {
  const urlsEl = $('#tunnel-urls');
  if (!urlsEl) return;
  const tokenSuffix = tokenQueryString('?');
  const localUrl = `http://localhost:${serverPort}/feed/<username>${tokenSuffix}`;
  const publicUrl = tunnelDomain ? `https://${tunnelDomain}/feed/<username>${tokenSuffix}` : 'Set a domain above to enable public URLs';
  urlsEl.innerHTML = `
    <div class="tunnel-url-row">
      <span class="tunnel-url-label">Local:</span>
      <a class="tunnel-url-value tunnel-url-local" title="Click to copy">${escapeHtml(localUrl)}</a>
    </div>
    <div class="tunnel-url-row">
      <span class="tunnel-url-label">Public:</span>
      <span class="tunnel-url-value tunnel-url-public ${tunnelRunning ? 'active' : 'inactive'}" title="${tunnelRunning ? 'Click to copy' : 'Start tunnel to activate'}">${escapeHtml(publicUrl)}</span>
    </div>
  `;
  urlsEl.querySelector('.tunnel-url-local')?.addEventListener('click', () => {
    copyToClipboard(localUrl);
    toast('Local URL copied!', 'success');
  });
  if (tunnelDomain) {
    urlsEl.querySelector('.tunnel-url-public')?.addEventListener('click', () => {
      if (tunnelRunning) {
        copyToClipboard(`https://${tunnelDomain}/feed/<username>${tokenSuffix}`);
        toast('Public URL copied!', 'success');
      }
    });
  }
}

function updatePlatformLoginUI(platform, loggedIn) {
  if (platform === 'twitter') {
    twStatusEl.className = 'status-badge platform-clickable ' + (loggedIn ? 'online' : 'offline');
  } else if (platform === 'facebook') {
    fbStatusEl.className = 'status-badge platform-clickable ' + (loggedIn ? 'online' : 'offline');
  } else if (platform === 'linkedin') {
    liStatusEl.className = 'status-badge platform-clickable ' + (loggedIn ? 'online' : 'offline');
  } else {
    igStatusEl.className = 'status-badge platform-clickable ' + (loggedIn ? 'online' : 'offline');
  }
}

// ── Event Listeners ─────────────────────────────────────────────────────

// Click platform badge: login if offline, confirm logout if online
igStatusEl.addEventListener('click', () => {
  if (igLoggedIn) {
    if (confirm('Log out of Instagram?')) window.api.logout();
  } else {
    window.api.openLogin();
  }
});

twStatusEl.addEventListener('click', () => {
  if (twLoggedIn) {
    if (confirm('Log out of Twitter / X?')) window.api.logoutTwitter();
  } else {
    window.api.openTwitterLogin();
  }
});

fbStatusEl.addEventListener('click', () => {
  if (fbLoggedIn) {
    if (confirm('Log out of Facebook?')) window.api.logoutFacebook();
  } else {
    window.api.openFacebookLogin();
  }
});

liStatusEl.addEventListener('click', () => {
  if (liLoggedIn) {
    if (confirm('Log out of LinkedIn?')) window.api.logoutLinkedIn();
  } else {
    window.api.openLinkedInLogin();
  }
});

// Right-click platform badge: force reset (clears all cookies & storage)
for (const [el, platform, name] of [
  [igStatusEl, 'instagram', 'Instagram'],
  [twStatusEl, 'twitter', 'Twitter / X'],
  [fbStatusEl, 'facebook', 'Facebook'],
  [liStatusEl, 'linkedin', 'LinkedIn'],
]) {
  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (confirm(`Force reset ${name}? This will clear ALL cookies and stored data for ${name}. You will need to log in again.`)) {
      await window.api.forceResetPlatform(platform);
      toast(`${name} fully reset`, 'success');
    }
  });
  el.title += ' · Right-click to force reset';
}

btnAdd.addEventListener('click', addFeed);
inputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFeed();
});

btnRefreshAll.addEventListener('click', refreshAll);
btnCopyOpml.addEventListener('click', exportOpml);

btnBlurToggle.addEventListener('click', () => {
  urlsBlurred = !urlsBlurred;
  document.getElementById('app').classList.toggle('urls-blurred', urlsBlurred);
  btnBlurToggle.textContent = urlsBlurred ? '🐵 Show URLs' : '🙈 Blur URLs';
  btnBlurToggle.classList.toggle('btn-blur-active', urlsBlurred);
});

logoLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://github.com/pynbbz/UnSocial');
});

// ── Notification Bell ────────────────────────────────────────────────────────

btnBell.addEventListener('click', (e) => {
  e.stopPropagation();
  notifPanelOpen = !notifPanelOpen;
  notifPanel.style.display = notifPanelOpen ? '' : 'none';
});

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  if (notifPanelOpen && !e.target.closest('.notification-wrapper')) {
    notifPanelOpen = false;
    notifPanel.style.display = 'none';
  }
});

btnNotifClear.addEventListener('click', async () => {
  notifications = await window.api.clearNotifications();
  renderNotifications();
});

function renderNotifications() {
  const unresolved = notifications.filter(n => !n.resolved);
  const unresolvedErrors = unresolved.filter(n => n.type === 'error');

  // Update badge
  if (unresolved.length > 0) {
    bellBadge.style.display = '';
    bellBadge.textContent = unresolved.length;
  } else {
    bellBadge.style.display = 'none';
  }

  // Pulse bell if active errors
  if (unresolvedErrors.length > 0) {
    btnBell.classList.add('has-errors');
  } else {
    btnBell.classList.remove('has-errors');
  }

  // Render list
  if (notifications.length === 0) {
    notifList.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }

  notifList.innerHTML = '';
  for (const n of notifications) {
    const item = document.createElement('div');
    item.className = 'notif-item' + (n.resolved ? ' resolved' : '');
    const icon = n.type === 'error' ? '❌' : n.type === 'warning' ? '⚠️' : 'ℹ️';
    const timeStr = formatNotifTime(n.timestamp);
    item.innerHTML = `
      <span class="notif-icon">${icon}</span>
      <div class="notif-body">
        <div class="notif-message">${escapeHtml(n.message)}</div>
        <div class="notif-time">${timeStr}</div>
      </div>
      ${!n.resolved ? '<button class="notif-dismiss" title="Dismiss">✕</button>' : ''}
    `;
    if (!n.resolved) {
      item.querySelector('.notif-dismiss').addEventListener('click', async (e) => {
        e.stopPropagation();
        notifications = await window.api.resolveNotification(n.id);
        renderNotifications();
      });
    }
    notifList.appendChild(item);
  }
}

function formatNotifTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}



// Tunnel controls
btnTunnelToggle.addEventListener('click', async () => {
  const state = await window.api.tunnelState();
  if (state.status === 'running' || state.status === 'starting') {
    await window.api.tunnelStop();
    updateTunnelUI('stopped');
    toast('Tunnel stopped', 'success');
  } else {
    await window.api.tunnelStart();
    updateTunnelUI('starting');
    toast('Starting tunnel…', 'success');
  }
});

btnTunnelSetup.addEventListener('click', () => {
  const wizard = tunnelWizard;
  if (wizard.style.display === 'none') {
    wizard.style.display = '';
    runSetupChecks();
  } else {
    wizard.style.display = 'none';
  }
});

// Domain & tunnel name save
const btnSaveTunnelSettings = $('#btn-save-tunnel-settings');
if (btnSaveTunnelSettings) {
  btnSaveTunnelSettings.addEventListener('click', async () => {
    const domainInput = $('#tunnel-domain-input');
    const tunnelNameInput = $('#tunnel-name-input');
    const newDomain = (domainInput?.value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const newTunnelName = (tunnelNameInput?.value || '').trim() || 'unsocial-tunnel';
    await window.api.tunnelSaveSettings({ domain: newDomain, tunnelName: newTunnelName });
    tunnelDomain = newDomain;
    updateDomainDisplay();
    updateTunnelUrls();
    $('#wizard-tunnel-name').textContent = newTunnelName;
    await renderFeeds();
    toast('Tunnel settings saved!', 'success');
  });
}

linkCloudflared.addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
});

// ── Token Authentication ────────────────────────────────────────────────

const tokenDisplay = $('#token-display');
const tokenStatus = $('#token-status');
const btnTokenGenerate = $('#btn-token-generate');
const btnTokenCopy = $('#btn-token-copy');
const btnTokenClear = $('#btn-token-clear');

function updateTokenUI() {
  if (feedToken) {
    tokenDisplay.value = feedToken;
    tokenStatus.textContent = 'Enabled';
    tokenStatus.className = 'token-status enabled';
    btnTokenClear.style.display = '';
    btnTokenCopy.style.display = '';
  } else {
    tokenDisplay.value = '';
    tokenDisplay.placeholder = 'No token set — feeds are public';
    tokenStatus.textContent = 'Disabled';
    tokenStatus.className = 'token-status disabled';
    btnTokenClear.style.display = 'none';
    btnTokenCopy.style.display = 'none';
  }
  updateTunnelUrls();
}

btnTokenGenerate.addEventListener('click', async () => {
  feedToken = await window.api.generateFeedToken();
  updateTokenUI();
  await renderFeeds();
  toast('Token generated — feed URLs now require authentication', 'success');
});

btnTokenCopy.addEventListener('click', () => {
  if (feedToken) {
    copyToClipboard(feedToken);
    toast('Token copied!', 'success');
  }
});

btnTokenClear.addEventListener('click', async () => {
  if (!confirm('Remove authentication token? All feed URLs will become publicly accessible.')) return;
  feedToken = '';
  await window.api.setFeedToken('');
  updateTokenUI();
  await renderFeeds();
  toast('Token removed — feeds are now public', 'success');
});

btnCfLogin.addEventListener('click', async () => {
  btnCfLogin.disabled = true;
  btnCfLogin.textContent = '⏳ Running…';
  const r = await window.api.tunnelRunSetup('login');
  $('#step-login-status').textContent = r.success ? '✓ Done' : '✗ Failed';
  $('#step-login-status').className = 'step-status ' + (r.success ? 'ok' : 'fail');
  btnCfLogin.disabled = false;
  btnCfLogin.textContent = 'Run Login';
  if (r.success) runSetupChecks();
});

btnCfCreate.addEventListener('click', async () => {
  btnCfCreate.disabled = true;
  btnCfCreate.textContent = '⏳ Creating…';
  const r = await window.api.tunnelRunSetup('create');
  $('#step-create-status').textContent = r.success ? '✓ Created' : r.output.includes('already exists') ? '✓ Already exists' : '✗ Failed';
  $('#step-create-status').className = 'step-status ' + (r.success || r.output.includes('already exists') ? 'ok' : 'fail');
  btnCfCreate.disabled = false;
  btnCfCreate.textContent = 'Create Tunnel';
  runSetupChecks();
});

btnCfDns.addEventListener('click', async () => {
  btnCfDns.disabled = true;
  btnCfDns.textContent = '⏳ Routing…';
  const r = await window.api.tunnelRunSetup('dns');
  $('#step-dns-status').textContent = r.success ? '✓ Routed' : r.output.includes('already exists') ? '✓ Already routed' : '✗ Failed';
  $('#step-dns-status').className = 'step-status ' + (r.success || r.output.includes('already exists') ? 'ok' : 'fail');
  btnCfDns.disabled = false;
  btnCfDns.textContent = 'Route DNS';
});

async function runSetupChecks() {
  // Step 1: Check cloudflared installed
  const installed = await window.api.tunnelCheckInstalled();
  const installStatus = $('#step-install-status');
  installStatus.textContent = installed.installed ? `✓ ${installed.version}` : '✗ Not found';
  installStatus.className = 'step-status ' + (installed.installed ? 'ok' : 'fail');
  if (installed.installed) {
    $('#wizard-step-install').classList.add('done');
  }

  if (installed.installed) {
    // Step 2: Check authentication (cert.pem exists)
    const auth = await window.api.tunnelCheckAuthenticated();
    if (auth.authenticated) {
      $('#step-login-status').textContent = '✓ Authenticated';
      $('#step-login-status').className = 'step-status ok';
      $('#wizard-step-login').classList.add('done');
    }

    // Step 3: Check tunnel exists
    const setup = await window.api.tunnelCheckSetup();
    if (setup.exists) {
      $('#step-create-status').textContent = '✓ Exists';
      $('#step-create-status').className = 'step-status ok';
      $('#wizard-step-create').classList.add('done');
    }

    // Step 4: If tunnel is running or was previously set up, DNS is routed
    // (DNS route is idempotent and auto-run on every launch by main process)
    if (setup.exists && auth.authenticated) {
      const tState = await window.api.tunnelState();
      if (tState.status === 'running' || tState.status === 'starting') {
        $('#step-dns-status').textContent = '✓ Routed';
        $('#step-dns-status').className = 'step-status ok';
        $('#wizard-step-dns').classList.add('done');
      }
    }
  }
}

// ── Add Feed ────────────────────────────────────────────────────────────

async function addFeed() {
  const url = inputUrl.value.trim();
  if (!url) return;

  addError.textContent = '';
  setBtnLoading(btnAdd, true);

  try {
    await window.api.addFeed(url);
    inputUrl.value = '';
    await renderFeeds();
    toast('Feed added successfully!', 'success');
  } catch (err) {
    addError.textContent = err.message || 'Failed to add feed';
    toast(err.message || 'Failed to add feed', 'error');
  } finally {
    setBtnLoading(btnAdd, false);
    // Re-ensure input is interactive after hidden scraper windows close
    inputUrl.disabled = false;
    inputUrl.style.pointerEvents = 'auto';
    window.focus();
  }
}

// ── Render Feeds ────────────────────────────────────────────────────────

async function renderFeeds() {
  const feeds = await window.api.getFeeds();

  feedCount.textContent = `${feeds.length} feed${feeds.length !== 1 ? 's' : ''}`;

  if (feeds.length === 0) {
    feedsList.innerHTML = '';
    feedsList.appendChild(createEmptyState());
    return;
  }

  feedsList.innerHTML = '';

  // Group feeds by category
  const groups = {};
  const groupOrder = ['Instagram', 'Twitter', 'Facebook', 'LinkedIn', 'Custom', 'Text'];
  for (const feed of feeds) {
    const platform = feed.platform || 'instagram';
    const category = platform === 'twitter' ? 'Twitter' :
      platform === 'facebook' ? 'Facebook' :
      platform === 'linkedin' ? 'LinkedIn' :
      platform === 'txt' ? 'Text' :
      platform === 'custom' ? 'Custom' : 'Instagram';
    if (!groups[category]) groups[category] = [];
    groups[category].push(feed);
  }

  // Initialize collapse state for new groups (default collapsed)
  if (!groupCollapseInitialized) {
    for (const cat of Object.keys(groups)) {
      if (!(cat in groupCollapsed)) groupCollapsed[cat] = true;
    }
    groupCollapseInitialized = true;
  } else {
    for (const cat of Object.keys(groups)) {
      if (!(cat in groupCollapsed)) groupCollapsed[cat] = true;
    }
  }

  // Render in defined order, then any extras
  const orderedCategories = groupOrder.filter(c => groups[c]);
  for (const cat of Object.keys(groups)) {
    if (!orderedCategories.includes(cat)) orderedCategories.push(cat);
  }

  for (const category of orderedCategories) {
    const catFeeds = groups[category];
    const isCollapsed = groupCollapsed[category] !== false;

    // Group header
    const header = document.createElement('div');
    header.className = 'feed-group-header' + (isCollapsed ? ' collapsed' : '');

    // Compute group's newest post date
    const groupLatestTs = catFeeds.reduce((max, f) => {
      if (!f.latestPostDate) return max;
      const t = new Date(f.latestPostDate).getTime();
      return t > max ? t : max;
    }, 0);
    const groupLatestStr = groupLatestTs ? formatTimeAgo(new Date(groupLatestTs).toISOString()) : 'never';

    header.innerHTML = `
      <span class="feed-group-chevron">${isCollapsed ? '▸' : '▾'}</span>
      <span class="feed-group-label">${category}</span>
      <span class="feed-group-count">${catFeeds.length}</span>
      <span class="feed-group-latest">Latest post: ${groupLatestStr}</span>
    `;
    header.addEventListener('click', () => {
      groupCollapsed[category] = !groupCollapsed[category];
      renderFeeds();
    });
    feedsList.appendChild(header);

    if (isCollapsed) continue;

    // Render feed cards in this group
    for (const feed of catFeeds) {
      const card = buildFeedCard(feed);
      feedsList.appendChild(card);
    }
  }
}

function buildFeedCard(feed) {
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.dataset.username = feed.username;
    const platform = feed.platform || 'instagram';
    card.dataset.platform = platform;

    // Detect stale (>6h), errored feeds, or logged-out platform
    const lastCheckedMs = feed.lastChecked ? new Date(feed.lastChecked).getTime() : 0;
    const isStale = (Date.now() - lastCheckedMs) > 6 * 60 * 60 * 1000;
    const hasError = notifications.some(n => !n.resolved && n.type === 'error' && n.message.includes(`@${feed.username}`));
    const platformLoggedOut = (platform === 'instagram' && !igLoggedIn) ||
                              (platform === 'twitter' && !twLoggedIn) ||
                              (platform === 'facebook' && !fbLoggedIn) ||
                              (platform === 'linkedin' && !liLoggedIn);
    // txt and custom feeds never require login, so only mark stale for actual staleness/errors
    if (isStale || hasError || (platformLoggedOut && platform !== 'txt' && platform !== 'custom')) {
      card.classList.add('feed-stale');
    }

    const platformLogo = platform === 'twitter'
      ? 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
      : platform === 'facebook'
        ? 'https://www.facebook.com/images/fb_icon_325x325.png'
        : platform === 'linkedin'
          ? 'https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png'
          : platform === 'txt'
            ? 'https://cdn-icons-png.flaticon.com/512/337/337956.png'
            : platform === 'custom'
              ? 'https://cdn-icons-png.flaticon.com/512/1006/1006771.png'
              : 'https://www.instagram.com/static/images/ico/favicon-192.png/68d99ba29cc8.png';
    const isGroup = feed.username.startsWith('groups/');
    const isEvent = feed.username.startsWith('events/') || feed.username === 'events';
    const platformLabel = platform === 'twitter' ? 'Twitter' :
                          platform === 'facebook' ? (isGroup ? 'FB Group' : isEvent ? 'FB Event' : 'Facebook') :
                          platform === 'linkedin' ? 'LinkedIn' :
                          platform === 'txt' ? 'Text' :
                          platform === 'custom' ? 'Custom' : 'Instagram';
    const feedKey = feed.feedKey || feed.username.replace(/\//g, '-');
    const tokenSuffix = tokenQueryString('?');
    const rssUrl = `http://localhost:${serverPort}/feed/${feedKey}${tokenSuffix}`;
    const publicUrl = `https://${tunnelDomain}/feed/${feedKey}${tokenSuffix}`;
    const timeAgo = formatTimeAgo(feed.lastChecked);

    card.innerHTML = `
      <div class="feed-card-content">
        <div class="feed-card-header">
          <div class="feed-avatar">
            <img src="${platformLogo}" alt="${platformLabel}" style="width:36px;height:36px;border-radius:8px;" onerror="this.style.display='none';this.nextElementSibling.style.display=''">
            <span style="display:none">${feed.alias?.charAt(0)?.toUpperCase() || '@'}</span>
          </div>
          <div class="feed-info">
            <div class="feed-name">
              <span class="feed-alias-text">${escapeHtml(feed.alias || feed.username)}</span>
            </div>
            <div class="feed-meta">
              <a class="feed-username-link" href="#" data-url="${escapeHtml(feed.url)}" title="Open in browser">@${escapeHtml(feed.username)}</a>
            </div>
          </div>
        </div>
        <div class="feed-card-body">
          <div class="feed-meta">
            <span>${feed.postCount || 0} posts</span>
            <span>Updated ${timeAgo}</span>
          </div>
          <div class="feed-meta">
            <span style="font-weight:bold">Latest post ${formatTimeAgo(feed.latestPostDate)}</span>
          </div>
          <div class="feed-urls">
            <a class="feed-url feed-url-public" title="Click to copy public URL">${publicUrl}</a>
          </div>
        </div>
      </div>
      <div class="feed-actions">
        <button class="btn btn-outline btn-sm btn-rename" title="Rename">✏️</button>
        <button class="btn btn-outline btn-sm btn-refresh" title="Refresh">🔄</button>
        <button class="btn btn-outline btn-sm btn-remove" title="Remove">✕</button>
      </div>
    `;

    // Open source URL in user's browser on username click
    card.querySelector('.feed-username-link').addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(feed.url);
    });

    // Copy URL on click
    card.querySelector('.feed-url-public').addEventListener('click', (e) => {
      e.preventDefault();
      copyToClipboard(publicUrl);
      toast('RSS URL copied!', 'success');
    });

    card.querySelector('.btn-rename').addEventListener('click', async () => {
      const aliasEl = card.querySelector('.feed-alias-text');
      const currentAlias = feed.alias || feed.username;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentAlias;
      input.className = 'rename-input';
      input.style.cssText = 'font-size:inherit;padding:2px 6px;border:1px solid var(--accent);border-radius:4px;background:var(--bg-card);color:var(--text);width:200px;';
      aliasEl.replaceWith(input);
      input.focus();
      input.select();

      const doRename = async () => {
        const newAlias = input.value.trim();
        if (newAlias && newAlias !== currentAlias) {
          await window.api.renameFeed(feed.username, platform, newAlias);
          toast('Feed renamed!', 'success');
        }
        await renderFeeds();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doRename();
        if (e.key === 'Escape') renderFeeds();
      });
      input.addEventListener('blur', doRename);
    });

    card.querySelector('.btn-refresh').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        await window.api.refreshFeed(feed.username, platform);
        toast(`@${feed.username} refreshed!`, 'success');
        await renderFeeds();
      } catch (err) {
        toast(`Failed to refresh @${feed.username}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄';
        window.focus();
      }
    });

    card.querySelector('.btn-remove').addEventListener('click', async () => {
      if (!confirm(`Remove feed @${feed.username}?`)) return;
      await window.api.removeFeed(feed.username, platform);
      toast(`@${feed.username} removed`, 'success');
      await renderFeeds();
      window.focus();
    });

    return card;
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.id = 'empty-state';
  div.innerHTML = `
    <div class="empty-icon">📡</div>
    <p>No feeds yet.</p>
    <p class="subtle">Login to a platform, then add a profile URL above — or paste any website URL to create a custom feed.</p>
  `;
  return div;
}

// ── Refresh All ─────────────────────────────────────────────────────────

async function refreshAll() {
  setBtnLoading(btnRefreshAll, true, '🔄 Refreshing…');
  try {
    const results = await window.api.refreshAll();
    const ok = results.filter((r) => r.success).length;
    const fail = results.filter((r) => !r.success).length;
    toast(`Refreshed ${ok} feed(s)${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    await renderFeeds();
  } catch (err) {
    toast('Failed to refresh feeds', 'error');
  } finally {
    setBtnLoading(btnRefreshAll, false, '🔄 Refresh All');
  }
}

// ── Export OPML ─────────────────────────────────────────────────────────

async function exportOpml() {
  const feeds = await window.api.getFeeds();
  if (feeds.length === 0) {
    toast('No feeds to export', 'error');
    return;
  }

  // Group feeds by platform
  const groups = {};
  for (const feed of feeds) {
    const platform = feed.platform || 'instagram';
    const category = platform === 'twitter' ? 'Twitter' :
      platform === 'facebook' ? 'Facebook' :
      platform === 'linkedin' ? 'LinkedIn' :
      platform === 'txt' ? 'Text' :
      platform === 'custom' ? 'Custom' : 'Instagram';
    if (!groups[category]) groups[category] = [];
    groups[category].push(feed);
  }

  const result = await window.api.exportOpml(groups, tunnelDomain);
  if (result.success) {
    toast(`Exported ${result.fileCount} OPML file(s)`, 'success');
  } else {
    toast(result.error || 'Export failed', 'error');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function setBtnLoading(btn, loading, loadingText) {
  if (loading) {
    btn.disabled = true;
    if (loadingText) btn.textContent = loadingText;
    const spinner = btn.querySelector('.btn-spinner');
    const text = btn.querySelector('.btn-text');
    if (spinner) spinner.style.display = '';
    if (text) text.style.display = 'none';
  } else {
    btn.disabled = false;
    if (loadingText) btn.textContent = loadingText;
    const spinner = btn.querySelector('.btn-spinner');
    const text = btn.querySelector('.btn-text');
    if (spinner) spinner.style.display = 'none';
    if (text) text.style.display = '';
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  });
}

function formatTimeAgo(isoString) {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
