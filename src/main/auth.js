const path = require('path');
const { readJson, writeJsonAtomic } = require('./storage');

const DEFAULT_AUTH_STATE = {
  telegramLogin: '',
  telegramId: null,
  deviceId: '',
  deviceName: '',
  accessToken: '',
  refreshToken: '',
  tokenExpiresIn: 0,
  tokenAcquiredAt: null,
  licenses: [],
  activeLicenseKey: '',
  lastCheckedAt: null,
  lastError: '',
};

function authFilePath(userDataPath) {
  return path.join(userDataPath, 'auth.json');
}

function loadAuthState(userDataPath) {
  const filePath = authFilePath(userDataPath);
  const state = readJson(filePath, DEFAULT_AUTH_STATE);
  return { ...DEFAULT_AUTH_STATE, ...state };
}

function saveAuthState(userDataPath, nextState) {
  const filePath = authFilePath(userDataPath);
  const merged = { ...DEFAULT_AUTH_STATE, ...nextState };
  writeJsonAtomic(filePath, merged);
  return merged;
}

function clearAuthState(userDataPath) {
  return saveAuthState(userDataPath, DEFAULT_AUTH_STATE);
}

module.exports = {
  DEFAULT_AUTH_STATE,
  loadAuthState,
  saveAuthState,
  clearAuthState,
};
