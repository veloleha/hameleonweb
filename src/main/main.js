const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, session } = require('electron');

const { loadAccounts, createAccount, renameAccount, deleteAccount } = require('./accounts');
const { loadSettings, saveSettings } = require('./settings');
const { loadAuthState, saveAuthState, clearAuthState } = require('./auth');
const { Recorder } = require('./recorder');
const WebSocket = require('ws');

const SIDEBAR_WIDTH = 280;
const TOPBAR_HEIGHT = 0;

try {
  const cacheDir = path.join(os.tmpdir(), 'WhatsAppManager-chromium-cache');
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment,AudioServiceAudioStreams');
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');
} catch (e) {}

let mainWindow = null;
let activeAccountId = null;
let activeView = null;
let currentSidebarWidth = SIDEBAR_WIDTH;

const viewsByAccountId = new Map();
const callMetaByAccountId = new Map();

const WA_AUDIO_EXTENSION_ID = 'pddjlpangidimliafldcpfkbkifmegbd';
const loadedExtensionsByPartition = new Set();
const DISABLE_WA_AUDIO_EXTENSION = true;

function chromeLikeUserAgent() {
  const chromeVersion = process.versions.chrome || '120.0.0.0';
  const platform = process.platform;
  if (platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  if (platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function isWhatsAppOrigin(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'web.whatsapp.com';
  } catch (e) {
    return false;
  }
}

function rendererPreloadPath() {
  return path.join(__dirname, '..', 'renderer', 'preload.js');
}

function waPreloadPath() {
  return path.join(__dirname, 'waPreload.js');
}

function tryFindInstalledExtensionPath(extensionId) {
  try {
    const override = process.env.WA_EXTENSION_PATH;
    if (override && fs.existsSync(override) && fs.existsSync(path.join(override, 'manifest.json'))) {
      try {
        console.log('[wa:ext] using WA_EXTENSION_PATH', { path: override });
      } catch (e) {}
      return override;
    }
  } catch (e) {}

  const tryRoots = [];
  try {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        tryRoots.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
        tryRoots.push(path.join(localAppData, 'Microsoft', 'Edge', 'User Data'));
      }
    }
  } catch (e) {}

  for (const root of tryRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const profiles = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => n === 'Default' || n.startsWith('Profile '));

      for (const profile of profiles) {
        const extBase = path.join(root, profile, 'Extensions', extensionId);
        if (!fs.existsSync(extBase)) continue;

        const versions = fs
          .readdirSync(extBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
          .reverse();

        for (const v of versions) {
          const candidate = path.join(extBase, v);
          const manifest = path.join(candidate, 'manifest.json');
          if (fs.existsSync(manifest)) return candidate;
        }
      }
    } catch (e) {}
  }

  return null;
}

async function ensureWhatsAppExtensionLoaded(ses, partition) {
  try {
    if (DISABLE_WA_AUDIO_EXTENSION) {
      loadedExtensionsByPartition.add(String(partition || ''));
      console.log('[wa:ext] disabled');
      return;
    }

    const key = String(partition || '');
    if (loadedExtensionsByPartition.has(key)) return;

    try {
      console.log('[wa:ext] loading...', { partition: key });
    } catch (e) {}

    const extPath = tryFindInstalledExtensionPath(WA_AUDIO_EXTENSION_ID);
    if (!extPath) {
      loadedExtensionsByPartition.add(key);
      console.log('[wa:ext] not found. Install extension in Chrome/Edge or set WA_EXTENSION_PATH to unpacked extension folder');
      return;
    }

    try {
      const ext = await ses.loadExtension(extPath, { allowFileAccess: true });
      console.log('[wa:ext] loaded', { name: ext && ext.name, version: ext && ext.version, path: extPath });
    } catch (e) {
      console.log('[wa:ext] load failed', { path: extPath, error: (e && e.message) || String(e) });
    }

    loadedExtensionsByPartition.add(key);
  } catch (e) {}
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, '..', '..', 'hameleonweb.png'),
    webPreferences: {
      preload: rendererPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('resize', async () => {
    await layoutActiveView();
  });
}

async function layoutActiveView() {
  if (!mainWindow || !activeView) return;

  const bounds = mainWindow.getContentBounds();
  const sidebarWidth = Number(currentSidebarWidth) || SIDEBAR_WIDTH;

  const x = sidebarWidth;
  const y = TOPBAR_HEIGHT;
  const width = Math.max(0, bounds.width - sidebarWidth);
  const height = Math.max(0, bounds.height - TOPBAR_HEIGHT);

  activeView.setBounds({ x, y, width, height });
  activeView.setAutoResize({ width: true, height: true });
}

