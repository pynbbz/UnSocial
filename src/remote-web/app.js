// ── UnSocial Remote Web Application ──────────────────────────────────────────

(function () {
  'use strict';

  // State
  let authToken = localStorage.getItem('unsocial_remote_token') || '';
  let activeWizardId = null;
  let activeWizardData = null;
  let cachedFeeds = [];
  let feedSearchQuery = '';
  let activeCategory = 'All';
  let editingFeedKey = null;

  // DOM Elements
  const viewLogin = document.getElementById('view-login');
  const viewMain = document.getElementById('view-main');
  const formLogin = document.getElementById('form-login');
  const loginUser = document.getElementById('login-username');
  const loginPass = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const btnTogglePass = document.getElementById('btn-toggle-password');
  const btnLogout = document.getElementById('btn-logout');

  const navTabs = document.querySelectorAll('.tab-button');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const modePills = document.querySelectorAll('.mode-pill');
  const modeSections = document.querySelectorAll('.mode-section');

  const feedsCountBadge = document.getElementById('feeds-count-badge');
  const feedsListContainer = document.getElementById('feeds-list-container');
  const btnRefreshAll = document.getElementById('btn-refresh-all-feeds');
  const feedTabsBar = document.getElementById('feed-tabs-bar');
  const feedSearchInput = document.getElementById('feed-search-input');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const feedCategoryTabs = document.getElementById('feed-category-tabs');

  const formQuickAdd = document.getElementById('form-quick-add');
  const quickUrlInput = document.getElementById('quick-url-input');
  const quickAddStatus = document.getElementById('quick-add-status');

  // Reddit Builder Elements
  const redditTabs = document.querySelectorAll('.reddit-tab');
  const redditViews = document.querySelectorAll('.reddit-view');
  const redditSubSortPills = document.querySelectorAll('#reddit-sub-sort-pills .pill');
  const redditSubTimeGroup = document.getElementById('reddit-sub-timeframe-group');
  const redditSubTimePills = document.querySelectorAll('#reddit-sub-timeframe-pills .pill');
  const redditSearchSortPills = document.querySelectorAll('#reddit-search-sort-pills .pill');
  const redditSearchTimeGroup = document.getElementById('reddit-search-timeframe-group');
  const redditSearchTimePills = document.querySelectorAll('#reddit-search-timeframe-pills .pill');
  const redditUserSortPills = document.querySelectorAll('#reddit-user-sort-pills .pill');
  const btnSubmitReddit = document.getElementById('btn-submit-reddit');
  const redditStatus = document.getElementById('reddit-builder-status');

  // Custom Website Elements
  const formCustomStart = document.getElementById('form-custom-start');
  const customTargetUrl = document.getElementById('custom-target-url');
  const customStartStatus = document.getElementById('custom-start-status');
  const customStepUrl = document.getElementById('custom-step-url');
  const customStepInteractive = document.getElementById('custom-step-interactive');
  const studioScreenshot = document.getElementById('studio-screenshot');
  const studioCanvasWrapper = document.getElementById('canvas-wrapper');
  const touchMarker = document.getElementById('touch-marker');
  const studioLoader = document.getElementById('studio-loader');
  const studioLoaderText = document.getElementById('studio-loader-text');
  const studioPageTitle = document.getElementById('studio-page-title');
  const studioPageUrl = document.getElementById('studio-page-url');
  const btnCustomCancel = document.getElementById('btn-custom-cancel');
  const selectionDrawer = document.getElementById('selection-drawer');
  const drawerMatchCount = document.getElementById('drawer-match-count');
  const drawerSelectorDisplay = document.getElementById('drawer-selector-display');
  const drawerItemsPreview = document.getElementById('drawer-items-preview');
  const customFeedName = document.getElementById('custom-feed-name');
  const btnConfirmCustom = document.getElementById('btn-confirm-custom-feed');
  const btnScrollPage = document.getElementById('btn-scroll-page');
  const studioCandidatesRow = document.getElementById('studio-candidates-row');
  const studioCandidatesList = document.getElementById('studio-candidates-list');

  const toastEl = document.getElementById('toast');

  // ── Helper: API Request ───────────────────────────────────────────────────
  function resolveEndpoint(endpoint) {
    if (endpoint.startsWith('http')) return endpoint;
    const clean = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return window.location.pathname.startsWith('/remote') ? `/remote${clean}` : clean;
  }

  async function api(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const res = await fetch(resolveEndpoint(endpoint), {
        ...options,
        headers,
      });

      if (res.status === 401) {
        // Auth expired or invalid
        showLogin();
        throw new Error('Unauthorized');
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP error ${res.status}`);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  // ── Toast Notifications ───────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, duration = 3000) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    toastTimer = setTimeout(() => {
      toastEl.style.display = 'none';
      toastTimer = null;
    }, duration);
  }

  // ── View Transitions ──────────────────────────────────────────────────────
  function showLogin() {
    authToken = '';
    localStorage.removeItem('unsocial_remote_token');
    viewLogin.style.display = 'flex';
    viewMain.style.display = 'none';
  }

  function showMain() {
    viewLogin.style.display = 'none';
    viewMain.style.display = 'flex';
    loadPlatforms();
    loadFeeds();
  }

  // ── Password Visibility Toggle ────────────────────────────────────────────
  btnTogglePass.addEventListener('click', () => {
    const isPass = loginPass.type === 'password';
    loginPass.type = isPass ? 'text' : 'password';
    btnTogglePass.textContent = isPass ? '🙈' : '👁️';
  });

  // ── Auth Handling ─────────────────────────────────────────────────────────
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.style.display = 'none';

    const username = loginUser.value.trim();
    const password = loginPass.value;

    const btnSubmit = document.getElementById('btn-login-submit');
    const btnText = btnSubmit.querySelector('.btn-text');
    const spinner = btnSubmit.querySelector('.spinner');

    btnSubmit.disabled = true;
    btnText.style.display = 'none';
    spinner.style.display = 'inline-block';

    try {
      const res = await fetch(resolveEndpoint('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Login failed');
      }

      authToken = data.token;
      localStorage.setItem('unsocial_remote_token', authToken);
      showMain();
      showToast('Signed in successfully');
    } catch (err) {
      loginError.textContent = err.message;
      loginError.style.display = 'block';
    } finally {
      btnSubmit.disabled = false;
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  });

  btnLogout.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (_) {}
    showLogin();
    showToast('Signed out');
  });

  // Check initial session
  async function checkSession() {
    try {
      const data = await api('/api/session');
      if (data && data.authenticated) {
        showMain();
      } else {
        showLogin();
      }
    } catch (_) {
      showLogin();
    }
  }

  // ── Navigation Tabs ───────────────────────────────────────────────────────
  navTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      navTabs.forEach((t) => t.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(tab.dataset.tab);
      if (targetPane) targetPane.classList.add('active');

      if (tab.dataset.tab === 'tab-feeds') {
        loadFeeds();
      }
    });
  });

  // ── Add Modes (Quick / Reddit / Custom) ────────────────────────────────────
  modePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      modePills.forEach((p) => p.classList.remove('active'));
      modeSections.forEach((s) => s.style.display = 'none');

      pill.classList.add('active');
      const targetSection = document.getElementById(`mode-${pill.dataset.mode}`);
      if (targetSection) targetSection.style.display = 'block';
    });
  });

  // ── Load Platform Statuses ────────────────────────────────────────────────
  async function loadPlatforms() {
    try {
      const data = await api('/api/platforms');
      const logins = data.logins || {};

      const map = {
        reddit: 'pbadge-reddit',
        twitter: 'pbadge-twitter',
        instagram: 'pbadge-instagram',
        facebook: 'pbadge-facebook',
        linkedin: 'pbadge-linkedin',
        telegram: 'pbadge-telegram',
      };

      for (const [platform, id] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) {
          if (logins[platform]) {
            el.classList.add('is-logged-in');
            el.title = `${platform}: Logged in on Mac Mini`;
          } else {
            el.classList.remove('is-logged-in');
            el.title = `${platform}: Not logged in on Mac Mini`;
          }
        }
      }
    } catch (_) {}
  }

  // ── Load Feeds List ───────────────────────────────────────────────────────
  async function loadFeeds() {
    try {
      const data = await api('/api/feeds');
      cachedFeeds = data.feeds || [];
      feedsCountBadge.textContent = cachedFeeds.length;

      renderFeedsList();
    } catch (err) {
      console.error('Failed to load feeds:', err);
    }
  }

  function getPlatformIcon(platform) {
    switch (platform) {
      case 'telegram': return '✈️';
      case 'reddit': return '🔥';
      case 'twitter': return '🐦';
      case 'instagram': return '📷';
      case 'facebook': return '👥';
      case 'linkedin': return '💼';
      case 'custom': return '🌐';
      case 'txt': return '📄';
      default: return '📡';
    }
  }

  function getFeedCategory(feed) {
    const p = (feed.platform || 'instagram').toLowerCase();
    switch (p) {
      case 'telegram': return 'Telegram';
      case 'reddit': return 'Reddit';
      case 'twitter': return 'Twitter';
      case 'facebook': return 'Facebook';
      case 'linkedin': return 'LinkedIn';
      case 'custom': return 'Custom';
      case 'txt': return 'Text';
      case 'instagram':
      default: return 'Instagram';
    }
  }

  // Search input event listeners
  if (feedSearchInput) {
    feedSearchInput.addEventListener('input', () => {
      feedSearchQuery = feedSearchInput.value.trim().toLowerCase();
      if (btnClearSearch) {
        btnClearSearch.style.display = feedSearchInput.value ? 'flex' : 'none';
      }
      renderFeedsList();
    });

    feedSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        feedSearchInput.value = '';
        feedSearchQuery = '';
        if (btnClearSearch) btnClearSearch.style.display = 'none';
        feedSearchInput.blur();
        renderFeedsList();
      }
    });
  }

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      if (feedSearchInput) {
        feedSearchInput.value = '';
        feedSearchQuery = '';
        btnClearSearch.style.display = 'none';
        feedSearchInput.focus();
      }
      renderFeedsList();
    });
  }

  function renderFeedsList() {
    const feeds = cachedFeeds;
    if (!feeds || feeds.length === 0) {
      if (feedTabsBar) feedTabsBar.style.display = 'none';
      feedsListContainer.innerHTML = `
        <div class="card" style="text-align: center; padding: 32px 16px;">
          <p style="color: var(--text-muted); margin-bottom: 12px;">No feeds yet.</p>
          <button type="button" class="btn btn-primary btn-sm" onclick="document.querySelector('[data-tab=\\'tab-add\\']').click()">+ Add Your First Feed</button>
        </div>
      `;
      return;
    }

    if (feedTabsBar) feedTabsBar.style.display = 'flex';

    // 1. Filter by search query
    const query = feedSearchQuery;
    const searchedFeeds = query ? feeds.filter((feed) => {
      const u = (feed.username || '').toLowerCase();
      const a = (feed.alias || '').toLowerCase();
      const p = (feed.platform || '').toLowerCase();
      const fk = (feed.feedKey || '').toLowerCase();
      const url = (feed.url || '').toLowerCase();
      const fullUrl = (feed.fullUrl || '').toLowerCase();
      return u.includes(query) || a.includes(query) || p.includes(query) || fk.includes(query) || url.includes(query) || fullUrl.includes(query);
    }) : feeds;

    // 2. Group by category
    const groups = {};
    const groupOrder = ['Telegram', 'Reddit', 'Instagram', 'Twitter', 'Facebook', 'LinkedIn', 'Custom', 'Text'];
    for (const feed of searchedFeeds) {
      const cat = getFeedCategory(feed);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(feed);
    }

    const orderedCategories = groupOrder.filter((c) => groups[c]);
    for (const cat of Object.keys(groups)) {
      if (!orderedCategories.includes(cat)) orderedCategories.push(cat);
    }

    if (!activeCategory || (activeCategory !== 'All' && !orderedCategories.includes(activeCategory))) {
      activeCategory = 'All';
    }

    // 3. Render Category Tabs
    if (feedCategoryTabs) {
      feedCategoryTabs.innerHTML = '';

      // "All" Tab
      const allTab = document.createElement('button');
      allTab.type = 'button';
      allTab.className = 'feed-category-tab' + (activeCategory === 'All' ? ' is-active' : '');
      allTab.innerHTML = `
        <span class="feed-tab-label">All</span>
        <span class="feed-tab-count">${searchedFeeds.length}</span>
      `;
      allTab.addEventListener('click', () => {
        activeCategory = 'All';
        renderFeedsList();
      });
      feedCategoryTabs.appendChild(allTab);

      // Specific Category Tabs
      for (const cat of orderedCategories) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'feed-category-tab' + (cat === activeCategory ? ' is-active' : '');
        tab.innerHTML = `
          <span class="feed-tab-label">${cat}</span>
          <span class="feed-tab-count">${groups[cat].length}</span>
        `;
        tab.addEventListener('click', () => {
          activeCategory = cat;
          renderFeedsList();
        });
        feedCategoryTabs.appendChild(tab);
      }
    }

    // 4. If query provided but 0 results found
    if (searchedFeeds.length === 0 && query) {
      feedsListContainer.innerHTML = `
        <div class="card empty-search-state" style="text-align: center; padding: 36px 16px;">
          <div style="font-size: 32px; margin-bottom: 10px;">🔍</div>
          <p style="color: var(--text-main); font-weight: 600; margin-bottom: 6px;">
            No subscribed feeds match "<strong>${escapeHtml(feedSearchInput ? feedSearchInput.value : query)}</strong>"
          </p>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">
            Try searching by alias, username, platform, or URL
          </p>
          <button type="button" class="btn btn-outline btn-sm" id="btn-clear-search-empty">Clear search</button>
        </div>
      `;
      const btnClearEmpty = feedsListContainer.querySelector('#btn-clear-search-empty');
      if (btnClearEmpty) {
        btnClearEmpty.addEventListener('click', () => {
          if (feedSearchInput) {
            feedSearchInput.value = '';
            feedSearchQuery = '';
            if (btnClearSearch) btnClearSearch.style.display = 'none';
            feedSearchInput.focus();
          }
          renderFeedsList();
        });
      }
      return;
    }

    // 5. Select feeds to display based on activeCategory
    const feedsToShow = activeCategory === 'All' ? searchedFeeds : (groups[activeCategory] || []);

    feedsListContainer.innerHTML = feedsToShow.map((feed) => {
      const plat = feed.platform || 'instagram';
      const feedKey = (feed.feedKey || feed.username).replace(/\//g, '-');
      const alias = feed.alias || feed.username;
      const count = typeof feed.postCount === 'number' ? feed.postCount : 0;
      const lastChecked = feed.lastChecked
        ? new Date(feed.lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'Never';
      const currentKeywords = (Array.isArray(feed.filterKeywords) ? feed.filterKeywords : []).join(', ');
      const isEditing = editingFeedKey === feedKey;
      const customNeedsRelogin = plat === 'custom' && Boolean(feed.loginError || feed.loginPaused || (feed.usesLogin && feed.loggedIn === false));

      if (isEditing) {
        return `
          <div class="feed-item-card is-editing" data-username="${escapeHtml(feed.username)}" data-platform="${escapeHtml(plat)}" data-feedkey="${escapeHtml(feedKey)}">
            <div class="feed-item-top">
              <div class="feed-item-info">
                <div class="feed-platform-icon ${escapeHtml(plat)}">
                  ${getPlatformIcon(plat)}
                </div>
                <div class="feed-name-block">
                  <div class="feed-alias">Editing: ${escapeHtml(alias)}</div>
                  <div class="feed-handle">${plat === 'reddit' ? 'r/' : plat === 'custom' ? '' : '@'}${escapeHtml(feed.username)}</div>
                </div>
              </div>
            </div>

            <div class="feed-edit-container">
              <div class="feed-edit-row">
                <label class="feed-edit-label" for="rename-input-${escapeHtml(feedKey)}">Feed Name</label>
                <input type="text" id="rename-input-${escapeHtml(feedKey)}" class="input-field rename-input" value="${escapeHtml(alias)}" placeholder="Feed alias" />
                <span class="feed-edit-hint">Renaming updates the feed title and automatically changes the feed URL key.</span>
              </div>
              <div class="feed-edit-row">
                <label class="feed-edit-label" for="filter-input-${escapeHtml(feedKey)}">Exclude Titles Containing (optional)</label>
                <input type="text" id="filter-input-${escapeHtml(feedKey)}" class="input-field feed-filter-input" value="${escapeHtml(currentKeywords)}" placeholder="e.g. sponsor, giveaway (comma-separated)" />
                <span class="feed-edit-hint">Articles with titles containing these words or phrases will be excluded from the generated RSS.</span>
              </div>
              ${plat === 'custom' ? `
              <div class="feed-edit-row">
                <label class="feed-edit-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="checkbox" id="uses-login-input-${escapeHtml(feedKey)}" ${feed.usesLogin ? 'checked' : ''} />
                  <span>🔐 Uses login credentials (track login status & alert if re-login is needed)</span>
                </label>
              </div>
              ` : ''}
              <div class="feed-edit-actions">
                <button type="button" class="btn btn-primary btn-sm btn-save-rename">
                  <span class="btn-text">Save</span>
                  <span class="spinner" style="display: none;"></span>
                </button>
                <button type="button" class="btn btn-outline btn-sm btn-cancel-rename">Cancel</button>
              </div>
            </div>
          </div>
        `;
      }

      const customStatusMeta = plat === 'custom'
        ? customNeedsRelogin
          ? `<span class="badge-filter" title="${escapeHtml(feed.lastError || 'Re-login needed on desktop app')}">⚠️ Re-login Needed</span>`
          : feed.usesLogin
            ? feed.loggedIn === true
              ? `<span class="badge badge-success" title="Using authenticated login session">🔐 Logged In</span>`
              : `<span class="badge" title="Login credentials configured (unverified)">🔐 Login Active</span>`
            : `<span class="badge" title="Public website scrape (no login required)">🔓 No Login</span>`
        : '';

      return `
        <div class="feed-item-card" data-username="${escapeHtml(feed.username)}" data-platform="${escapeHtml(plat)}" data-feedkey="${escapeHtml(feedKey)}">
          <div class="feed-item-top">
            <div class="feed-item-info">
              <div class="feed-platform-icon ${escapeHtml(plat)}">
                ${getPlatformIcon(plat)}
              </div>
              <div class="feed-name-block">
                <div class="feed-alias">${escapeHtml(alias)}</div>
                <div class="feed-handle">${plat === 'reddit' ? 'r/' : plat === 'custom' ? '' : '@'}${escapeHtml(feed.username)}</div>
              </div>
            </div>
            <span class="badge ${count > 0 ? 'badge-success' : ''}">${count} items</span>
          </div>

          <div class="feed-url-row">
            <span class="feed-url-icon">🔗</span>
            <code class="feed-url-code" title="${escapeHtml(feed.rssUrl || '')}">${escapeHtml(feed.rssUrl || '')}</code>
          </div>

          <div class="feed-item-meta">
            <span>Checked: ${lastChecked}</span>
            <span>Type: ${escapeHtml(plat)}</span>
            ${customStatusMeta}
            ${feed.filterKeywords && feed.filterKeywords.length > 0 ? `<span class="badge-filter" title="Excluded keywords: ${escapeHtml(currentKeywords)}">Filtered (${feed.filterKeywords.length})</span>` : ''}
          </div>

          <div class="feed-item-actions">
            <button type="button" class="btn btn-outline btn-sm btn-copy-feed" data-url="${escapeHtml(feed.rssUrl || '')}">
              📋 Copy RSS
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-rename-feed" data-feedkey="${escapeHtml(feedKey)}" title="Rename feed and auto-update URL">
              ✏️ Rename
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-refresh-feed" data-username="${escapeHtml(feed.username)}" data-platform="${escapeHtml(plat)}">
              ↻ Refresh
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach card event listeners
    attachFeedCardActions();
  }

  function attachFeedCardActions() {
    // 1. Copy RSS actions
    feedsListContainer.querySelectorAll('.btn-copy-feed').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        if (!url) return;
        navigator.clipboard.writeText(url).then(() => {
          showToast('Copied RSS URL to clipboard!');
        }).catch(() => {
          prompt('Copy RSS URL:', url);
        });
      });
    });

    // 2. Single Feed Refresh actions
    feedsListContainer.querySelectorAll('.btn-refresh-feed').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const username = btn.dataset.username;
        const platform = btn.dataset.platform;
        btn.disabled = true;
        btn.classList.add('rotating');
        try {
          await api('/api/feed/refresh', {
            method: 'POST',
            body: JSON.stringify({ username, platform }),
          });
          showToast(`Refreshed ${username}!`);
          await loadFeeds();
        } catch (err) {
          showToast(`Refresh failed: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.classList.remove('rotating');
        }
      });
    });

    // 3. Rename Feed actions (open editing mode)
    feedsListContainer.querySelectorAll('.btn-rename-feed').forEach((btn) => {
      btn.addEventListener('click', () => {
        const feedKey = btn.dataset.feedkey;
        editingFeedKey = feedKey;
        renderFeedsList();
        const input = document.getElementById(`rename-input-${feedKey}`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    });

    // 4. Editing card actions (Save / Cancel)
    const editingCard = feedsListContainer.querySelector('.feed-item-card.is-editing');
    if (editingCard) {
      const feedKey = editingCard.dataset.feedkey;
      const username = editingCard.dataset.username;
      const platform = editingCard.dataset.platform;
      const renameInput = document.getElementById(`rename-input-${feedKey}`);
      const filterInput = document.getElementById(`filter-input-${feedKey}`);
      const usesLoginInput = document.getElementById(`uses-login-input-${feedKey}`);
      const btnSave = editingCard.querySelector('.btn-save-rename');
      const btnCancel = editingCard.querySelector('.btn-cancel-rename');

      const doSave = async () => {
        if (!renameInput) return;
        const newAlias = renameInput.value.trim();
        const filterVal = filterInput ? filterInput.value.trim() : '';
        const filterKeywords = filterVal
          ? filterVal.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)
          : [];
        const usesLogin = usesLoginInput ? usesLoginInput.checked : undefined;

        if (btnSave) {
          btnSave.disabled = true;
          const textSpan = btnSave.querySelector('.btn-text');
          const spinner = btnSave.querySelector('.spinner');
          if (textSpan) textSpan.textContent = 'Saving…';
          if (spinner) spinner.style.display = 'inline-block';
        }

        try {
          const res = await api('/api/feed/rename', {
            method: 'POST',
            body: JSON.stringify({
              username,
              platform,
              newAlias,
              filterKeywords,
              usesLogin,
            }),
          });

          editingFeedKey = null;
          showToast('Feed renamed! Feed URL updated.');
          if (res && res.feeds) {
            cachedFeeds = res.feeds;
            feedsCountBadge.textContent = cachedFeeds.length;
            renderFeedsList();
          } else {
            await loadFeeds();
          }
        } catch (err) {
          showToast(`Rename failed: ${err.message}`);
          if (btnSave) {
            btnSave.disabled = false;
            const textSpan = btnSave.querySelector('.btn-text');
            const spinner = btnSave.querySelector('.spinner');
            if (textSpan) textSpan.textContent = 'Save';
            if (spinner) spinner.style.display = 'none';
          }
        }
      };

      if (btnSave) {
        btnSave.addEventListener('click', doSave);
      }

      if (btnCancel) {
        btnCancel.addEventListener('click', () => {
          editingFeedKey = null;
          renderFeedsList();
        });
      }

      const handleKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editingFeedKey = null;
          renderFeedsList();
        }
      };

      if (renameInput) renameInput.addEventListener('keydown', handleKey);
      if (filterInput) filterInput.addEventListener('keydown', handleKey);
    }
  }

  btnRefreshAll.addEventListener('click', async () => {
    btnRefreshAll.disabled = true;
    const spinner = btnRefreshAll.querySelector('.spinner');
    spinner.style.display = 'inline-block';
    try {
      await api('/api/feed/refresh-all', { method: 'POST' });
      showToast('All feeds refreshed!');
      await loadFeeds();
    } catch (err) {
      showToast(`Refresh error: ${err.message}`);
    } finally {
      btnRefreshAll.disabled = false;
      spinner.style.display = 'none';
    }
  });

  // ── Quick Add Feed ────────────────────────────────────────────────────────
  formQuickAdd.addEventListener('submit', async (e) => {
    e.preventDefault();
    quickAddStatus.style.display = 'none';

    const rawUrl = quickUrlInput.value.trim();
    if (!rawUrl) return;

    const btn = document.getElementById('btn-quick-add');
    const spanText = btn.querySelector('span:first-child');
    const spinner = btn.querySelector('.spinner');

    btn.disabled = true;
    spanText.style.display = 'none';
    spinner.style.display = 'inline-block';

    try {
      const res = await api('/api/feed/add', {
        method: 'POST',
        body: JSON.stringify({ targetUrl: rawUrl }),
      });

      quickUrlInput.value = '';
      quickAddStatus.className = 'status-msg success';
      quickAddStatus.innerHTML = `✓ Feed added! <br><code style="font-size:12px;word-break:break-all;">${escapeHtml(res.rssUrl || '')}</code>`;
      quickAddStatus.style.display = 'block';

      showToast('Feed added successfully!');
      loadFeeds();
    } catch (err) {
      quickAddStatus.className = 'status-msg error';
      quickAddStatus.textContent = err.message;
      quickAddStatus.style.display = 'block';
    } finally {
      btn.disabled = false;
      spanText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  });

  // ── Reddit Builder Logic ──────────────────────────────────────────────────
  redditTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      redditTabs.forEach((t) => t.classList.remove('active'));
      redditViews.forEach((v) => v.style.display = 'none');

      tab.classList.add('active');
      const targetView = document.getElementById(`reddit-view-${tab.dataset.rtype}`);
      if (targetView) targetView.style.display = 'block';
    });
  });

  // Pills toggle helper
  function setupPills(pills, onChange) {
    pills.forEach((p) => {
      p.addEventListener('click', () => {
        pills.forEach((item) => item.classList.remove('active'));
        p.classList.add('active');
        if (onChange) onChange(p);
      });
    });
  }

  setupPills(redditSubSortPills, (active) => {
    const isTop = active.dataset.sort === 'top';
    redditSubTimeGroup.style.display = isTop ? 'block' : 'none';
  });

  setupPills(redditSubTimePills);

  setupPills(redditSearchSortPills, (active) => {
    const isTop = active.dataset.sort === 'top';
    redditSearchTimeGroup.style.display = isTop ? 'block' : 'none';
  });

  setupPills(redditSearchTimePills);
  setupPills(redditUserSortPills);

  btnSubmitReddit.addEventListener('click', async () => {
    redditStatus.style.display = 'none';

    // Find active tab
    const activeTab = document.querySelector('.reddit-tab.active');
    const rType = activeTab ? activeTab.dataset.rtype : 'subreddit';

    let targetUrl = '';
    let alias = document.getElementById('reddit-custom-alias').value.trim();
    let directExternalLink = document.getElementById('reddit-direct-link').checked;

    if (rType === 'subreddit') {
      const sub = document.getElementById('reddit-sub-name').value.trim().replace(/^r\//i, '');
      if (!sub) {
        alert('Please enter a subreddit name');
        return;
      }
      const sort = document.querySelector('#reddit-sub-sort-pills .pill.active')?.dataset.sort || 'hot';
      const time = document.querySelector('#reddit-sub-timeframe-pills .pill.active')?.dataset.time || 'day';

      targetUrl = `https://www.reddit.com/r/${sub}/${sort}/`;
      if (sort === 'top') {
        targetUrl += `?t=${time}`;
      }
      if (!alias) alias = `r/${sub}`;
    } else if (rType === 'search') {
      const sub = document.getElementById('reddit-search-sub').value.trim().replace(/^r\//i, '') || 'all';
      const q = document.getElementById('reddit-search-query').value.trim();
      if (!q) {
        alert('Please enter a search query');
        return;
      }
      const sort = document.querySelector('#reddit-search-sort-pills .pill.active')?.dataset.sort || 'relevance';
      const time = document.querySelector('#reddit-search-timeframe-pills .pill.active')?.dataset.time || 'all';

      targetUrl = `https://www.reddit.com/r/${sub}/search/?q=${encodeURIComponent(q)}&sort=${sort}&t=${time}`;
      if (!alias) alias = `Search: ${q}`;
    } else if (rType === 'user') {
      const u = document.getElementById('reddit-user-name').value.trim().replace(/^(?:u|user)\//i, '');
      if (!u) {
        alert('Please enter a username');
        return;
      }
      const sort = document.querySelector('#reddit-user-sort-pills .pill.active')?.dataset.sort || 'new';
      targetUrl = `https://www.reddit.com/user/${u}/submitted/?sort=${sort}`;
      if (!alias) alias = `u/${u}`;
    } else {
      targetUrl = document.getElementById('reddit-direct-url').value.trim();
      if (!targetUrl) {
        alert('Please enter a Reddit URL');
        return;
      }
    }

    const flairRaw = document.getElementById('reddit-flair-input').value.trim();
    const flairs = flairRaw ? flairRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    const kwRaw = document.getElementById('reddit-keyword-input').value.trim();
    const filterKeywords = kwRaw ? kwRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    const btnText = btnSubmitReddit.querySelector('span:first-child');
    const spinner = btnSubmitReddit.querySelector('.spinner');
    btnSubmitReddit.disabled = true;
    btnText.style.display = 'none';
    spinner.style.display = 'inline-block';

    try {
      const res = await api('/api/feed/add', {
        method: 'POST',
        body: JSON.stringify({
          platform: 'reddit',
          targetUrl,
          alias,
          flairs,
          filterKeywords,
          directExternalLink,
        }),
      });

      redditStatus.className = 'status-msg success';
      redditStatus.innerHTML = `✓ Reddit Feed Created! <br><code style="font-size:12px;word-break:break-all;">${escapeHtml(res.rssUrl || '')}</code>`;
      redditStatus.style.display = 'block';

      showToast('Reddit feed created!');
      loadFeeds();
    } catch (err) {
      redditStatus.className = 'status-msg error';
      redditStatus.textContent = err.message;
      redditStatus.style.display = 'block';
    } finally {
      btnSubmitReddit.disabled = false;
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  });

  // ── Custom Website Studio Logic ───────────────────────────────────────────
  formCustomStart.addEventListener('submit', async (e) => {
    e.preventDefault();
    customStartStatus.style.display = 'none';

    const url = customTargetUrl.value.trim();
    if (!url) return;

    const btn = document.getElementById('btn-custom-start');
    const spanText = btn.querySelector('span:first-child');
    const spinner = btn.querySelector('.spinner');

    btn.disabled = true;
    spanText.style.display = 'none';
    spinner.style.display = 'inline-block';

    try {
      const res = await api('/api/custom-wizard/start', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });

      activeWizardId = res.wizardId;
      activeWizardData = res;

      // Render step B
      studioPageTitle.textContent = res.pageTitle || 'Custom Site';
      studioPageUrl.textContent = res.pageUrl;
      customFeedName.value = res.pageTitle || '';
      studioScreenshot.src = res.screenshot;

      // Render candidates pills if any
      if (res.candidates && res.candidates.length > 0) {
        studioCandidatesList.innerHTML = res.candidates.map((c) => {
          return `<button type="button" class="candidate-pill" data-sel="${escapeHtml(c.selector)}">${escapeHtml(c.selector)} (${c.count})</button>`;
        }).join('');
        studioCandidatesRow.style.display = 'flex';

        studioCandidatesList.querySelectorAll('.candidate-pill').forEach((pill) => {
          pill.addEventListener('click', () => {
            selectCustomSelector(pill.dataset.sel);
          });
        });
      } else {
        studioCandidatesRow.style.display = 'none';
      }

      customStepUrl.style.display = 'none';
      customStepInteractive.style.display = 'flex';
      selectionDrawer.style.display = 'none';
      touchMarker.style.display = 'none';

      showToast('Page loaded! Tap an element to select it.');
    } catch (err) {
      customStartStatus.className = 'status-msg error';
      customStartStatus.textContent = err.message;
      customStartStatus.style.display = 'block';
    } finally {
      btn.disabled = false;
      spanText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  });

  // Handle tap on the visual screenshot
  studioScreenshot.addEventListener('click', async (e) => {
    if (!activeWizardId) return;

    const rect = studioScreenshot.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const percentX = clickX / rect.width;
    const percentY = clickY / rect.height;

    // Show touch marker ripple
    touchMarker.style.left = `${clickX}px`;
    touchMarker.style.top = `${clickY}px`;
    touchMarker.style.display = 'block';

    // Show loader
    studioLoaderText.textContent = 'Analyzing repeating element…';
    studioLoader.style.display = 'flex';

    try {
      const res = await api('/api/custom-wizard/click', {
        method: 'POST',
        body: JSON.stringify({
          wizardId: activeWizardId,
          percentX,
          percentY,
        }),
      });

      if (res.error) {
        showToast(res.error, 4000);
        return;
      }

      handleCustomSelectionResult(res);
    } catch (err) {
      showToast(`Selection error: ${err.message}`);
    } finally {
      studioLoader.style.display = 'none';
    }
  });

  async function selectCustomSelector(selector) {
    if (!activeWizardId || !selector) return;

    studioLoaderText.textContent = `Analyzing ${selector}…`;
    studioLoader.style.display = 'flex';

    try {
      const res = await api('/api/custom-wizard/click', {
        method: 'POST',
        body: JSON.stringify({
          wizardId: activeWizardId,
          selector,
        }),
      });

      if (res.error) {
        showToast(res.error, 4000);
        return;
      }

      handleCustomSelectionResult(res);
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      studioLoader.style.display = 'none';
    }
  }

  function handleCustomSelectionResult(res) {
    // Update screenshot with green highlights
    if (res.screenshot) {
      studioScreenshot.src = res.screenshot;
    }

    drawerMatchCount.textContent = `✓ ${res.count} Items Found`;
    drawerSelectorDisplay.textContent = res.selector;

    // Render preview list
    const items = res.items || [];
    drawerItemsPreview.innerHTML = items.slice(0, 8).map((item, i) => `
      <div class="preview-item">
        <div class="preview-item-title">${i + 1}. ${escapeHtml(item.title || '(No title)')}</div>
        <div class="preview-item-meta">
          <span>${item.date ? escapeHtml(item.date.slice(0, 10)) : 'No date'}</span>
          <span>${item.link ? '🔗 Has link' : ''}</span>
        </div>
      </div>
    `).join('');

    if (items.length > 8) {
      drawerItemsPreview.innerHTML += `
        <div style="text-align: center; font-size: 12px; color: var(--text-dim); padding: 4px;">
          + ${items.length - 8} more items
        </div>
      `;
    }

    selectionDrawer.style.display = 'block';
    showToast(`Found ${res.count} items! Review and confirm below.`);
  }

  btnScrollPage.addEventListener('click', async () => {
    if (!activeWizardId) return;

    btnScrollPage.disabled = true;
    studioLoaderText.textContent = 'Scrolling down to load more items…';
    studioLoader.style.display = 'flex';

    try {
      const res = await api('/api/custom-wizard/scroll', {
        method: 'POST',
        body: JSON.stringify({
          wizardId: activeWizardId,
          scrollCount: 2,
        }),
      });

      handleCustomSelectionResult(res);
      showToast('Scrolled page! Updated items count.');
    } catch (err) {
      showToast(`Scroll error: ${err.message}`);
    } finally {
      btnScrollPage.disabled = false;
      studioLoader.style.display = 'none';
    }
  });

  btnConfirmCustom.addEventListener('click', async () => {
    if (!activeWizardId) return;

    const feedName = customFeedName.value.trim();

    const btnText = btnConfirmCustom.querySelector('span:first-child');
    const spinner = btnConfirmCustom.querySelector('.spinner');

    btnConfirmCustom.disabled = true;
    btnText.style.display = 'none';
    spinner.style.display = 'inline-block';

    try {
      const res = await api('/api/custom-wizard/confirm', {
        method: 'POST',
        body: JSON.stringify({
          wizardId: activeWizardId,
          feedName,
        }),
      });

      activeWizardId = null;
      activeWizardData = null;

      // Reset studio view
      customStepInteractive.style.display = 'none';
      customStepUrl.style.display = 'block';
      customTargetUrl.value = '';

      showToast('Custom feed created successfully!');

      // Switch to Feeds tab
      document.querySelector('[data-tab="tab-feeds"]').click();
      loadFeeds();
    } catch (err) {
      showToast(`Failed to create feed: ${err.message}`);
    } finally {
      btnConfirmCustom.disabled = false;
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  });

  btnCustomCancel.addEventListener('click', async () => {
    if (activeWizardId) {
      try {
        await api('/api/custom-wizard/cancel', {
          method: 'POST',
          body: JSON.stringify({ wizardId: activeWizardId }),
        });
      } catch (_) {}
    }
    activeWizardId = null;
    activeWizardData = null;
    customStepInteractive.style.display = 'none';
    customStepUrl.style.display = 'block';
    showToast('Cancelled setup');
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  checkSession();

})();
