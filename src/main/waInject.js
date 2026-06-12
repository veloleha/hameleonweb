// Запуск записи через desktopCapturer (chromeMediaSource: 'desktop')
// Захватывает системный звук без глушения динамиков.
(function() {
  if (window.__waMgrRecInProgress) return;
  window.__waMgrRecInProgress = true;

  function post(obj) { window.postMessage(Object.assign({__waMgr:true}, obj), '*'); }
  post({type:'rec-debug', msg:'recorder starting (desktop capture)'});

  var recDest = null;
  var recCtx = null;
  var mr = null;
  var scanTmr = null;

  var OrigAC = window.AudioContext || window.webkitAudioContext;
  if (!OrigAC) { post({type:'rec-debug', msg:'no AudioContext'}); window.__waMgrRecInProgress = false; return; }
  recCtx = new OrigAC();
  recDest = recCtx.createMediaStreamDestination();
  if (recCtx.state === 'suspended') { recCtx.resume().catch(function(){}); }
  post({type:'rec-debug', msg:'rec ctx state='+recCtx.state});

  var connectedStreams = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

  function connectStream(stream, label) {
    if (!stream || !recDest || !recCtx || recCtx.state === 'closed') return;
    if (connectedStreams && connectedStreams.has(stream)) return;
    var tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!tracks.length) return;
    if (connectedStreams) connectedStreams.add(stream);
    try {
      var src = recCtx.createMediaStreamSource(stream);
      src.connect(recDest);
      post({type:'rec-debug', msg:'connected: '+label});
    } catch(e) {
      post({type:'rec-debug', msg:'connect-err: '+String(e)});
    }
  }

  function startMR() {
    var mimeType = '';
    try {
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
    } catch(e) {}

    try { mr = new MediaRecorder(recDest.stream, mimeType ? {mimeType:mimeType} : undefined); }
    catch(e) {
      try { mr = new MediaRecorder(recDest.stream); }
      catch(e2) {
        post({type:'rec-debug', msg:'MR init failed: '+String(e2)});
        window.__waMgrRecInProgress = false; return;
      }
    }

    mr.ondataavailable = function(ev) {
      try {
        if (!ev.data || !ev.data.size) return;
        ev.data.arrayBuffer().then(function(ab) { post({type:'rec-chunk', buf:ab}); });
      } catch(e) {}
    };

    mr.onstop = function() {
      if (scanTmr) clearInterval(scanTmr);
      if (recCtx) { try { recCtx.close(); } catch(e) {} }
      try {
        if (window.__waMgrDesktopStream) {
          window.__waMgrDesktopStream.getTracks().forEach(function(t){ t.stop(); });
          window.__waMgrDesktopStream = null;
        }
      } catch(e) {}
      try {
        if (window.__waMgrMicStream) {
          window.__waMgrMicStream.getTracks().forEach(function(t){ t.stop(); });
          window.__waMgrMicStream = null;
        }
      } catch(e) {}
      window.__waMgrRecInProgress = false;
      window.__waMgrStopRec = null;
      post({type:'rec-stopped'});
    };

    mr.start(1000);
    post({type:'rec-started', mimeType: mr.mimeType || mimeType || ''});
  }

  // 1. Desktop audio capture (системный звук — собеседник + всё остальное)
  var desktopPromise = Promise.resolve();
  try {
    // Electron предоставляет chromeMediaSource:'desktop' через getUserMedia
    desktopPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop'
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          maxWidth: 1,
          maxHeight: 1,
          maxFrameRate: 1
        }
      }
    }).then(function(stream) {
      // Останавливаем видео трек — он нам не нужен
      try { stream.getVideoTracks().forEach(function(t){ t.stop(); }); } catch(e) {}
      window.__waMgrDesktopStream = stream;
      connectStream(stream, 'desktop-audio');
    }).catch(function(e) {
      post({type:'rec-debug', msg:'desktop-capture-err: '+String(e)});
    });
  } catch(e) {
    post({type:'rec-debug', msg:'desktop-capture-exception: '+String(e)});
  }

  // 2. Mic
  var micGUM = (navigator.mediaDevices && navigator.mediaDevices._waMgrOriginal)
    || (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices));
  var micPromise = micGUM
    ? micGUM({audio:true, video:false}).then(function(s) {
        window.__waMgrMicStream = s;
        connectStream(s, 'mic');
      }).catch(function(e) {
        post({type:'rec-debug', msg:'mic-err: '+String(e)});
      })
    : Promise.resolve();

  // Ждём оба потока и стартуем MediaRecorder
  Promise.all([desktopPromise, micPromise]).then(function() {
    startMR();
    // Периодически проверяем новые RTC потоки
    var rtcStreams = window.__waMgrRtcStreams || [];
    rtcStreams.forEach(function(s) { connectStream(s, 'rtc-stored'); });
    scanTmr = setInterval(function() {
      var streams = window.__waMgrRtcStreams || [];
      streams.forEach(function(s) { connectStream(s, 'rtc-scan'); });
    }, 500);
  });

  window.__waMgrStopRec = function() {
    try { if (mr && mr.state === 'recording') mr.stop(); } catch(e) {}
  };
})();
