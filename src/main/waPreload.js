const { ipcRenderer, contextBridge } = require('electron');

function getAccountId() {
  const arg = (process.argv || []).find((a) => String(a).startsWith('--waAccountId='));
  if (!arg) return null;
  return String(arg).slice('--waAccountId='.length);
}

const accountId = getAccountId();

function dbg(msg) {
  try {
    if (!accountId) return;
    ipcRenderer.send('wa:debug', { accountId, msg: String(msg || '') });
  } catch (e) {}
}

function notify(channel, payload) {
  if (!accountId) return;
  ipcRenderer.send(channel, { accountId, ...payload });
}

function onMgrMessage(ev) {
  try {
    if (!ev || ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__waMgr !== true) return;
    const t = String(d.type || '');
    if (t === 'call-started') { notify('wa:call-started', {}); }
    if (t === 'call-ended')   { notify('wa:call-ended', {}); }
    // Чанки от инжектированного MediaRecorder в основном мире
    if (t === 'rec-chunk' && d.buf) {
      try { ipcRenderer.send('wa:tab-recorder-chunk', { accountId, data: d.buf }); } catch(e) {}
    }
    if (t === 'rec-started') {
      try { ipcRenderer.send('wa:tab-recorder-started', { accountId, mimeType: d.mimeType || '' }); } catch(e) {}
    }
    if (t === 'rec-stopped') {
      try { ipcRenderer.send('wa:tab-recorder-stopped', { accountId }); } catch(e) {}
    }
    if (t === 'rec-debug') {
      try { ipcRenderer.send('wa:debug', { accountId, msg: '[injected] ' + String(d.msg || '') }); } catch(e) {}
    }
  } catch (e) {}
}

function hasCallUI() {
  const selectors = [
    '[data-icon="call-hangup"]',
    '[data-icon="call-hangup-filled"]',
    '[data-icon="decline"]',
    '[data-icon="audio-mute"]',
    '[data-icon="video-off"]',
    // English
    '[aria-label*="End call" i]',
    '[aria-label*="Hang up" i]',
    '[aria-label*="Decline" i]',
    '[aria-label*="Leave call" i]',
    // Spanish
    '[aria-label*="Terminar" i]',
    '[aria-label*="Colgar" i]',
    '[aria-label*="Finalizar" i]',
    '[aria-label*="Rechazar" i]',
    // Russian
    '[aria-label*="Завершить" i]',
    '[aria-label*="Заверш" i]',
    '[aria-label*="Полож" i]',
    '[aria-label*="Отклонить" i]',
    // Portuguese
    '[aria-label*="Encerrar" i]',
    '[aria-label*="Desligar" i]',
    // Polish
    '[aria-label*="Zakończ" i]',
    '[aria-label*="Rozłącz" i]',
    '[aria-label*="Odrzuć" i]',
    // Ukrainian
    '[aria-label*="Завершити" i]',
    '[aria-label*="Покласти" i]',
    '[aria-label*="Відхилити" i]',
    // German
    '[aria-label*="Anruf beenden" i]',
    '[aria-label*="Auflegen" i]',
    '[aria-label*="Ablehnen" i]',
    '[aria-label*="Beenden" i]',
  ];
  for (const sel of selectors) {
    try { if (document.querySelector(sel)) return true; } catch (e) {}
  }
  return false;
}

function hasAudioElementsWithTracks() {
  try {
    const els = Array.from(document.querySelectorAll('audio'));
    for (const a of els) {
      const s = a && a.srcObject;
      if (s && s.getAudioTracks && s.getAudioTracks().some((t) => t && t.readyState === 'live')) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function wrapGetUserMedia() {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  md._waMgrOriginal = original;
  md.getUserMedia = async (constraints) => {
    try {
      const audio = !!(constraints && (constraints.audio === true || (typeof constraints.audio === 'object' && constraints.audio)));
      if (audio) { dbg('getUserMedia audio=true'); notify('wa:mic-on', {}); }
    } catch (e) {}
    const stream = await original(constraints);
    try {
      const tracks = (stream && stream.getAudioTracks) ? stream.getAudioTracks() : [];
      for (const t of tracks) {
        try { t.addEventListener('ended', () => notify('wa:mic-off', {})); } catch (e) {}
      }
    } catch (e) {}
    return stream;
  };
}

function wrapRTCPeerConnection() {
  const Orig = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Orig) return;

  function WrappedRTCPeerConnection(...args) {
    const pc = new Orig(...args);
    const onState = () => {
      try {
        const s = pc.connectionState || pc.iceConnectionState;
        if (s === 'closed' || s === 'failed' || s === 'disconnected') {
          notify('wa:call-ended', { source: 'webrtc', state: s });
        }
      } catch (e) {}
    };
    try {
      pc.addEventListener('connectionstatechange', onState);
      pc.addEventListener('iceconnectionstatechange', onState);
    } catch (e) {}
    try {
      const origClose = pc.close && pc.close.bind(pc);
      if (origClose) {
        pc.close = () => {
          try { notify('wa:call-ended', { source: 'webrtc', state: 'closed' }); } catch (e) {}
          return origClose();
        };
      }
    } catch (e) {}
    return pc;
  }

  WrappedRTCPeerConnection.prototype = Orig.prototype;
  window.RTCPeerConnection = WrappedRTCPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = WrappedRTCPeerConnection;
}

function observeCallState() {
  let inCall = false;
  let endTimer = null;

  let _dumpTick = 0;
  const check = () => {
    _dumpTick++;
    if (_dumpTick % 3 === 0) {
      try {
        const btns = Array.from(document.querySelectorAll('button,div[role="button"]'))
          .map(el => (el.getAttribute('aria-label') || el.getAttribute('data-icon') || '').trim())
          .filter(Boolean).slice(0, 20);
        const audioEls = Array.from(document.querySelectorAll('audio')).map(a => {
          const tracks = a.srcObject && a.srcObject.getAudioTracks ? a.srcObject.getAudioTracks().length : 0;
          return 'audio:tracks=' + tracks;
        });
        dbg('DOM-scan btns=' + JSON.stringify(btns) + ' audio=' + JSON.stringify(audioEls));
      } catch(e) {}
    }
    const uiFound = hasCallUI();
    const audioFound = hasAudioElementsWithTracks();
    const nowInCall = uiFound || audioFound;
    if (nowInCall && !inCall) {
      inCall = true;
      if (endTimer) { clearTimeout(endTimer); endTimer = null; }
      dbg('call-started uiFound=' + uiFound + ' audioFound=' + audioFound);
      notify('wa:call-started', {});
    }
    if (!nowInCall && inCall) {
      if (endTimer) return;
      endTimer = setTimeout(() => {
        endTimer = null;
        if (!hasCallUI()) {
          inCall = false;
          notify('wa:call-ended', {});
        }
      }, 3000);
    }
  };

  const mo = new MutationObserver(() => check());
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  setInterval(check, 2000);
  check();
}

process.once('loaded', () => {
  try {
    try { contextBridge.exposeInMainWorld('__waMgrPreloadInstalled', true); } catch (e) {}
    try { dbg('waPreload loaded'); } catch (e) {}
    wrapGetUserMedia();
    wrapRTCPeerConnection();
    try { window.addEventListener('message', onMgrMessage); } catch (e) {}
    const startObserver = () => {
      try { observeCallState(); } catch (e) {}
    };
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      } else {
        startObserver();
      }
    } catch(e) {
      setTimeout(startObserver, 1000);
    }
  } catch (e) {}
});
