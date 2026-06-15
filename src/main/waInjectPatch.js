// Патч — инжектируется сразу при загрузке страницы (до звонка).
(function() {
  if (window.__waMgrRtcPatched) return;
  window.__waMgrRtcPatched = true;

  window.__waMgrRtcStreams = [];

  function dbg(msg) { window.postMessage({__waMgr:true, type:'rec-debug', msg: msg}, '*'); }

  function addStream(stream, label) {
    if (!stream || !stream.getAudioTracks) return;
    // Не дублируем один и тот же объект
    for (var i = 0; i < window.__waMgrRtcStreams.length; i++) {
      if (window.__waMgrRtcStreams[i] === stream) return;
    }
    window.__waMgrRtcStreams.push(stream);
    dbg('captured: ' + label + ' tracks=' + (stream.getAudioTracks ? stream.getAudioTracks().length : '?'));
  }

  var OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!OrigRTC) { dbg('no RTC'); return; }

  // Патчим КОНСТРУКТОР — создаём обёртку каждого PC
  function PatchedRTC(cfg, constraints) {
    var pc = new OrigRTC(cfg, constraints);

    // ontrack через defineProperty на экземпляре
    var _ontrack = null;
    Object.defineProperty(pc, 'ontrack', {
      get: function() { return _ontrack; },
      set: function(fn) {
        _ontrack = fn;
        dbg('ontrack setter called');
      },
      configurable: true
    });

    // onaddstream (старый API)
    var _onaddstream = null;
    Object.defineProperty(pc, 'onaddstream', {
      get: function() { return _onaddstream; },
      set: function(fn) {
        _onaddstream = fn;
        dbg('onaddstream setter called');
      },
      configurable: true
    });

    // Перехватываем addEventListener на экземпляре
    var origAEL = pc.addEventListener.bind(pc);
    pc.addEventListener = function(type, fn, opts) {
      dbg('addEventListener: ' + type);
      if (type === 'track') {
        return origAEL(type, function(ev) {
          dbg('track event fired');
          if (ev && ev.streams) { ev.streams.forEach(function(s) { addStream(s, 'track-streams'); }); }
          if (ev && ev.track && ev.track.kind === 'audio') {
            try { addStream(new MediaStream([ev.track]), 'track-single'); } catch(e) {}
          }
          if (fn) fn.apply(this, arguments);
        }, opts);
      }
      if (type === 'addstream') {
        return origAEL(type, function(ev) {
          dbg('addstream event fired');
          if (ev && ev.stream) addStream(ev.stream, 'addstream');
          if (fn) fn.apply(this, arguments);
        }, opts);
      }
      return origAEL(type, fn, opts);
    };

    // dispatchEvent — ловим track и addstream события
    var origDE = pc.dispatchEvent.bind(pc);
    pc.dispatchEvent = function(ev) {
      if (ev && ev.type === 'track') {
        dbg('dispatchEvent track');
        if (ev.streams) { ev.streams.forEach(function(s) { addStream(s, 'dispatch-track'); }); }
        if (ev.track && ev.track.kind === 'audio') {
          try { addStream(new MediaStream([ev.track]), 'dispatch-single'); } catch(e) {}
        }
      }
      if (ev && ev.type === 'addstream' && ev.stream) {
        dbg('dispatchEvent addstream');
        addStream(ev.stream, 'dispatch-addstream');
      }
      return origDE(ev);
    };

    return pc;
  }

  // Копируем прототип и статические методы
  PatchedRTC.prototype = OrigRTC.prototype;
  Object.keys(OrigRTC).forEach(function(k) { try { PatchedRTC[k] = OrigRTC[k]; } catch(e) {} });

  window.RTCPeerConnection = PatchedRTC;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedRTC;

  dbg('rtc-patch installed (constructor wrap)');

  // --- Auto-extract phone by briefly opening Contact info panel ---
  var _extracting = false;
  var _lastExtracted = '';

  function resetAutoExtractState(reason) {
    _extracting = false;
    if (_pendingExtractTimer) {
      clearTimeout(_pendingExtractTimer);
      _pendingExtractTimer = null;
    }
    _pendingExtractTitle = '';
    _lastExtracted = '';
    if (reason) dbg('reset auto-extract state: ' + reason);
  }

  function phoneRe() { return /\+?\d[\d\s().+-]{5,}\d/; }
  function digitsOnly(s) { return String(s).replace(/[^\d+]/g, ''); }

  function isVisibleElement(el) {
    try {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      return !!(rect && rect.width > 0 && rect.height > 0 && el.offsetParent !== null);
    } catch (e) {
      return false;
    }
  }

  function describeElement(el) {
    try {
      if (!el) return 'null';
      var tag = String(el.tagName || '').toLowerCase();
      var title = String(el.getAttribute && el.getAttribute('title') || '').trim();
      var aria = String(el.getAttribute && el.getAttribute('aria-label') || '').trim();
      var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      return tag + (title ? ' title=' + title : '') + (aria ? ' aria=' + aria : '') + (txt ? ' text=' + txt.slice(0, 40) : '');
    } catch (e) {
      return 'unknown';
    }
  }

  function dispatchSyntheticClick(el) {
    if (!el) return false;
    try { el.focus && el.focus(); } catch (e) {}
    try { el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}

    var opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
    };

    try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousemove', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    try { el.click && el.click(); } catch (e) {}
    return true;
  }

  function extractPhoneFromPanel(root) {
    var scope = root || document;
    var selectors = [
      'a[href^="tel:"]',
      '[data-testid="contact-info-subtitle"]',
      '[data-testid*="phone"]',
      '[aria-label]',
      '[title]',
      'span',
      'div',
    ];

    var seen = new Set();

    function pushCandidate(value) {
      var t = String(value || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 120) return '';
      var m = t.match(phoneRe());
      if (!m) return '';
      var d = digitsOnly(m[0]);
      if (d.replace(/\D/g, '').length >= 7) return d;
      return '';
    }

    for (var si = 0; si < selectors.length; si++) {
      try {
        var nodes = scope.querySelectorAll(selectors[si]);
        for (var ni = 0; ni < nodes.length; ni++) {
          var node = nodes[ni];
          if (seen.has(node)) continue;
          seen.add(node);
          var candidate = pushCandidate(node.getAttribute && node.getAttribute('href')) ||
            pushCandidate(node.getAttribute && node.getAttribute('title')) ||
            pushCandidate(node.getAttribute && node.getAttribute('aria-label')) ||
            pushCandidate(node.textContent);
          if (candidate) return candidate;
        }
      } catch (e) {}
    }

    try {
      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
      var textNode;
      while ((textNode = walker.nextNode())) {
        var candidate = pushCandidate(textNode.nodeValue);
        if (candidate) return candidate;
      }
    } catch (e) {}

    return '';
  }

  function collectContactInfoOpeners(header) {
    var out = [];
    var seen = new Set();

    function addCandidate(el, score) {
      if (!el || seen.has(el) || !isVisibleElement(el)) return;
      seen.add(el);
      out.push({ el: el, score: score || 0 });
    }

    function scoreElement(el) {
      if (!el) return 0;
      var title = String(el.getAttribute && el.getAttribute('title') || '').trim();
      var aria = String(el.getAttribute && el.getAttribute('aria-label') || '').trim();
      var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      var blob = (title + ' ' + aria + ' ' + txt).toLowerCase();
      var score = 0;
      // Primary: explicit contact info indicators
      if (/contact info|click here for contact info/.test(blob)) score += 100;
      // Secondary: contact-related keywords
      if (/contact|profile|details|info/.test(blob)) score += 20;
      // Hard reject non-contact items — we only want the explicit contact-info trigger.
      if (/send feedback|help centre|help center|feedback|status|communities|calls|chats|new chat|search|menu|attach|emoji|sticker|voice|video call/.test(blob)) return 0;
      if (/button|role="button"/.test(String(el.outerHTML || '').toLowerCase())) score += 5;
      if (/^.{1,40}$/.test(txt)) score += 2;
      return score;
    }

    var selectors = [
      '[title*="contact info" i]',
      '[aria-label*="contact info" i]',
      '[data-testid*="contact-info" i]',
      '[data-testid="conversation-info-header-chat-title"]',
      'header [role="button"]',
      'header button',
    ];

    for (var si = 0; si < selectors.length; si++) {
      try {
        var nodes = header.querySelectorAll(selectors[si]);
        for (var ni = 0; ni < nodes.length; ni++) {
          var node = nodes[ni];
          var clickable = node.closest && node.closest('button,[role="button"],a') || node;
          var score = scoreElement(clickable);
          if (score > 0) addCandidate(clickable, score);
        }
      } catch (e) {}
    }

    // Fallback: look for any clickable in header that has contact-related text
    try {
      var allClickables = header.querySelectorAll('button, [role="button"], a');
      for (var ci = 0; ci < allClickables.length; ci++) {
        var el = allClickables[ci];
        var txt = String(el.textContent || '').toLowerCase();
        var aria = String(el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
        if (/contact|info|details|profile/.test(txt + ' ' + aria)) {
          addCandidate(el, 10);
        }
      }
    } catch (e) {}

    out.sort(function(a, b) { return b.score - a.score; });
    return out.map(function(item) { return item.el; });
  }

  function closePanelIfOpen() {
    var closeSelectors = [
      'aside button[aria-label*="Close" i]',
      'aside button[aria-label*="Back" i]',
      'aside button[aria-label*="Закр" i]',
      'aside button[aria-label*="Назад" i]',
      'aside [data-icon="x"]',
      'aside [data-icon="back"]',
      'aside header button',
      'header button[aria-label*="Back" i]',
      'header button[aria-label*="Close" i]',
    ];
    for (var i = 0; i < closeSelectors.length; i++) {
      try {
        var btn = document.querySelector(closeSelectors[i]);
        if (btn) {
          dispatchSyntheticClick(btn);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  function getConversationHeader() {
    try {
      var headers = document.querySelectorAll('#main header');
      var minLeft = Math.max(160, Math.floor(window.innerWidth * 0.15));
      var best = null;
      for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        if (!isVisibleElement(header)) continue;
        var rect = header.getBoundingClientRect();
        if (!rect || rect.width < 200 || rect.height < 24) continue;
        // The left sidebar header sits at the far left; the conversation header lives on the right pane.
        if (rect.left < minLeft) continue;
        if (!best || rect.left < best.rect.left) {
          best = { el: header, rect: rect };
        }
      }
      return best ? best.el : null;
    } catch (e) {
      return null;
    }
  }

  function isConversationOpen() {
    try {
      var header = getConversationHeader();
      if (!header) return false;

      var composer = document.querySelector([
        '#main footer [contenteditable="true"]',
        '#main footer [data-testid="compose-input-area"]',
        '#main footer [aria-label*="Type a message" i]',
        '#main footer [aria-label*="Message" i]',
        '#main [data-testid="conversation-compose-box-input"]',
      ].join(','));
      if (!composer || !isVisibleElement(composer)) return false;

      var messages = document.querySelector('#main [data-testid="conversation-panel-messages"]');
      if (!messages || !isVisibleElement(messages)) return false;

      return true;
    } catch (e) {
      return false;
    }
  }

  function openContactInfoAndRead(onDone) {
    if (_extracting) return;

    if (!isConversationOpen()) {
      dbg('skip auto-open: conversation is not open');
      return;
    }

    var header = getConversationHeader();
    if (!header) return;

    var openers = collectContactInfoOpeners(header);
    if (!openers.length) {
      dbg('no contact-info opener found in header');
      return;
    }

    _extracting = true;
    var opener = openers[0];

    function finish(phone) {
      _extracting = false;
      if (phone) onDone(phone);
    }

    try {
      dbg('click contact opener: ' + describeElement(opener));
      dispatchSyntheticClick(opener);

      var waited = 0;
      var poll = setInterval(function() {
        waited += 80;
        var aside = document.querySelector('aside');
        var phone = extractPhoneFromPanel(aside);

        if (phone) {
          clearInterval(poll);
          dbg('contact phone extracted: ' + phone);
          setTimeout(function() {
            finish(phone);
          }, 80);
          return;
        }

        if (aside && waited === 80) {
          try {
            dbg('aside-text: ' + String((aside.textContent || '')).replace(/\s+/g, ' ').slice(0, 300));
          } catch (e) {}
        }

        if (waited >= 1400) {
          clearInterval(poll);
          dbg('contact info panel did not produce a phone');
          finish('');
        }
      }, 80);
    } catch (e) {
      dbg('openContactInfoAndRead error: ' + e);
      _extracting = false;
    }
  }

  // Watch for active chat change by tracking header title
  var _lastHeaderTitle = '';
  var _pendingExtractTimer = null;
  var _pendingExtractTitle = '';

  var NOISE = /last seen|typing|online|recording|click here|записывает|печатает|в сети|whatsapp/i;

  function getCurrentHeaderTitle() {
    try {
      var header = getConversationHeader();
      if (!header) return '';
      // Walk all text-bearing nodes
      var all = header.querySelectorAll('span, div');
      var best = '';
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        // Skip elements that have children with text (avoid parent containers)
        var directText = '';
        el.childNodes.forEach(function(n) {
          if (n.nodeType === 3) directText += n.nodeValue;
        });
        var t = directText.trim();
        if (!t && el.children.length === 0) t = (el.textContent || '').trim();
        if (!t || t.length > 80 || NOISE.test(t)) continue;
        // Prefer the title attribute
        var titleAttr = (el.getAttribute('title') || '').trim();
        if (titleAttr && !NOISE.test(titleAttr)) { best = titleAttr; break; }
        if (!best) best = t;
      }
      return best;
    } catch(e) { return ''; }
  }

  // Log every 5s
  var _titleLogTick = 0;
  function checkChatChange() {
    try {
      if (!isConversationOpen()) {
        _lastHeaderTitle = '';
        _currentChatTitle = '';
        _storePhone = '';
        resetAutoExtractState('conversation closed');
        return;
      }

      _titleLogTick++;
      if (_titleLogTick % 5 === 0) {
        var h = getConversationHeader();
        dbg('header-exists=' + !!h + ' title=' + getCurrentHeaderTitle());
      }
      var title = getCurrentHeaderTitle();
      if (!title || title === _lastHeaderTitle) return;
      _lastHeaderTitle = title;
      _currentChatTitle = title;
      _storePhone = '';
      resetAutoExtractState('chat changed to ' + title);
      dbg('chat changed: ' + title);
      // Small delay so WhatsApp finishes rendering the new chat
      // Immediately post the name as a fallback
      window.postMessage({ __waMgr: true, type: 'peer-name', name: title, chatTitle: title }, '*');
      _pendingExtractTitle = title;
      _pendingExtractTimer = setTimeout(function() {
        _pendingExtractTimer = null;
        if (!isConversationOpen()) {
          dbg('skip pending contact-info extraction: conversation closed');
          return;
        }
        if (getCurrentHeaderTitle() !== _pendingExtractTitle) {
          dbg('skip pending contact-info extraction: header changed');
          return;
        }
        dbg('attempting contact info open for: ' + title);
        openContactInfoAndRead(function(phone) {
          _lastExtracted = phone;
          dbg('auto-extracted phone: ' + phone);
          window.postMessage({ __waMgr: true, type: 'peer-phone', phone: phone, chatTitle: title }, '*');
        });
      }, 800);
    } catch(e) { _extracting = false; }
  }

  setInterval(checkChatChange, 1000);
})();
