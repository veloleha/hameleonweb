const crypto = require('crypto');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./storage');

function accountsFilePath(userDataPath) {
  return path.join(userDataPath, 'accounts.json');
}

function loadAccounts(userDataPath) {
  const filePath = accountsFilePath(userDataPath);
  return readJson(filePath, []);
}

function saveAccounts(userDataPath, accounts) {
  const filePath = accountsFilePath(userDataPath);
  writeJsonAtomic(filePath, accounts);
}

function newAccountId() {
  return `acc-${crypto.randomBytes(4).toString('hex')}`;
}

function createAccount(userDataPath) {
  const accounts = loadAccounts(userDataPath);
  const id = newAccountId();
  const account = {
    id,
    name: id,
    partition: `persist:wa-${id}`,
  };
  accounts.push(account);
  saveAccounts(userDataPath, accounts);
  return account;
}

function renameAccount(userDataPath, id, name) {
  const accounts = loadAccounts(userDataPath);
  const next = accounts.map((a) => (a.id === id ? { ...a, name } : a));
  saveAccounts(userDataPath, next);
  return next.find((a) => a.id === id) || null;
}

function deleteAccount(userDataPath, id) {
  const accounts = loadAccounts(userDataPath);
  const next = accounts.filter((a) => a.id !== id);
  saveAccounts(userDataPath, next);
  return next;
}

module.exports = {
  loadAccounts,
  createAccount,
  renameAccount,
  deleteAccount,
};