async function showAccountView(userDataPath, account) {
  if (!mainWindow) return;

  activeAccountId = account.id;

  let view = viewsByAccountId.get(account.id);
  if (!view) {
    const ses = session.fromPartition(account.partition);

    try {
      ensureWhatsAppExtensionLoaded(ses, account.partition);
    } catch (e) {}

    const allowPermission = (permission, requestingUrl) => {
      if (!isWhatsAppOrigin(requestingUrl)) return false;
      return (
        permission === 'microphone' ||
        permission === 'media' ||
        permission === 'notifications' ||
        permission === 'camera'
      );
    };

    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const requestingUrl = details && (details.requestingUrl || details.requestingURL);
      callback(allowPermission(permission, requestingUrl));
    });

    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      const requestingUrl =
        (details && (details.requestingUrl || details.requestingURL)) ||
        requestingOrigin;
      return allowPermission(permission, requestingUrl);
    });

    ses.setDevicePermissionHandler((details) => {
      const requestingUrl = details && (details.origin || details.securityOrigin || details.requestingUrl);
      if (!isWhatsAppOrigin(requestingUrl)) return false;
      return Boolean(details && (details.deviceType === 'audio' || details.deviceType === 'video'));
    });

    view = new BrowserView({
      webPreferences: {
        partition: account.partition,
        preload: waPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [`--waAccountId=${account.id}`],
      },
    });

    try {
      view.webContents.setAudioMuted(false);
    } catch (e) {}
    try {
      view.webContents.setVolume(1.0);
    } catch (e) {}

    view.webContents.setUserAgent(chromeLikeUserAgent());

    view.webContents.loadURL('https://web.whatsapp.com/');

    // Инжектируем патч RTC сразу после загрузки страницы (до звонка)
    view.webContents.on('did-finish-load', () => {
      try {
        const patchPath = path.join(__dirname, 'waInjectPatch.js');
        const patchCode = require('fs').readFileSync(patchPath, 'utf8');
        view.webContents.executeJavaScript(patchCode, true).catch((e) => {
          console.log('[wa:patch-inject-error]', e && e.message);
        });
      } catch (e) {}
    });

    

    viewsByAccountId.set(account.id, view);
  }

  if (activeView && activeView !== view) {
    mainWindow.removeBrowserView(activeView);
  }

  activeView = view;
  mainWindow.addBrowserView(activeView);
  await layoutActiveView();
}

function hideAccountView() {
  if (!mainWindow || !activeView) return;
  mainWindow.removeBrowserView(activeView);
  activeView = null;
  activeAccountId = null;
}

function ensureRecordingsPath(settings, userDataPath) {
  const fallback = path.join(userDataPath, 'recordings');
  const candidate = settings.recordingsPath && typeof settings.recordingsPath === 'string' ? settings.recordingsPath : '';
  const dir = candidate || fallback;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch (e2) {}
    return fallback;
  }
}

function sanitizeName(s) {
  const base = String(s || '').trim();
  if (!base) return 'account';
  return base
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .slice(0, 60);
}

function sanitizePhoneLabel(s) {
  const base = String(s || '').trim();
  if (!base) return '';
  const digits = base.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.slice(0, 32);
}

function buildRecordingMeta(accountName, peerLabel) {
  const meta = {
    accountName: sanitizeName(accountName),
    peerLabel: sanitizeName(peerLabel),
    peerNumber: sanitizePhoneLabel(peerLabel),
  };
  if (!meta.peerNumber && !meta.peerLabel) return meta;
  return meta;
}

const PRODUCTION_API_URL = 'https://hameleonweb.xyz';

function normalizeApiBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return PRODUCTION_API_URL;
  return raw.replace(/\/+$/, '').replace(':8003', ':8000');
}

function getApiBaseUrl(_userDataPath) {
  return PRODUCTION_API_URL;
}

function detectDeviceType() {
  if (process.platform !== 'win32') return 'solo';
  try {
    const sessionName = (process.env.SESSIONNAME || '').toUpperCase();
    const clientName = (process.env.CLIENTNAME || '').toUpperCase();
    const computerName = (process.env.COMPUTERNAME || '').toUpperCase();

    // Remote Desktop / RDS session
    if (sessionName.startsWith('RDP-') || sessionName.startsWith('ICA-')) {
      return 'rds';
    }

    // Citrix or other remote client
    if (clientName && clientName !== 'CONSOLE' && clientName !== computerName) {
      return 'rds';
    }

    // Multiple active sessions on this machine = shared terminal/RDS server
    try {
      const { execSync } = require('child_process');
      const output = execSync('query session', { encoding: 'utf8', timeout: 3000 });
      const activeCount = output
        .split('\n')
        .filter((line) => /\b(Active|Conn)\b/i.test(line))
        .length;
      if (activeCount > 1) {
        return 'rds';
      }
    } catch (_) {}

    return 'solo';
  } catch (_) {
    return 'solo';
  }
}

