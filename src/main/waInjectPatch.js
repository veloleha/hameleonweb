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
})();
