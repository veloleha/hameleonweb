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

function normalizeLabel(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isGenericLabel(s) {
  const text = normalizeLabel(s).toLowerCase();
  if (!text) return true;
  return text.includes('whatsapp') ||
    text === 'call' || text === 'voice call' || text === 'video call' ||
    text.includes('click here for contact info') ||
    text.includes('last seen') || text.includes('typing') ||
    text.includes('online') || text.includes('recording') ||
    text.includes('записывает') || text.includes('печатает') || text.includes('в сети');
}

function extractPhoneLikeLabel(s) {
  const text = normalizeLabel(s);
  if (!text) return '';

  const match = text.match(/(?:\+?\d[\d\s().-]{5,}\d)/g);
  if (!match || !match.length) return '';

  match.sort((a, b) => b.replace(/[^\d]/g, '').length - a.replace(/[^\d]/g, '').length);
  const digits = normalizeLabel(match[0]).replace(/[^\d+]/g, '');
  // Reject if fewer than 7 digits (timestamps like 18:00 → "1800" = 4 digits)
  if (digits.replace(/\D/g, '').length < 7) return '';
  return digits;
}

function extractPeerFromUrl() {
  try {
    const url = new URL(window.location.href);
    const params = ['phone', 'number', 'jid', 'contact', 'to'];

    for (const key of params) {
      const value = url.searchParams.get(key);
      const phone = extractPhoneLikeLabel(value);
      if (phone) return phone;
    }

    const raw = `${url.href} ${url.pathname} ${url.search}`;
    const phone = extractPhoneLikeLabel(raw);
    if (phone) return phone;
  } catch (e) {}

  return '';
}

function extractCallPeerLabel() {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const text = normalizeLabel(value);
    if (!text || isGenericLabel(text)) return;
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      candidates.push(text);
      seen.add(key);
    }
  };

  // 1. URL hash: WhatsApp Web puts chat jid in location.hash like #/chat/+79991234567@...
  try {
    const hash = decodeURIComponent(window.location.hash || '');
    const jidMatch = hash.match(/([+\d]{7,})/);
    if (jidMatch) {
      const phone = jidMatch[1].replace(/[^\d+]/g, '');
      if (phone.length >= 7) {
        dbg('peer from URL hash: ' + phone);
        return phone;
      }
    }
  } catch (e) {}

  // 2. URL search params
  const fromUrl = extractPeerFromUrl();
  if (fromUrl) { dbg('peer from URL params: ' + fromUrl); return fromUrl; }

  // 3. Open chat header — the most reliable source: #main header span[title]
  const headerSelectors = [
    '#main header span[title]',
    '#main header [dir="auto"]',
    '#main header [data-testid="conversation-info-header-chat-title"]',
    'header span[title]',
    'header [dir="auto"]',
    '[data-testid="conversation-info-header-chat-title"]',
    '[data-testid="conversation-info-header"]',
  ];

  for (const sel of headerSelectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        push(node.getAttribute && node.getAttribute('title'));
        push(node.textContent);
      }
    } catch (e) {}
  }

  // 4. document.title (usually "Contact name - WhatsApp")
  try {
    const title = normalizeLabel(document.title).replace(/[-–—|]\s*whatsapp.*/i, '').trim();
    push(title);
  } catch (e) {}

  // 5. Wider DOM scan as last resort
  const fallbackSelectors = [
    '[role="dialog"] span[title]',
    '[role="dialog"] [dir="auto"]',
    '[role="banner"] span[title]',
    '[role="banner"] [dir="auto"]',
    '[title]',
    '[dir="auto"]',
  ];

  for (const sel of fallbackSelectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        push(node.getAttribute && node.getAttribute('title'));
        push(node.textContent);
      }
    } catch (e) {}
  }

  dbg('extractCallPeerLabel candidates: ' + JSON.stringify(candidates.slice(0, 5)));

  // Prefer numeric phone
  for (const text of candidates) {
    const phone = extractPhoneLikeLabel(text);
    if (phone) return phone;
  }

  return candidates.find((text) => !isGenericLabel(text)) || '';
}

// Phone/name posted by waInjectPatch.js (main world)
let _storePhone = '';
let _storeName = '';
let _currentChatTitle = '';