function buildDeviceInfo(userDataPath) {
  const host = os.hostname() || 'desktop';
  const userName = process.env.USERNAME || process.env.USER || 'user';

  // Source 1: hardware fingerprint via node-machine-id
  let hwId = '';
  try {
    const { machineIdSync } = require('node-machine-id');
    hwId = machineIdSync(true);
  } catch (_) {}

  // Source 2: persistent UUID file in userData
  let fileUuid = '';
  try {
    const uuidFile = path.join(userDataPath || app.getPath('userData'), '.device-uuid');
    if (fs.existsSync(uuidFile)) {
      fileUuid = fs.readFileSync(uuidFile, 'utf8').trim();
    } else {
      fileUuid = crypto.randomUUID();
      fs.writeFileSync(uuidFile, fileUuid, { encoding: 'utf8', flag: 'wx' });
    }
  } catch (_) {}

  // Combine both: hardware wins, file is fallback
  const combined = hwId || fileUuid || host;
  const deviceId = crypto
    .createHash('sha256')
    .update(`hameleonweb:${combined}`)
    .digest('hex')
    .slice(0, 32);

  const deviceName = `${host} (${userName})`;
  const deviceType = detectDeviceType();
  return { deviceId, deviceName, deviceType };
}

function isLicenseActive(license) {
  if (!license) return false;
  const status = String(license.status || '').toLowerCase();
  if (status !== 'active' && status !== 'trial') return false;
  if (!license.expires_at) return true;
  const expiresAt = new Date(license.expires_at);
  return Number.isFinite(expiresAt.getTime()) ? expiresAt > new Date() : true;
}

function pickActiveLicense(licenses) {
  const list = Array.isArray(licenses) ? licenses : [];
  const active = list.find((license) => isLicenseActive(license));
  return active || null;
}

async function apiJson(userDataPath, apiPath, options = {}) {
  const baseUrl = getApiBaseUrl(userDataPath).replace('localhost', '127.0.0.1');
  const url = new URL(apiPath, `${baseUrl.replace(/\/$/, '')}/`);
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  console.log('[apiJson] Fetching:', url.toString());

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchErr) {
    console.error('[apiJson] Fetch error:', fetchErr.message);
    throw new Error(`Network error: ${fetchErr.message}`);
  }

  const rawText = await response.text();
  let body = null;
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch (e) {
      body = rawText;
    }
  }

  if (!response.ok) {
    const message = (body && body.detail) || (body && body.message) || response.statusText || 'Request failed';
    const err = new Error(message);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  return body;
}

async function refreshLicensesFromApi(authPath, settingsPath) {
  const spPath = settingsPath || authPath;
  const device = buildDeviceInfo(spPath);
  const auth = loadAuthState(authPath);
  if (!auth.accessToken) {
    throw new Error('Not authenticated');
  }

  let currentToken = auth.accessToken;
  const headers = {
    Authorization: `Bearer ${currentToken}`,
    'X-Device-ID': device.deviceId,
    'X-Device-Name': device.deviceName,
    'X-Device-Type': device.deviceType,
  };
  let licenses;

  try {
    // First activate-device so the server binds this device to a license slot
    try {
      await apiJson(spPath, '/api/license/activate-device', { method: 'POST', headers });
    } catch (activateErr) {
      // 403 = no free slots (handled later via empty license list)
      // 404 = device not registered yet (first auth cycle, ignore)
    }
    licenses = await apiJson(spPath, '/api/license/my', { method: 'GET', headers });
  } catch (error) {
    if (error && error.status === 401 && auth.refreshToken) {
      const refreshed = await apiJson(spPath, '/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.refreshToken}` },
      });

      const nextAuth = saveAuthState(authPath, {
        ...auth,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        tokenExpiresIn: refreshed.expires_in,
        tokenAcquiredAt: new Date().toISOString(),
      });

      currentToken = nextAuth.accessToken;
      const refreshedHeaders = {
        Authorization: `Bearer ${currentToken}`,
        'X-Device-ID': device.deviceId,
        'X-Device-Name': device.deviceName,
        'X-Device-Type': device.deviceType,
      };

      try {
        await apiJson(spPath, '/api/license/activate-device', { method: 'POST', headers: refreshedHeaders });
      } catch (_) {}

      licenses = await apiJson(spPath, '/api/license/my', {
        method: 'GET',
        headers: refreshedHeaders,
      });
    } else {
      throw error;
    }
  }

  const activeLicense = pickActiveLicense(licenses);
  const nextAuth = saveAuthState(authPath, {
    ...loadAuthState(authPath),
    licenses,
    activeLicenseKey: activeLicense ? activeLicense.license_key : '',
    lastCheckedAt: new Date().toISOString(),
    lastError: '',
  });
  return nextAuth;
}

async function startTrialFromApi(authPath, settingsPath) {
  const spPath = settingsPath || authPath;
  const auth = loadAuthState(authPath);
  if (!auth.accessToken) {
    throw new Error('Not authenticated');
  }

  const trial = await apiJson(spPath, '/api/trial/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
  });

  const nextAuth = saveAuthState(authPath, {
    ...loadAuthState(authPath),
    lastError: '',
    lastCheckedAt: new Date().toISOString(),
  });

  return {
    ...trial,
    auth: nextAuth,
  };
}

