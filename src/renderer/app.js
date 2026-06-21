let state = {
  accounts: [],
  activeAccountId: null,
  settingsOpen: false,
  settings: null,
  editingAccountId: null,
  currentSettingsAccount: null,
  auth: null,
  authRefreshTimer: null,
};

let testToneCtx = null;
let testToneOsc = null;
let testToneGain = null;
let loginGateEl = null;
let startupSubscriptionNoticeShown = false;

const DAY_MS = 24 * 60 * 60 * 1000;

function el(id) {
  return document.getElementById(id);
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

function isLicenseActive(license) {
  if (!license) return false;
  const status = String(license.status || '').toLowerCase();
  if (status !== 'active' && status !== 'trial') return false;
  if (!license.expires_at) return true;
  const d = new Date(license.expires_at);
  return !Number.isNaN(d.getTime()) && d > new Date();
}

function hasActiveLicense(licenses) {
  return Array.isArray(licenses) && licenses.some((license) => isLicenseActive(license));
}

function getLatestSubscription(licenses) {
  const list = Array.isArray(licenses) ? licenses.filter(Boolean) : [];
  if (!list.length) return null;

  return list.slice().sort((a, b) => {
    const aTime = new Date(a.expires_at || 0).getTime();
    const bTime = new Date(b.expires_at || 0).getTime();
    return bTime - aTime;
  })[0];
}

function getSubscriptionContext(licenses) {
  const active = Array.isArray(licenses) ? licenses.find((license) => isLicenseActive(license)) || null : null;
  const current = active || getLatestSubscription(licenses);

  if (!current) {
    return {
      current: null,
      kind: 'none',
      expired: false,
      warning: false,
      daysLeft: null,
      expiresAt: null,
    };
  }

  const kind = String(current.status || '').toLowerCase() === 'trial' ? 'demo' : 'license';
  const expiresAt = current.expires_at ? new Date(current.expires_at) : null;
  const expiresMs = expiresAt ? expiresAt.getTime() : NaN;
  const now = Date.now();
  const expired = Number.isFinite(expiresMs) ? expiresMs <= now : false;
  const msLeft = Number.isFinite(expiresMs) ? expiresMs - now : Infinity;
  const daysLeft = Number.isFinite(expiresMs) ? Math.max(0, Math.ceil(msLeft / DAY_MS)) : null;
  const warning = !expired && Number.isFinite(msLeft) && msLeft <= 3 * DAY_MS;

  return {
    current,
    kind,
    expired,
    warning,
    daysLeft,
    expiresAt,
  };
}

function formatSubscriptionLabel(sub) {
  if (!sub || !sub.current) return 'No active demo or license';

  const typeLabel = sub.kind === 'demo' ? 'Demo' : 'License';
  const dateLabel = formatDate(sub.expiresAt);

  if (sub.expired) {
    return `${typeLabel} ended on ${dateLabel}. To continue, buy or renew subscription.`;
  }

  if (sub.warning) {
    return `Active ${typeLabel.toLowerCase()} until ${dateLabel}. ${sub.daysLeft} day(s) left — buy or renew subscription soon.`;
  }

  return `Active ${typeLabel.toLowerCase()} until ${dateLabel}`;
}

function isUsageLocked() {
  const auth = state.auth || null;
  if (!auth || !auth.accessToken) return false;

  const sub = getSubscriptionContext(auth.licenses);
  return !!(sub.current && sub.expired);
}

function showRenewalRequiredMessage() {
  const auth = state.auth || {};
  const sub = getSubscriptionContext(auth.licenses);
  const typeLabel = sub.kind === 'demo' ? 'демо' : 'лицензия';
  const message = sub.current && sub.expired
    ? `Для дальнейшего использования необходимо купить или продлить подписку. ${typeLabel.toUpperCase()} закончилась ${formatDate(sub.expiresAt)}.\n\nКупить подписку: https://t.me/HAMELEONWEB_bot`
    : 'Для дальнейшего использования необходимо купить или продлить подписку.\n\nКупить подписку: https://t.me/HAMELEONWEB_bot';

  const statusEl = el('authStatus');
  if (statusEl) statusEl.textContent = message;

  const banner = el('subscriptionBanner');
  if (banner) {
    banner.textContent = message;
    banner.classList.remove('hidden', 'status-ok');
    banner.classList.add('status-bad');
  }

  try {
    window.alert(message);
  } catch (e) {}
}

function showSubscriptionNoticeOnStartup() {
  const auth = state.auth || {};
  const sub = getSubscriptionContext(auth.licenses);

  if (!auth.accessToken || !sub.current || startupSubscriptionNoticeShown) {
    return;
  }

  if (sub.expired) {
    startupSubscriptionNoticeShown = true;
    showRenewalRequiredMessage();
    return;
  }

  if (sub.warning) {
    const message = `${formatSubscriptionLabel(sub)}. Для дальнейшего использования необходимо купить или продлить подписку.\n\nКупить подписку: https://t.me/HAMELEONWEB_bot`;
    const statusEl = el('authStatus');
    if (statusEl) statusEl.textContent = message;
    const banner = el('subscriptionBanner');
    if (banner) {
      banner.classList.remove('hidden', 'status-ok');
      banner.classList.add('status-bad');
      banner.textContent = message;
    }
    startupSubscriptionNoticeShown = true;
    try {
      window.alert(message);
    } catch (e) {}
  }
}

function renderSubscriptionBanner() {
  const banner = el('subscriptionBanner');
  const addBtn = el('btnAdd');
  if (addBtn) {
    addBtn.disabled = isUsageLocked();
  }

  if (!banner) return;

  const auth = state.auth || {};
  const sub = getSubscriptionContext(auth.licenses);

  if (!auth.accessToken) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden', 'status-ok', 'status-bad');

  if (sub.current && sub.expired) {
    banner.classList.add('status-bad');
    banner.textContent = `Subscription expired on ${formatDate(sub.expiresAt)}. Buy or renew to continue.`;
    return;
  }

  if (sub.current && sub.warning) {
    banner.classList.add('status-bad');
    banner.textContent = `${formatSubscriptionLabel(sub)}`;
    return;
  }

  if (sub.current) {
    banner.classList.add('status-ok');
    banner.textContent = formatSubscriptionLabel(sub);
  } else {
    banner.classList.add('status-bad');
    banner.textContent = 'No active demo or license found.';
  }

  if (sub.warning && !startupSubscriptionNoticeShown) {
    showSubscriptionNoticeOnStartup();
  }
}

function isAccountClickable() {
  return !isUsageLocked();
}

function renderAuthState() {
  const authStatus = el('authStatus');
  const licenseList = el('licenseList');
  const loginInput = el('telegramLogin');
  const codeInput = el('telegramCode');

  if (!state.auth) {
    if (authStatus) authStatus.textContent = 'Loading license status...';
    if (licenseList) licenseList.innerHTML = '';
    return;
  }

  if (loginInput && !loginInput.value) {
    loginInput.value = state.auth.telegramLogin || '';
  }
  if (codeInput && !codeInput.value) {
    codeInput.value = '';
  }

  const sub = getSubscriptionContext(state.auth.licenses);

  if (!state.auth.accessToken) {
    if (authStatus) authStatus.textContent = 'Not signed in. Request a code from Telegram login.';
  } else if (sub.current) {
    if (authStatus) {
      authStatus.textContent = `${formatSubscriptionLabel(sub)} (checked ${formatDate(state.auth.lastCheckedAt)})`;
    }
  } else {
    if (authStatus) {
      authStatus.textContent = `Signed in, but no active demo or license found (checked ${formatDate(state.auth.lastCheckedAt)}).`;
    }
  }

  if (licenseList) {
    const licenses = Array.isArray(state.auth.licenses) ? state.auth.licenses : [];
    licenseList.innerHTML = licenses.length
      ? licenses.map((license) => {
          const active = isLicenseActive(license);
          const statusClass = active ? 'status-ok' : 'status-bad';
          const typeLabel = String(license.status || '').toLowerCase() === 'trial' ? 'DEMO' : 'LICENSE';
          const statusLabel = active ? typeLabel : `EXPIRED ${typeLabel}`;
          const expires = formatDate(license.expires_at);
          return `
            <div class="license-item${active ? ' active' : ''}">
              <div class="key">${license.license_key}</div>
              <div class="meta">Status: <span class="${statusClass}">${statusLabel}</span></div>
              <div class="meta">Expires: ${expires}</div>
              <div class="meta">Devices: ${license.max_devices ?? '—'} | Accounts: ${license.max_accounts ?? '—'}</div>
            </div>
          `;
        }).join('')
      : '<div class="license-item">No licenses yet.</div>';
  }

  renderSubscriptionBanner();
}

function buildLoginGate() {
  if (loginGateEl) return loginGateEl;

  const gate = document.createElement('div');
  gate.id = 'loginGate';
  gate.style.cssText = 'position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;background:rgba(2,5,3,.92);backdrop-filter:blur(10px);padding:16px;';
  gate.innerHTML = `
    <div style="width:min(560px, calc(100vw - 32px)); border:1px solid var(--border-color); background:linear-gradient(180deg, rgba(10, 18, 12, 0.98) 0%, rgba(6, 10, 7, 0.98) 100%); border-radius:20px; padding:28px; box-shadow:0 30px 80px rgba(0,0,0,.5);">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
        <img src="hameleonweb.png" alt="HAMELEON WEB" style="width:72px;height:72px;object-fit:contain;border-radius:14px;" />
        <div>
          <div style="font-size:26px;font-weight:800;letter-spacing:1px;">HAMELEON WEB</div>
          <div style="opacity:.7;font-size:13px;">Telegram login required on first launch</div>
        </div>
      </div>

      <div style="display:grid;gap:12px;">
        <input id="loginGateTelegramLogin" class="input" type="text" placeholder="@username or 123456789" />
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button id="loginGateRequestCode" class="btn secondary">Request code</button>
          <button id="loginGateCheckLicenses" class="btn secondary">Проверить статус лицензии</button>
          <button id="loginGateClearAuth" class="btn secondary">Sign out</button>
        </div>
        <input id="loginGateCode" class="input" type="text" maxlength="6" placeholder="123456" />
        <button id="loginGateVerify" class="btn" style="padding:12px 14px;">Verify & continue</button>
        <div id="loginGateStatus" class="hint" style="min-height:18px;"></div>
        <div id="loginGateLicenseList" class="license-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(gate);
  loginGateEl = gate;
  return gate;
}

function showLoginGate() {
  const gate = buildLoginGate();
  gate.style.display = 'flex';
  const auth = state.auth || {};
  const loginInput = gate.querySelector('#loginGateTelegramLogin');
  const codeInput = gate.querySelector('#loginGateCode');
  if (loginInput) loginInput.value = auth.telegramLogin || '';
  if (codeInput) codeInput.value = '';
  renderLoginGateAuth();
}

function hideLoginGate() {
  if (loginGateEl) {
    loginGateEl.style.display = 'none';
  }
}

function renderLoginGateAuth() {
  const gate = loginGateEl;
  if (!gate) return;

  const statusEl = gate.querySelector('#loginGateStatus');
  const licenseList = gate.querySelector('#loginGateLicenseList');
  const auth = state.auth || {};
  const sub = getSubscriptionContext(auth.licenses);

  if (!auth.accessToken) {
    if (statusEl) statusEl.textContent = 'Not signed in. Request a code from Telegram login.';
  } else if (sub.current) {
    if (statusEl) {
      statusEl.textContent = `${formatSubscriptionLabel(sub)} (checked ${formatDate(auth.lastCheckedAt)})`;
    }
  } else {
    if (statusEl) {
      statusEl.textContent = `Signed in, but no active demo or license found (checked ${formatDate(auth.lastCheckedAt)}).`;
    }
  }

  if (licenseList) {
    const licenses = Array.isArray(auth.licenses) ? auth.licenses : [];
    licenseList.innerHTML = licenses.length
      ? licenses.map((license) => {
          const active = isLicenseActive(license);
          const statusClass = active ? 'status-ok' : 'status-bad';
          const typeLabel = String(license.status || '').toLowerCase() === 'trial' ? 'DEMO' : 'LICENSE';
          const statusLabel = active ? typeLabel : `EXPIRED ${typeLabel}`;
          return `
            <div class="license-item${active ? ' active' : ''}">
              <div class="key">${license.license_key}</div>
              <div class="meta">Status: <span class="${statusClass}">${statusLabel}</span></div>
              <div class="meta">Expires: ${formatDate(license.expires_at)}</div>
            </div>
          `;
        }).join('')
      : '<div class="license-item">No licenses yet.</div>';
  }
}

async function loadAuthState() {
  state.auth = await window.api.authGet();
  renderAuthState();
  renderLoginGateAuth();
  return state.auth;
}

async function saveApiBaseUrlFromInput() {
  // API URL is hardcoded to production — no-op
}

async function requestLoginCodeFromUI() {
  await saveApiBaseUrlFromInput();
  const telegramLogin = String(el('telegramLogin').value || '').trim();
  const res = await window.api.authRequestCode({ telegramLogin });
  state.auth = await window.api.authGet();
  state.auth.lastError = '';
  renderAuthState();
  renderLoginGateAuth();
  if (el('authStatus')) {
    el('authStatus').textContent = res && res.message ? `${res.message} Check Telegram.` : 'Code requested. Check Telegram.';
  }
}

async function verifyLoginCodeFromUI() {
  await saveApiBaseUrlFromInput();
  const telegramLogin = String(el('telegramLogin').value || '').trim();
  const code = String(el('telegramCode').value || '').trim();
  const res = await window.api.authVerifyCode({ telegramLogin, code });
  state.auth = res;
  renderAuthState();
  renderLoginGateAuth();
  if (hasActiveLicense(state.auth && state.auth.licenses)) {
    hideLoginGate();
  }
  if (el('authStatus')) {
    el('authStatus').textContent = 'License verified and activated.';
  }
}

async function refreshLicensesFromUI(silent = false) {
  await saveApiBaseUrlFromInput();
  const res = await window.api.authRefreshLicenses();
  state.auth = res;
  renderAuthState();
  renderLoginGateAuth();
  if (state.auth && state.auth.accessToken) {
    hideLoginGate();
  }
  if (!silent && el('authStatus')) {
    el('authStatus').textContent = `${formatSubscriptionLabel(getSubscriptionContext(res.licenses))} (checked ${formatDate(res.lastCheckedAt)})`;
  }
}

async function clearAuthFromUI() {
  await window.api.authClear();
  state.auth = await window.api.authGet();
  renderAuthState();
  renderLoginGateAuth();
  showLoginGate();
}

async function signOutFromMainSettings() {
  await clearAuthFromUI();
  const settingsPanel = el('settingsPanel');
  const contentPlaceholder = el('contentPlaceholder');
  if (settingsPanel) {
    settingsPanel.classList.add('hidden');
  }
  if (contentPlaceholder) {
    contentPlaceholder.classList.remove('hidden');
  }
}

async function ensureAuthVisibleIfNeeded() {
  const auth = await loadAuthState();
  if (!auth || !auth.accessToken) {
    showLoginGate();
  } else {
    try {
      state.auth = await window.api.authRefreshLicenses();
    } catch (e) {
      state.auth = auth;
      state.auth.lastError = e && e.message ? e.message : String(e);
    }
    renderAuthState();
    renderLoginGateAuth();
    showSubscriptionNoticeOnStartup();
    hideLoginGate();
  }
}

async function bindLoginGate() {
  const gate = buildLoginGate();
  const requestBtn = gate.querySelector('#loginGateRequestCode');
  const checkBtn = gate.querySelector('#loginGateCheckLicenses');
  const verifyBtn = gate.querySelector('#loginGateVerify');
  const clearBtn = gate.querySelector('#loginGateClearAuth');
  const statusEl = gate.querySelector('#loginGateStatus');

  const btnSignOutMain = el('btnSignOutMain');
  if (btnSignOutMain) {
    btnSignOutMain.addEventListener('click', async () => {
      try {
        await signOutFromMainSettings();
        if (el('authStatus')) el('authStatus').textContent = 'Signed out. Re-authorize to continue.';
      } catch (e) {
        if (el('authStatus')) el('authStatus').textContent = `Sign out error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  if (requestBtn) {
    requestBtn.addEventListener('click', async () => {
      try {
        const telegramLogin = String(gate.querySelector('#loginGateTelegramLogin').value || '').trim();
        const res = await window.api.authRequestCode({ telegramLogin });
        state.auth = await window.api.authGet();
        renderLoginGateAuth();
        if (statusEl) statusEl.textContent = res && res.message ? `${res.message} Проверь Telegram.` : 'Код отправлен. Проверь Telegram.';
      } catch (e) {
        if (statusEl) statusEl.textContent = `Request code error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      try {
        const telegramLogin = String(gate.querySelector('#loginGateTelegramLogin').value || '').trim();
        const code = String(gate.querySelector('#loginGateCode').value || '').trim();
        const res = await window.api.authVerifyCode({ telegramLogin, code });
        state.auth = res;
        renderLoginGateAuth();
        renderAuthState();
        if (state.auth && state.auth.accessToken) {
          hideLoginGate();
        }
        if (statusEl) statusEl.textContent = `${formatSubscriptionLabel(getSubscriptionContext(state.auth && state.auth.licenses))}.`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Verify code error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      try {
        await applyApiBaseUrl();
        await refreshLicensesFromUI(true);
        if (statusEl) statusEl.textContent = `${formatSubscriptionLabel(getSubscriptionContext(state.auth && state.auth.licenses))}.`;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Refresh licenses error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        await clearAuthFromUI();
        if (statusEl) statusEl.textContent = 'Signed out.';
      } catch (e) {
        if (statusEl) statusEl.textContent = `Sign out error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }
}

function showAccountSettings(account) {
  const modal = el('accountSettingsModal');
  if (!modal) {
    // Create modal if it doesn't exist
    createAccountSettingsModal();
    showAccountSettings(account);
    return;
  }

  const sidebar = el('sidebar');
  const sidebarWidth = sidebar ? sidebar.offsetWidth : 280;
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);

  // Set current account
  state.currentSettingsAccount = account;
  
  // Populate form with current data
  el('settingsAccountName').textContent = account.name || account.id;
  el('proxyHost').value = account.proxyHost || '';
  el('proxyPort').value = account.proxyPort || '';
  el('proxyUsername').value = account.proxyUsername || '';
  el('proxyPassword').value = account.proxyPassword || '';
  
  // Show modal
  modal.classList.remove('hidden');
}

function createAccountSettingsModal() {
  const modal = document.createElement('div');
  modal.id = 'accountSettingsModal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Настройки аккаунта: <span id="settingsAccountName"></span></h3>
        <button class="btn secondary icon-btn" onclick="hideAccountSettings()">❌</button>
      </div>
      <div class="modal-body">
        <div class="form-section">
          <h4>🌐 Настройки прокси</h4>
          <div class="form-group">
            <label>Хост (IP адрес):</label>
            <input type="text" id="proxyHost" placeholder="192.168.1.100">
          </div>
          <div class="form-group">
            <label>Порт:</label>
            <input type="tel" id="proxyPort" inputmode="numeric" autocomplete="off" placeholder="8080">
          </div>
          <div class="form-group">
            <label>Логин (опционально):</label>
            <input type="text" id="proxyUsername" placeholder="username">
          </div>
          <div class="form-group">
            <label>Пароль (опционально):</label>
            <input type="password" id="proxyPassword" placeholder="password">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn secondary modal-icon-btn" title="Отмена" aria-label="Отмена" onclick="hideAccountSettings()">✖️</button>
        <button class="btn danger modal-icon-btn" title="Удалить аккаунт" aria-label="Удалить аккаунт" onclick="deleteAccount()">🗑️</button>
        <button class="btn primary modal-icon-btn" title="Сохранить" aria-label="Сохранить" onclick="saveAccountSettings()">💾</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function hideAccountSettings() {
  const modal = el('accountSettingsModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  state.currentSettingsAccount = null;
}

async function saveAccountSettings() {
  if (!state.currentSettingsAccount) return;
  
  const proxyHost = el('proxyHost').value.trim();
  const proxyPort = el('proxyPort').value.trim();
  const proxyUsername = el('proxyUsername').value.trim();
  const proxyPassword = el('proxyPassword').value.trim();
  
  // Build proxy string
  let proxyString = '';
  if (proxyHost && proxyPort) {
    if (proxyUsername && proxyPassword) {
      proxyString = `http://${proxyUsername}:${proxyPassword}@${proxyHost}:${proxyPort}`;
    } else {
      proxyString = `http://${proxyHost}:${proxyPort}`;
    }
  }
  
  try {
    // Update account with proxy settings
    const res = await window.api.accountsUpdate(state.currentSettingsAccount.id, {
      proxy: proxyString
    });
    
    state.accounts = res.accounts;
    hideAccountSettings();
    alert('Настройки сохранены!');
  } catch (error) {
    alert('Ошибка сохранения: ' + error.message);
  }
}

async function deleteAccount() {
  if (!state.currentSettingsAccount) return;
  
  const ok = confirm(`Удалить аккаунт "${state.currentSettingsAccount.name || state.currentSettingsAccount.id}" и все его данные?`);
  if (!ok) return;
  
  try {
    const res = await window.api.accountsDelete(state.currentSettingsAccount.id);
    state.accounts = res.accounts;
    
    if (state.activeAccountId === state.currentSettingsAccount.id) {
      state.activeAccountId = null;
    }
    
    hideAccountSettings();
    renderAccounts();
    alert('Аккаунт удален!');
  } catch (error) {
    alert('Ошибка удаления: ' + error.message);
  }
}

function setSelectOptions(selectEl, options, selectedValue) {
  if (!selectEl) return;
  selectEl.innerHTML = '';

  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    selectEl.appendChild(o);
  }

  if (selectedValue != null) {
    selectEl.value = selectedValue;
  }
}

function getDeviceValue(selectId, manualId) {
  const selectEl = el(selectId);
  const manualEl = el(manualId);
  if (!selectEl) return 'default';
  if (selectEl.value === '__manual__') {
    return String((manualEl && manualEl.value) || '').trim() || 'default';
  }
  return String(selectEl.value || '').trim() || 'default';
}

function startTestTone(durationMs) {
  try {
    if (!testToneCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      testToneCtx = new AudioCtx();
    }
    if (testToneCtx.state === 'suspended') {
      testToneCtx.resume();
    }

    if (testToneOsc) {
      try {
        testToneOsc.stop();
      } catch (e) {}
      testToneOsc = null;
    }

    testToneOsc = testToneCtx.createOscillator();
    testToneGain = testToneCtx.createGain();
    testToneOsc.type = 'sine';
    testToneOsc.frequency.value = 440;
    testToneGain.gain.value = 0.04;

    testToneOsc.connect(testToneGain);
    testToneGain.connect(testToneCtx.destination);
    testToneOsc.start();

    const stop = () => {
      try {
        if (testToneOsc) testToneOsc.stop();
      } catch (e) {}
      testToneOsc = null;
      testToneGain = null;
    };

    setTimeout(stop, Math.max(0, Number(durationMs) || 0));
    return stop;
  } catch (e) {
    return () => {};
  }
}

function syncDeviceInput(selectId, manualId, value) {
  const selectEl = el(selectId);
  const manualEl = el(manualId);
  if (!selectEl || !manualEl) return;

  const isManual = value && value !== 'default' && !Array.from(selectEl.options).some((o) => o.value === value);
  if (isManual) {
    manualEl.classList.remove('hidden');
    manualEl.value = value;
    selectEl.value = '__manual__';
  } else {
    manualEl.classList.add('hidden');
    manualEl.value = '';
    selectEl.value = value || 'default';
  }
}

function setActive(accountId) {
  state.activeAccountId = accountId;
  renderAccounts();
}

function renderAccounts() {
  const root = el('accounts');
  root.innerHTML = '';

  const locked = isUsageLocked();

  for (const a of state.accounts) {
    const row = document.createElement('div');
    row.className = `account${a.id === state.activeAccountId ? ' active' : ''}${locked ? ' locked' : ''}`;

    const left = document.createElement('div');
    left.className = 'name';

    const isEditing = state.editingAccountId === a.id;
    
    // Add pencil icon to the left of name
    if (!isEditing) {
      const btnRename = document.createElement('button');
      btnRename.className = 'btn secondary icon-btn rename-btn';
      btnRename.title = 'Rename';
      btnRename.textContent = '✏️';
      btnRename.onclick = async (e) => {
        e.stopPropagation();
        state.editingAccountId = a.id;
        renderAccounts();
      };
      left.appendChild(btnRename);
    }
    
    // Add name or input field
    if (isEditing) {
      const input = document.createElement('input');
      input.className = 'input account-rename-input';
      input.value = a.name || a.id;
      input.onclick = (e) => e.stopPropagation();
      input.onkeydown = async (e) => {
        if (e.key === 'Escape') {
          state.editingAccountId = null;
          renderAccounts();
          return;
        }
        if (e.key === 'Enter') {
          const nextName = String(input.value || '').trim();
          if (!nextName) return;
          const res = await window.api.accountsRename(a.id, nextName);
          state.accounts = res.accounts;
          state.editingAccountId = null;
          renderAccounts();
        }
      };
      setTimeout(() => {
        try {
          input.focus();
          input.select();
        } catch (e) {}
      }, 0);
      left.appendChild(input);
    } else {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'account-name';
      nameSpan.textContent = a.name || a.id;
      left.appendChild(nameSpan);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    // Add save/cancel buttons only during editing
    if (isEditing) {
      const btnSave = document.createElement('button');
      btnSave.className = 'btn secondary icon-btn';
      btnSave.title = 'Save';
      btnSave.textContent = '💾';
      btnSave.onclick = async (e) => {
        e.stopPropagation();
        const input = row.querySelector('input.account-rename-input');
        const nextName = String((input && input.value) || '').trim();
        if (!nextName) return;
        const res = await window.api.accountsRename(a.id, nextName);
        state.accounts = res.accounts;
        state.editingAccountId = null;
        renderAccounts();
      };

      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn secondary icon-btn';
      btnCancel.title = 'Cancel';
      btnCancel.textContent = '❌';
      btnCancel.onclick = (e) => {
        e.stopPropagation();
        state.editingAccountId = null;
        renderAccounts();
      };

      actions.appendChild(btnSave);
      actions.appendChild(btnCancel);
    }

    // Add action buttons (reset, settings) - only show when not editing
    if (!isEditing) {
      const btnReset = document.createElement('button');
      btnReset.className = 'btn secondary icon-btn';
      btnReset.title = 'Reload page';
      btnReset.textContent = '🔄';
      btnReset.onclick = async (e) => {
        e.stopPropagation();
        await window.api.reloadActive();
      };

      const btnSettings = document.createElement('button');
      btnSettings.className = 'btn secondary icon-btn';
      btnSettings.title = 'Account settings';
      btnSettings.textContent = '⚙️';
      btnSettings.onclick = async (e) => {
        e.stopPropagation();
        showAccountSettings(a);
      };

      actions.appendChild(btnReset);
      actions.appendChild(btnSettings);
    }

    if (locked) {
      row.title = 'Для дальнейшего использования необходимо купить или продлить подписку';
      row.querySelectorAll('button').forEach((btn) => {
        btn.disabled = true;
      });
    }

    row.appendChild(left);
    row.appendChild(actions);

    row.onclick = async () => {
      if (state.editingAccountId) return;
      if (isUsageLocked()) {
        showRenewalRequiredMessage();
        return;
      }
      state.settingsOpen = false;
      el('settingsPanel').classList.add('hidden');
      el('contentPlaceholder').classList.add('hidden');

      await window.api.selectAccount(a.id);
      setActive(a.id);
    };

    root.appendChild(row);
  }
}

async function refreshAccounts() {
  state.accounts = await window.api.accountsList();
  renderAccounts();
}

async function openSettings() {
  await window.api.openSettings();
  state.settingsOpen = true;

  el('contentPlaceholder').classList.add('hidden');
  el('settingsPanel').classList.remove('hidden');

  const s = await window.api.settingsGet();
  state.settings = s;

  el('alwaysRecord').checked = !!s.alwaysRecord;
  el('recordingsPath').value = s.recordingsPath || '';
  el('mp3Quality').value = s.mp3Quality ?? 4;
  el('telegramLogin').value = (state.auth && state.auth.telegramLogin) || '';
  el('telegramCode').value = '';

  el('versions').textContent = `Electron: ${s.versions.electron}\nChromium: ${s.versions.chrome}\nNode: ${s.versions.node}`;

  let names = [];
  try {
    names = await window.api.listDevices();
  } catch (e) {
    names = [];
  }

  const base = [
    { value: 'default', label: 'default' },
    { value: '__manual__', label: 'Manual…' },
  ];
  const deviceOptions = base.concat(names.map((n) => ({ value: n, label: n })));

  setSelectOptions(el('micDeviceSelect'), deviceOptions, s.micDevice || 'default');
  setSelectOptions(el('speakerDeviceSelect'), deviceOptions, s.speakerDevice || 'default');

  syncDeviceInput('micDeviceSelect', 'micDeviceManual', s.micDevice || 'default');
  syncDeviceInput('speakerDeviceSelect', 'speakerDeviceManual', s.speakerDevice || 'default');

  renderAuthState();
}

async function bindSettings() {
  el('alwaysRecord').addEventListener('change', async () => {
    await window.api.settingsSet({ alwaysRecord: el('alwaysRecord').checked });
  });

  const saveText = async (id, key) => {
    const v = el(id).value;
    await window.api.settingsSet({ [key]: v });
  };

  el('recordingsPath').addEventListener('blur', () => saveText('recordingsPath', 'recordingsPath'));

  const bindDevice = (selectId, manualId, key) => {
    const selectEl = el(selectId);
    const manualEl = el(manualId);

    if (selectEl) {
      selectEl.addEventListener('change', async () => {
        if (selectEl.value === '__manual__') {
          if (manualEl) {
            manualEl.classList.remove('hidden');
            manualEl.focus();
          }
          return;
        }
        if (manualEl) {
          manualEl.classList.add('hidden');
          manualEl.value = '';
        }
        await window.api.settingsSet({ [key]: selectEl.value });
      });
    }

    if (manualEl) {
      manualEl.addEventListener('blur', async () => {
        const v = String(manualEl.value || '').trim() || 'default';
        await window.api.settingsSet({ [key]: v });
      });
    }
  };

  bindDevice('micDeviceSelect', 'micDeviceManual', 'micDevice');
  bindDevice('speakerDeviceSelect', 'speakerDeviceManual', 'speakerDevice');

  el('mp3Quality').addEventListener('change', async () => {
    const q = parseInt(el('mp3Quality').value, 10);
    if (Number.isFinite(q)) {
      await window.api.settingsSet({ mp3Quality: Math.max(0, Math.min(9, q)) });
    }
  });

  const btnRequestCode = el('btnRequestCode');
  if (btnRequestCode) {
    btnRequestCode.addEventListener('click', async () => {
      try {
        await requestLoginCodeFromUI();
      } catch (e) {
        if (el('authStatus')) el('authStatus').textContent = `Request code error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  const btnVerifyCode = el('btnVerifyCode');
  if (btnVerifyCode) {
    btnVerifyCode.addEventListener('click', async () => {
      try {
        await verifyLoginCodeFromUI();
      } catch (e) {
        if (el('authStatus')) el('authStatus').textContent = `Verify code error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  const btnRefreshLicenses = el('btnRefreshLicenses');
  if (btnRefreshLicenses) {
    btnRefreshLicenses.addEventListener('click', async () => {
      try {
        await refreshLicensesFromUI();
      } catch (e) {
        if (el('authStatus')) el('authStatus').textContent = `Refresh licenses error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  const btnClearAuth = el('btnClearAuth');
  if (btnClearAuth) {
    btnClearAuth.addEventListener('click', async () => {
      try {
        await clearAuthFromUI();
      } catch (e) {
        if (el('authStatus')) el('authStatus').textContent = `Sign out error: ${e && e.message ? e.message : String(e)}`;
      }
    });
  }

  el('btnBrowsePath').addEventListener('click', async () => {
    const res = await window.api.pickRecordingsPath();
    if (res.canceled) return;
    el('recordingsPath').value = res.path;
    await window.api.settingsSet({ recordingsPath: res.path });
  });

  el('btnListDevices').addEventListener('click', async () => {
    el('devicesList').value = 'Loading...';
    const names = await window.api.listDevices();
    el('devicesList').value = names.length ? names.join('\n') : 'No devices found (or ffmpeg failed).';

    const current = await window.api.settingsGet();
    const base = [{ value: 'default', label: 'default' }, { value: '__manual__', label: 'Manual…' }];
    const deviceOptions = base.concat(names.map((n) => ({ value: n, label: n })));
    setSelectOptions(el('micDeviceSelect'), deviceOptions, current.micDevice || 'default');
    setSelectOptions(el('speakerDeviceSelect'), deviceOptions, current.speakerDevice || 'default');
    syncDeviceInput('micDeviceSelect', 'micDeviceManual', current.micDevice || 'default');
    syncDeviceInput('speakerDeviceSelect', 'speakerDeviceManual', current.speakerDevice || 'default');
  });

  el('btnOpenFolder').addEventListener('click', async () => {
    await window.api.openRecordingsFolder();
  });

  const btnCheckUpdate = el('btnCheckUpdate');
  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', async () => {
      const statusEl = el('updateStatus');
      btnCheckUpdate.disabled = true;
      if (statusEl) statusEl.textContent = '⏳ Проверяю обновления...';
      try {
        const res = await window.api.checkUpdate();
        if (res.error) {
          if (statusEl) statusEl.textContent = `❌ Ошибка: ${res.error}`;
          return;
        }
        if (!res.newer) {
          if (statusEl) statusEl.textContent = `✅ У вас последняя версия (${res.currentVersion})`;
          return;
        }
        if (statusEl) {
          statusEl.innerHTML = `🆕 Доступна версия <b>${res.latestVersion}</b> (текущая: ${res.currentVersion})${res.notes ? '<br>' + res.notes : ''}<br><button id="btnInstallUpdate" class="btn" style="margin-top:8px">⬇️ Скачать и установить</button>`;
          const btnInstall = el('btnInstallUpdate');
          if (btnInstall) {
            btnInstall.addEventListener('click', async () => {
              btnInstall.disabled = true;
              const progressId = 'dlProgressLine';
              if (statusEl) statusEl.innerHTML += `<br><span id="${progressId}">⏳ Скачиваю установщик... 0%</span>`;

              let unsubscribe = null;
              if (window.api.onDownloadProgress) {
                unsubscribe = window.api.onDownloadProgress((data) => {
                  const progressEl = document.getElementById(progressId);
                  if (progressEl) progressEl.textContent = `⏳ Скачиваю установщик... ${data.percent}%`;
                });
              }

              const r = await window.api.installUpdate({ url: res.url });
              if (unsubscribe) unsubscribe();

              if (r && r.error) {
                const progressEl = document.getElementById(progressId);
                if (progressEl) progressEl.textContent = `❌ ${r.error}`;
                btnInstall.disabled = false;
              } else {
                const progressEl = document.getElementById(progressId);
                if (progressEl) progressEl.textContent = '✅ Установщик запущен. Приложение закроется...';
              }
            });
          }
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = `❌ ${e && e.message ? e.message : String(e)}`;
      } finally {
        btnCheckUpdate.disabled = false;
      }
    });
  }

  const btnTest = el('btnTestRecording');
  if (btnTest) {
    btnTest.addEventListener('click', async () => {
      btnTest.disabled = true;

      const statusEl = el('testRecordingStatus');
      const audioEl = el('testRecordingPlayback');

      if (statusEl) statusEl.textContent = 'Recording 10 sec...';
      if (audioEl) {
        audioEl.classList.add('hidden');
        audioEl.removeAttribute('src');
        audioEl.load();
      }

      const stopTone = startTestTone(10000);

      try {
        const micDevice = getDeviceValue('micDeviceSelect', 'micDeviceManual');
        const speakerDevice = getDeviceValue('speakerDeviceSelect', 'speakerDeviceManual');
        const mp3Quality = parseInt(el('mp3Quality').value, 10);

        const res = await window.api.testRecording({
          micDevice,
          speakerDevice,
          mp3Quality: Number.isFinite(mp3Quality) ? mp3Quality : 4,
          durationSec: 10,
        });

        if (!res || !res.ok) {
          const msg = (res && res.error) || 'Test recording failed.';
          if (statusEl) statusEl.textContent = msg;
          return;
        }

        if (statusEl) {
          const backend = res.backend ? String(res.backend) : '';
          const backendText = backend ? ` (${backend})` : '';
          const baseText = res.savedPath ? `Done. Saved: ${res.savedPath}${backendText}` : `Done.${backendText}`;

          if (backend === 'dshow') {
            statusEl.textContent = `${baseText}. Note: dshow usually records mic only in RDP (no system audio loopback).`;
          } else {
            statusEl.textContent = baseText;
          }
        }
        if (audioEl && (res.fileUrl || res.dataUrl)) {
          audioEl.onerror = () => {
            if (statusEl) statusEl.textContent = 'Playback error (audio decode/load failed).';
          };
          audioEl.src = res.fileUrl || res.dataUrl;
          audioEl.classList.remove('hidden');
          audioEl.load();
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = `Error: ${e && e.message ? e.message : String(e)}`;
      } finally {
        try {
          stopTone();
        } catch (e) {}
        btnTest.disabled = false;
      }
    });
  }
}

async function init() {
  await bindLoginGate();
  await refreshAccounts();
  initResizableSidebar();
  await ensureAuthVisibleIfNeeded();

  el('btnAdd').addEventListener('click', async () => {
    const res = await window.api.accountsAdd();
    state.accounts = res.accounts;
    renderAccounts();
  });

  el('btnSettings').addEventListener('click', openSettings);

  const btnReload = el('btnReload');
  if (btnReload) {
    btnReload.addEventListener('click', async () => {
      await window.api.reloadActive();
    });
  }

  await bindSettings();

  // Listen for hourly license refresh from main process
  if (window.api.onAuthUpdated) {
    window.api.onAuthUpdated(async () => {
      await refreshAccounts();
      await ensureAuthVisibleIfNeeded();
    });
  }
}

function initResizableSidebar() {
  const sidebar = el('sidebar');
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle';
  sidebar.appendChild(resizeHandle);

  document.documentElement.style.setProperty('--sidebar-width', `${sidebar.offsetWidth}px`);

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const newWidth = startWidth + (e.clientX - startX);
    if (newWidth >= 200 && newWidth <= 500) {
      sidebar.style.width = newWidth + 'px';
      document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      // Update WhatsApp view bounds in real-time without reload
      if (state.activeAccountId) {
        window.api.setSidebarWidth(newWidth);
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      const finalWidth = sidebar.offsetWidth;
      document.documentElement.style.setProperty('--sidebar-width', `${finalWidth}px`);
      window.api.setSidebarWidth(finalWidth);
    }
  });
}

function initRecIndicator() {
  const indicator = el('recIndicator');
  const timerEl = el('recTimer');
  const labelEl = el('recLabel');
  if (!indicator || !timerEl) return;

  let timerInterval = null;
  let recStartedAt = null;

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function startIndicator(data) {
    recStartedAt = data.startedAt || Date.now();
    if (labelEl && data.accountName) {
      labelEl.textContent = `REC · ${data.accountName}`;
    } else if (labelEl) {
      labelEl.textContent = 'REC';
    }
    timerEl.textContent = '00:00';
    indicator.classList.remove('hidden');
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timerEl.textContent = formatDuration(Date.now() - recStartedAt);
    }, 1000);
  }

  function stopIndicator() {
    indicator.classList.add('hidden');
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    recStartedAt = null;
    if (timerEl) timerEl.textContent = '00:00';
    if (labelEl) labelEl.textContent = 'REC';
  }

  if (window.api.onRecStarted) window.api.onRecStarted(startIndicator);
  if (window.api.onRecStopped) window.api.onRecStopped(stopIndicator);
}

initRecIndicator();
init();