function onMgrMessage(ev) {
  try {
    if (!ev || ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__waMgr !== true) return;
    const t = String(d.type || '');
    if (t === 'call-started') { notify('wa:call-started', {}); }
    if (t === 'call-ended')   { notify('wa:call-ended', {}); }
    // Phone number from WhatsApp Store (main world)
    if (t === 'peer-phone') {
      const phone = String(d.phone || '').trim();
      const chatTitle = String(d.chatTitle || '').trim();
      if (chatTitle && _currentChatTitle && chatTitle !== _currentChatTitle) {
        dbg('Ignoring stale peer phone for chat=' + chatTitle + ' current=' + _currentChatTitle);
        return;
      }
      if (phone && phone !== _storePhone) {
        _storePhone = phone;
        dbg('Store phone updated: ' + phone);
      }
    }
    // Contact name from main world header (fallback when no phone)
    if (t === 'peer-name') {
      const name = String(d.name || '').trim();
      const chatTitle = String(d.chatTitle || '').trim();
      const activeTitle = chatTitle || name;
      if (activeTitle && activeTitle !== _currentChatTitle) {
        _currentChatTitle = activeTitle;
        _storePhone = '';
        _storeName = '';
        dbg('Active chat changed: ' + activeTitle + ' (cleared stale phone)');
      }
      if (name && !isGenericLabel(name)) {
        _storeName = name;
        dbg('Store name updated: ' + name);
      }
    }
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
    if (t === 'sufler-debug') {
      try { ipcRenderer.send('wa:sufler-debug', { accountId, msg: String(d.msg || '') }); } catch(e) {}
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


function scanDomForPhone() {
  // Only match strings that look like phone numbers (digits, +, spaces, parens, dashes)
  // Must start/end with a digit and have at least 7 digits total
  const phoneRe = /^[\s()*+]?[\d][\d\s().*+-]{5,}[\d]$/;
  const hasEnoughDigits = (s) => (s.match(/\d/g) || []).length >= 7;

  const tryText = (s) => {
    const t = normalizeLabel(s);
    // Must be short (phone number only, not a sentence) and look like a number
    if (!t || t.length < 7 || t.length > 30) return '';
    if (!phoneRe.test(t)) return '';
    if (!hasEnoughDigits(t)) return '';
    return t.replace(/[^\d+]/g, '');
  };

  // Contact info panel selectors where WhatsApp shows the actual phone number
  const selectors = [
    '[data-testid="contact-info-subtitle"]',
    '[data-testid*="phone-number"]',
    '[data-testid*="contact-info"] span[dir="ltr"]',
    'aside [dir="ltr"]',
    'aside span',
    // WhatsApp desktop puts phone in a copyable span inside the info panel
    '#contact-info span[dir="ltr"]',
    '#contact-info span',
    '[aria-label*="phone" i] span',
    '[aria-label*="Phone" i] span',
  ];

  for (const sel of selectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const phone = tryText(node.textContent);
        if (phone) return phone;
      }
    } catch (e) {}
  }

  return '';
}

function readCurrentChatHeader() {
  // 1. Chat header title attribute (contact name as fallback)
  const isStatusNoise = (s) => /last seen|typing|online|recording|записывает|печатает|в сети/i.test(s);
  const headerSelectors = [
    '#main header span[title]',
    'header span[title]',
    '[data-testid="conversation-info-header-chat-title"]',
  ];
  for (const sel of headerSelectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        const t = normalizeLabel(node.getAttribute('title'));
        if (t && !isGenericLabel(t) && !isStatusNoise(t) && t.length <= 60) { dbg('peer from header: ' + t); return t; }
      }
    } catch (e) {}
  }

  // 2. document.title minus "WhatsApp" suffix
  try {
    const title = normalizeLabel(document.title).replace(/[-–—|]\s*whatsapp.*/i, '').trim();
    if (title && !isGenericLabel(title) && !isStatusNoise(title) && title.length <= 60) { dbg('peer from title: ' + title); return title; }
  } catch (e) {}

  // 3. Name sent from main world (most reliable fallback)
  if (_storeName) { dbg('peer from storeName: ' + _storeName); return _storeName; }

  return '';
}

function observeCallState() {
  let inCall = false;
  let endTimer = null;
  let lastKnownPeer = '';

  let _dumpTick = 0;
  const check = () => {
    _dumpTick++;

    // Always track current chat header peer
    try {
      const peer = readCurrentChatHeader();
      if (peer) lastKnownPeer = peer;
    } catch (e) {}

    if (_dumpTick % 3 === 0) {
      try {
        const btns = Array.from(document.querySelectorAll('button,div[role="button"]'))
          .map(el => (el.getAttribute('aria-label') || el.getAttribute('data-icon') || '').trim())
          .filter(Boolean).slice(0, 20);
        const audioEls = Array.from(document.querySelectorAll('audio')).map(a => {
          const tracks = a.srcObject && a.srcObject.getAudioTracks ? a.srcObject.getAudioTracks().length : 0;
          return 'audio:tracks=' + tracks;
        });
        dbg('DOM-scan btns=' + JSON.stringify(btns) + ' audio=' + JSON.stringify(audioEls) + ' peer=' + lastKnownPeer);
      } catch(e) {}
    }
    const uiFound = hasCallUI();
    const audioFound = hasAudioElementsWithTracks();
    const nowInCall = uiFound || audioFound;
    if (nowInCall && !inCall) {
      inCall = true;
      if (endTimer) { clearTimeout(endTimer); endTimer = null; }
      // Prefer cached header peer over DOM scan (overlay may hide the header)
      const peerLabel = _storePhone || lastKnownPeer || extractCallPeerLabel();
      dbg('call-started uiFound=' + uiFound + ' audioFound=' + audioFound + ' peerLabel=' + peerLabel);
      notify('wa:call-started', { peerLabel });
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