async function checkDeviceTrialStatus(authPath, settingsPath) {
  const spPath = settingsPath || authPath;
  const auth = loadAuthState(authPath);
  if (!auth.accessToken) return { trial_used: false };
  try {
    return await apiJson(spPath, '/api/device/trial-status', {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
  } catch (_) {
    return { trial_used: false };
  }
}

async function ensureActiveLicenseOrTrial(authPath, settingsPath) {
  const spPath = settingsPath || authPath;
  let auth = await refreshLicensesFromApi(authPath, spPath);
  if (pickActiveLicense(auth.licenses)) {
    return auth;
  }

  // Pre-check: if this machine already used trial, give clear error before trying
  const trialStatus = await checkDeviceTrialStatus(authPath, spPath);
  if (trialStatus && trialStatus.trial_used) {
    const nextAuth = saveAuthState(authPath, {
      ...auth,
      licenses: [],
      activeLicenseKey: '',
      lastError: 'Демо-период на этом устройстве уже был использован. Пожалуйста, приобретите подписку.',
      lastCheckedAt: new Date().toISOString(),
    });
    const err = new Error('Демо-период на этом устройстве уже был использован. Пожалуйста, приобретите подписку.');
    err.auth = nextAuth;
    err.trialUsed = true;
    throw err;
  }

  try {
    await startTrialFromApi(authPath, spPath);
  } catch (error) {
    const message = String((error && error.message) || '');
    if (!/already have an active license/i.test(message) && !/trial already used/i.test(message)) {
      const nextAuth = saveAuthState(authPath, {
        ...loadAuthState(authPath),
        lastError: message || 'Failed to start trial',
        lastCheckedAt: new Date().toISOString(),
      });
      const err = new Error(message || 'Failed to start trial');
      err.auth = nextAuth;
      throw err;
    }
  }

  auth = await refreshLicensesFromApi(authPath, spPath);
  if (!pickActiveLicense(auth.licenses)) {
    const nextAuth = saveAuthState(authPath, {
      ...auth,
      lastError: 'No active license and trial could not be activated',
      lastCheckedAt: new Date().toISOString(),
    });
    const err = new Error('No active license and trial could not be activated');
    err.auth = nextAuth;
    throw err;
  }

  return auth;
}

async function requestLoginCode(authPath, payload, settingsPath) {
  const spPath = settingsPath || authPath;
  const device = buildDeviceInfo(spPath);
  const auth = loadAuthState(authPath);
  const telegramLogin = String(payload.telegramLogin || auth.telegramLogin || '').trim();
  if (!telegramLogin) {
    throw new Error('Telegram login is required');
  }

  return apiJson(spPath, '/api/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({
      telegram_login: telegramLogin,
      device_id: device.deviceId,
      device_name: device.deviceName,
      device_type: device.deviceType,
    }),
  });
}

