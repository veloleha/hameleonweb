let state = {
  accounts: [],
  activeAccountId: null,
  settingsOpen: false,
  settings: null,
  editingAccountId: null,
  currentSettingsAccount: null,
};

let testToneCtx = null;
let testToneOsc = null;
let testToneGain = null;

function el(id) {
  return document.getElementById(id);
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

  for (const a of state.accounts) {
    const row = document.createElement('div');
    row.className = `account${a.id === state.activeAccountId ? ' active' : ''}`;

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

    row.appendChild(left);
    row.appendChild(actions);

    row.onclick = async () => {
      if (state.editingAccountId) return;
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
  await refreshAccounts();
  initResizableSidebar();

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

init();
