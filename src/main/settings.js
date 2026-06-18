const path = require('path');
const { readJson, writeJsonAtomic } = require('./storage');

const DEFAULT_SETTINGS = {
  alwaysRecord: false,
  recordingsPath: '',
  micDevice: 'default',
  speakerDevice: 'default',
  mp3Quality: 4,
  graceMs: 8000,
  minDurationSec: 10,
  apiBaseUrl: 'https://hameleonweb.xyz',
};

function settingsFilePath(userDataPath) {
  return path.join(userDataPath, 'settings.json');
}

function loadSettings(userDataPath) {
  const filePath = settingsFilePath(userDataPath);
  const s = readJson(filePath, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...s };
}

function saveSettings(userDataPath, nextSettings) {
  const filePath = settingsFilePath(userDataPath);
  writeJsonAtomic(filePath, nextSettings);
  return nextSettings;
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
};