async function verifyLoginCode(authPath, payload, settingsPath) {
  const spPath = settingsPath || authPath;
  console.log('[verifyLoginCode] payload:', payload);
  const device = buildDeviceInfo(spPath);
  const auth = loadAuthState(authPath);
  const telegramLogin = String((payload && payload.telegramLogin) || auth.telegramLogin || '').trim();
  const code = String((payload && payload.code) || '').trim();

  console.log('[verifyLoginCode] telegramLogin:', telegramLogin, 'code:', code ? '***' : '(empty)');

  if (!telegramLogin) {
    throw new Error('Telegram login is required');
  }
  if (!code) {
    throw new Error('Code is required');
  }

  const tokens = await apiJson(spPath, '/api/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({
      telegram_login: telegramLogin,
      code,
      device_id: device.deviceId,
      device_name: device.deviceName,
      device_type: device.deviceType,
    }),
  });

  saveAuthState(authPath, {
    ...auth,
    telegramLogin,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    deviceType: device.deviceType,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresIn: tokens.expires_in,
    tokenAcquiredAt: new Date().toISOString(),
    lastError: '',
  });

  return ensureActiveLicenseOrTrial(authPath, spPath);
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function registerIpc(userDataPath, recorder, sharedDataPath) {
  // authPath: shared across all Windows users (ProgramData\HAMELEONWEB)
  // settingsPath / accountsPath: per-user (AppData\Roaming\whatsapp-manager)
  const authPath = sharedDataPath || userDataPath;

  ipcMain.handle('accounts:list', () => {
    return loadAccounts(userDataPath);
  });

  ipcMain.handle('auth:get', () => {
    const auth = loadAuthState(authPath);
    const settings = loadSettings(userDataPath);
    return {
      ...auth,
      apiBaseUrl: PRODUCTION_API_URL,
    };
  });

  ipcMain.handle('auth:setApiBaseUrl', (_e, _apiBaseUrl) => {
    return { ok: true, apiBaseUrl: PRODUCTION_API_URL };
  });

  ipcMain.handle('auth:requestCode', async (_e, payload) => {
    const auth = loadAuthState(authPath);
    const telegramLogin = String((payload && payload.telegramLogin) || auth.telegramLogin || '').trim();
    const result = await requestLoginCode(authPath, { telegramLogin }, userDataPath);
    saveAuthState(authPath, {
      ...auth,
      telegramLogin,
      lastError: '',
    });
    return result;
  });

  ipcMain.handle('auth:verifyCode', async (_e, payload) => {
    return verifyLoginCode(authPath, payload || {}, userDataPath);
  });

  ipcMain.handle('auth:refreshLicenses', async () => {
    return ensureActiveLicenseOrTrial(authPath, userDataPath);
  });

  ipcMain.handle('auth:clear', () => {
    return clearAuthState(authPath);
  });

  ipcMain.handle('accounts:add', () => {
    const a = createAccount(userDataPath);
    return { accounts: loadAccounts(userDataPath), created: a };
  });

  ipcMain.handle('accounts:rename', (_e, { id, name }) => {
    const a = renameAccount(userDataPath, id, name);
    return { accounts: loadAccounts(userDataPath), updated: a };
  });

  ipcMain.handle('accounts:update', (_e, { id, data }) => {
    const accounts = loadAccounts(userDataPath);
    const accountIndex = accounts.findIndex((a) => a.id === id);
    
    if (accountIndex === -1) {
      return { accounts: loadAccounts(userDataPath), updated: null };
    }
    
    // Update account with new data
    accounts[accountIndex] = { ...accounts[accountIndex], ...data };
    saveAccounts(userDataPath, accounts);
    
    return { accounts: loadAccounts(userDataPath), updated: accounts[accountIndex] };
  });

  ipcMain.handle('layout:getSidebarWidth', () => {
    return currentSidebarWidth;
  });

  ipcMain.handle('layout:updateViewBounds', async () => {
    if (activeView) {
      await layoutActiveView();
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('layout:setSidebarWidth', async (_e, { width }) => {
    const parsed = Number(width);
    if (Number.isFinite(parsed) && parsed >= 200 && parsed <= 500) {
      currentSidebarWidth = parsed;
      await layoutActiveView();
      return { success: true, width: currentSidebarWidth };
    }
    return { success: false, width: currentSidebarWidth };
  });

  ipcMain.handle('accounts:delete', async (_e, { id }) => {
    const accounts = loadAccounts(userDataPath);
    const account = accounts.find((a) => a.id === id);

    if (account) {
      const ses = session.fromPartition(account.partition);
      await ses.clearCache();
      await ses.clearStorageData();

      const view = viewsByAccountId.get(id);
      if (view) {
        if (activeView === view && mainWindow) {
          mainWindow.removeBrowserView(view);
          activeView = null;
          activeAccountId = null;
        }
        view.webContents.destroy();
        viewsByAccountId.delete(id);
      }

      recorder.stopIfRecording(id, { deleteIfUnconfirmed: false });
    }

    return { accounts: deleteAccount(userDataPath, id) };
  });

  ipcMain.handle('view:selectAccount', async (_e, { id }) => {
    const accounts = loadAccounts(userDataPath);
    const account = accounts.find((a) => a.id === id);
    if (!account) return { ok: false };
    await showAccountView(userDataPath, account);
    return { ok: true };
  });

  ipcMain.handle('view:openSettings', () => {
    hideAccountView();
    return { ok: true };
  });

  ipcMain.handle('view:reloadActive', () => {
    try {
      if (activeView && activeView.webContents) {
        activeView.webContents.reload();
        return { ok: true };
      }
    } catch (e) {}
    return { ok: false };
  });

  ipcMain.handle('settings:get', () => {
    const settings = loadSettings(userDataPath);
    return {
      ...settings,
      recordingsPath: ensureRecordingsPath(settings, userDataPath),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    };
  });

  ipcMain.handle('settings:set', (_e, nextPartial) => {
    const current = loadSettings(userDataPath);
    const next = { ...current, ...nextPartial };
    const saved = saveSettings(userDataPath, next);
    return {
      ...saved,
      recordingsPath: ensureRecordingsPath(saved, userDataPath),
    };
  });

  ipcMain.handle('settings:pickRecordingsPath', async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('recording:listDevices', async () => {
    return recorder.listWasapiDevices();
  });

  ipcMain.handle('recording:test', async (_e, cfg) => {
    const settings = loadSettings(userDataPath);
    const recordingsPath = ensureRecordingsPath(settings, userDataPath);

    return recorder.testRecording({
      recordingsPath,
      micDevice: (cfg && cfg.micDevice) || settings.micDevice,
      speakerDevice: (cfg && cfg.speakerDevice) || settings.speakerDevice,
      mp3Quality: Number.isFinite(cfg && cfg.mp3Quality) ? cfg.mp3Quality : settings.mp3Quality,
      durationSec: Number.isFinite(cfg && cfg.durationSec) ? cfg.durationSec : 10,
    });
  });

  ipcMain.handle('wa:isRecordingEnabled', (_e, { accountId }) => {
    void accountId;
    const settings = loadSettings(userDataPath);
    return { alwaysRecord: Boolean(settings.alwaysRecord) };
  });

  ipcMain.on('wa:debug', (_e, { accountId, msg }) => {
    try {
      console.log('[wa:debug]', { accountId, msg });
    } catch (e) {}
    _mainLog('wa:debug accountId=' + accountId + ' msg=' + msg);
  });

  ipcMain.on('wa:tab-recorder-error', (_e, { accountId, error }) => {
    try {
      console.log('[wa:tab-recorder-error]', { accountId, error });
    } catch (e) {}
  });

  ipcMain.handle('wa:getMediaSourceId', async (_e, { accountId }) => {
    try {
      const view = viewsByAccountId.get(accountId) || activeView;
      if (!view || !view.webContents) return { ok: false, error: 'view-not-found' };
      if (view.webContents.isDestroyed && view.webContents.isDestroyed()) return { ok: false, error: 'webcontents-destroyed' };
      const id = await view.webContents.getMediaSourceId(view.webContents);
      if (!id) return { ok: false, error: 'empty-id' };
      return { ok: true, id };
    } catch (e) {
      try {
        console.log('[wa:getMediaSourceId:error]', (e && e.message) || String(e));
      } catch (e2) {}
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.on('wa:unmute-view', (_e, { accountId }) => {
    try {
      const v = viewsByAccountId.get(accountId) || activeView;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.setAudioMuted(false);
        console.log('[wa:unmute-view]', { accountId });
      }
    } catch (e) {}
  });

  ipcMain.on('wa:tab-recorder-started', (_e, { accountId, mimeType }) => {
    try {
      console.log('[wa:tab-recorder-started]', { accountId, mimeType });
    } catch (e) {}
    // tab capture может заглушить вкладку — явно снимаем mute
    try {
      const v = viewsByAccountId.get(accountId) || activeView;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.setAudioMuted(false);
      }
    } catch (e) {}

    const settings = loadSettings(userDataPath);
    if (!settings.alwaysRecord) return;

    const accounts = loadAccounts(userDataPath);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    const callMeta = callMetaByAccountId.get(accountId) || {};

    recorder.startTabRecording(
      accountId,
      {
        recordingsPath: ensureRecordingsPath(settings, userDataPath),
        ...buildRecordingMeta(account.name, callMeta.peerLabel),
        mp3Quality: settings.mp3Quality,
      },
      { mimeType },
    );
  });

  ipcMain.on('wa:tab-recorder-chunk', (_e, { accountId, data }) => {
    try {
      if (data) recorder.appendTabChunk(accountId, data);
    } catch (e) {}
  });

  ipcMain.on('wa:tab-recorder-stopped', (_e, { accountId }) => {
    try {
      console.log('[wa:tab-recorder-stopped]', { accountId });
    } catch (e) {}

    try {
      recorder.stopTabRecording(accountId);
    } catch (e) {}
  });

  // WebRTC голосовой суфлёр
  const suflerRoomsByAccountId = new Map();
  const suflerWsByAccountId = new Map();
  const SUFLER_BASE_URL = 'https://hameleonweb.xyz/sufler';
  const SUFLER_WS_URL = 'wss://hameleonweb.xyz/ws/sufler';

  function generateRoomId() {
    try {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } catch (e) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  function cleanupSufler(accountId) {
    const ws = suflerWsByAccountId.get(accountId);
    if (ws) {
      try { ws.terminate(); } catch (e) {}
      suflerWsByAccountId.delete(accountId);
    }
    suflerRoomsByAccountId.delete(accountId);
  }

  function applySignalToView(accountId, msg) {
    const v = viewsByAccountId.get(accountId) || activeView;
    if (!v || !v.webContents || v.webContents.isDestroyed()) return;
    const code = `if(window.__waMgrApplySuflerSignal) window.__waMgrApplySuflerSignal(${JSON.stringify(msg)});`;
    v.webContents.executeJavaScript(code, true).catch((e) => {
      console.log('[sufler:apply-signal-error]', e && e.message);
    });
  }

  ipcMain.handle('wa:startSufler', async (_e, { accountId, sinkId }) => {
    try {
      const v = viewsByAccountId.get(accountId) || activeView;
      if (!v || !v.webContents || v.webContents.isDestroyed()) return { ok: false, error: 'view-not-found' };

      // Останавливаем предыдущий суфлёр, если есть
      cleanupSufler(accountId);

      const roomId = generateRoomId();
      suflerRoomsByAccountId.set(accountId, roomId);

      // Сначала создаём PeerConnection в вебвью, чтобы не потерять ранние signaling-сообщения
      const code = `if(window.__waMgrStartSufler) window.__waMgrStartSufler(${JSON.stringify(roomId)}, ${JSON.stringify(sinkId || null)});`;
      await v.webContents.executeJavaScript(code, true);

      // Создаём WebSocket-соединение из main process (обход CSP в вебвью)
      const ws = new WebSocket(`${SUFLER_WS_URL}/${roomId}`);
      suflerWsByAccountId.set(accountId, ws);

      ws.on('open', () => {
        try { ws.send(JSON.stringify({ type: 'join', role: 'electron' })); } catch (e) {}
        console.log('[sufler:ws-open]', { accountId, roomId });
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log('[sufler:ws-message]', { accountId, type: msg.type });
          applySignalToView(accountId, msg);
        } catch (e) {
          console.log('[sufler:ws-message-error]', e && e.message);
        }
      });

      ws.on('close', () => {
        console.log('[sufler:ws-close]', { accountId });
        cleanupSufler(accountId);
      });

      ws.on('error', (err) => {
        console.log('[sufler:ws-error]', { accountId, err: err && err.message });
      });

      return { ok: true, roomId, url: `${SUFLER_BASE_URL}/${roomId}` };
    } catch (e) {
      console.log('[wa:startSufler:error]', e && e.message);
      cleanupSufler(accountId);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('wa:stopSufler', async (_e, { accountId }) => {
    try {
      const v = viewsByAccountId.get(accountId) || activeView;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        await v.webContents.executeJavaScript('if(window.__waMgrStopSufler) window.__waMgrStopSufler();', true);
      }
      cleanupSufler(accountId);
      return { ok: true };
    } catch (e) {
      console.log('[wa:stopSufler:error]', e && e.message);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('wa:getSuflerUrl', async (_e, { accountId }) => {
    const roomId = suflerRoomsByAccountId.get(accountId);
    if (!roomId) return { ok: false, error: 'no-active-sufler' };
    return { ok: true, url: `${SUFLER_BASE_URL}/${roomId}` };
  });

  ipcMain.on('wa:sufler-debug', (_e, { accountId, msg }) => {
    try {
      console.log('[wa:sufler-debug]', { accountId, msg });
    } catch (e) {}
  });

  ipcMain.on('wa:sufler-signal', (_e, { accountId, type, payload, sampleRate, channels }) => {
    try {
      const ws = suflerWsByAccountId.get(accountId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[sufler:signal-no-ws]', { accountId, type });
        return;
      }
      const msg = { type, payload };
      if (sampleRate !== undefined) msg.sampleRate = sampleRate;
      if (channels !== undefined) msg.channels = channels;
      ws.send(JSON.stringify(msg));
      console.log('[sufler:signal-to-ws]', { accountId, type });
    } catch (e) {
      console.log('[sufler:signal-to-ws-error]', e && e.message);
    }
  });

  ipcMain.handle('wa:getAudioOutputDevices', async () => {
    try {
      return { ok: true, devices: [] };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('cache:resetAccount', async (_e, { id }) => {
    const accounts = loadAccounts(userDataPath);
    const account = accounts.find((a) => a.id === id);
    if (!account) return { ok: false };

    const ses = session.fromPartition(account.partition);
    await ses.clearCache();
    await ses.clearStorageData();

    const view = viewsByAccountId.get(id);
    if (view) {
      view.webContents.reload();
    }

    return { ok: true };
  });

  ipcMain.handle('recordings:openFolder', async () => {
    const settings = loadSettings(userDataPath);
    const dir = ensureRecordingsPath(settings, userDataPath);
    await shell.openPath(dir);
    return { ok: true };
  });

  const UPDATE_BASE_URL = 'https://hameleonweb.xyz/download';
  let _pendingInstallerPath = null;

  ipcMain.handle('app:checkUpdate', async () => {
    try {
      const currentVersion = app.getVersion();
      const res = await fetch(`${UPDATE_BASE_URL}/latest.json?t=${Date.now()}`);
      if (!res.ok) return { error: `Server returned ${res.status}` };
      const info = await res.json();
      const latestVersion = info.version;
      if (!latestVersion) return { error: 'No version in latest.json' };

      const newer = compareVersions(latestVersion, currentVersion) > 0;
      return {
        currentVersion,
        latestVersion,
        newer,
        url: info.url || `${UPDATE_BASE_URL}/${info.file || `HAMELEONWEB-Setup-${latestVersion}.exe`}`,
        notes: info.notes || '',
      };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  ipcMain.handle('app:installUpdate', async (_e, { url }) => {
    try {
      const downloadsDir = app.getPath('downloads');
      const fileName = url.split('/').pop() || 'HAMELEONWEB-Update.exe';
      const destPath = path.join(downloadsDir, fileName);

      await new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        const proto = url.startsWith('https') ? https : http;

        const doRequest = (requestUrl) => {
          proto.get(requestUrl, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
              doRequest(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Download failed: HTTP ${res.statusCode}`));
              return;
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let received = 0;
            const fileStream = fs.createWriteStream(destPath);

            res.on('data', (chunk) => {
              received += chunk.length;
              if (total > 0 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update:download-progress', {
                  percent: Math.round((received / total) * 100),
                  received,
                  total,
                });
              }
            });

            res.pipe(fileStream);
            fileStream.on('finish', () => { fileStream.close(); resolve(); });
            fileStream.on('error', reject);
            res.on('error', reject);
          }).on('error', reject);
        };

        doRequest(url);
      });

      _pendingInstallerPath = destPath;

      await shell.openPath(destPath);

      setTimeout(() => app.quit(), 2000);
      return { ok: true };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  const _mainLog = (msg) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'hameleonweb-main.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch(e){} };
  _mainLog('IPC handlers registered');

  const sendRecEvent = (event, data) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(event, data);
      }
    } catch (e) {}
  };

  ipcMain.on('wa:mic-on', (_e, { accountId }) => {
    try {
      console.log('[wa:mic-on]', { accountId });
    } catch (e) {}
    _mainLog('wa:mic-on accountId=' + accountId);
    const settings = loadSettings(userDataPath);
    _mainLog('alwaysRecord=' + settings.alwaysRecord);
    if (!settings.alwaysRecord) return;

    const accounts = loadAccounts(userDataPath);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    const callMeta = callMetaByAccountId.get(accountId) || {};
    sendRecEvent('rec:started', { accountId, accountName: account.name, startedAt: Date.now() });

    recorder.startCandidateRecording(accountId, {
      recordingsPath: ensureRecordingsPath(settings, userDataPath),
      ...buildRecordingMeta(account.name, callMeta.peerLabel),
      micDevice: settings.micDevice,
      speakerDevice: settings.speakerDevice,
      mp3Quality: settings.mp3Quality,
      graceMs: settings.graceMs,
      minDurationSec: settings.minDurationSec,
    });
  });

  ipcMain.on('wa:mic-off', (_e, { accountId }) => {
    try {
      console.log('[wa:mic-off]', { accountId });
    } catch (e) {}
    recorder.stopIfRecording(accountId, { deleteIfUnconfirmed: true });
    callMetaByAccountId.delete(accountId);
    sendRecEvent('rec:stopped', { accountId });
  });

  ipcMain.on('wa:call-started', (_e, { accountId, peerLabel }) => {
    try {
      console.log('[wa:call-started]', { accountId, peerLabel });
    } catch (e) {}
    _mainLog('wa:call-started accountId=' + accountId + ' peerLabel=' + String(peerLabel || ''));
    const settings = loadSettings(userDataPath);

    if (peerLabel) {
      callMetaByAccountId.set(accountId, { peerLabel: String(peerLabel) });
    }

    if (settings.alwaysRecord) {
      const accounts = loadAccounts(userDataPath);
      const account = accounts.find((a) => a.id === accountId);
      if (account) {
        const callMeta = callMetaByAccountId.get(accountId) || {};
        const v = viewsByAccountId.get(accountId) || activeView;
        if (v && v.webContents && !v.webContents.isDestroyed()) {
          const injectPath = path.join(__dirname, 'waInject.js');
          let injectCode;
          try { injectCode = require('fs').readFileSync(injectPath, 'utf8'); } catch (e) { injectCode = ''; }
          if (injectCode) {
            v.webContents.executeJavaScript(injectCode, true).catch((e) => {
              console.log('[wa:inject-error]', e && e.message);
            });
          }
          sendRecEvent('rec:started', { accountId, accountName: account.name, startedAt: Date.now() });
          recorder.startTabRecording(accountId, {
            recordingsPath: ensureRecordingsPath(settings, userDataPath),
            ...buildRecordingMeta(account.name, callMeta.peerLabel),
            mp3Quality: settings.mp3Quality,
          });
        } else {
          recorder.startCandidateRecording(accountId, {
            recordingsPath: ensureRecordingsPath(settings, userDataPath),
            ...buildRecordingMeta(account.name, callMeta.peerLabel),
            micDevice: settings.micDevice,
            speakerDevice: settings.speakerDevice,
            mp3Quality: settings.mp3Quality,
            graceMs: settings.graceMs,
            minDurationSec: settings.minDurationSec,
          });
        }
      }
    }

    recorder.confirmCall(accountId);
  });

  ipcMain.on('wa:call-ended', (_e, { accountId }) => {
    try {
      console.log('[wa:call-ended]', { accountId });
    } catch (e) {}
    try {
      const v = viewsByAccountId.get(accountId) || activeView;
      if (v && v.webContents && !v.webContents.isDestroyed()) {
        v.webContents.executeJavaScript('if(window.__waMgrStopRec) window.__waMgrStopRec();', true).catch(() => {});
      }
    } catch (e) {}
    recorder.stopIfRecording(accountId, { deleteIfUnconfirmed: true });
    callMetaByAccountId.delete(accountId);
    sendRecEvent('rec:stopped', { accountId });
  });
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');

  // Shared auth path — ProgramData\HAMELEONWEB (created by installer with full access for all users)
  // Admin logs in once, all users share the same license/token
  const _sharedBase = process.platform === 'win32'
    ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'HAMELEONWEB')
    : path.join('/var/lib', 'hameleonweb');
  let sharedDataPath = userDataPath; // fallback: per-user if shared not accessible
  try {
    fs.mkdirSync(_sharedBase, { recursive: true });
    // Test write access
    const _testFile = path.join(_sharedBase, '.write-test');
    fs.writeFileSync(_testFile, '1');
    fs.unlinkSync(_testFile);
    sharedDataPath = _sharedBase;
  } catch (e) {
    console.log('[auth] ProgramData not writable, using per-user path:', e.message);
  }

  const recorder = new Recorder({ userDataPath });

  createMainWindow();
  registerIpc(userDataPath, recorder, sharedDataPath);

  if (loadAccounts(userDataPath).length === 0) {
    createAccount(userDataPath);
  }

  // Hourly license refresh — picks up paid license if user was on trial
  const LICENSE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    const auth = loadAuthState(sharedDataPath);
    if (!auth.accessToken) return;
    try {
      const nextAuth = await refreshLicensesFromApi(sharedDataPath, userDataPath);
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('auth:updated', nextAuth);
    } catch (_) {}
  }, LICENSE_CHECK_INTERVAL);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
