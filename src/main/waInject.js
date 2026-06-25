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

  // WebRTC голосовой суфлёр (отдельный аудиовыход)
  // Сигналинг теперь идёт через main process, чтобы обойти CSP в вебвью WhatsApp Web.
  var suflerPC = null;
  var suflerRemoteAudio = null;
  var suflerIceQueue = [];
  var suflerRoomId = null;

  function suflerPost(obj) { post(Object.assign({__waMgr:true, type:'sufler-debug'}, obj)); }
  function suflerSignal(obj) { post(Object.assign({__waMgr:true, type:'sufler-signal'}, obj)); }

  function createSuflerPC() {
    if (suflerPC) { try { suflerPC.close(); } catch(e) {} }
    suflerIceQueue = [];
    suflerPC = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Отправляем смешанный аудиопоток (копия, запись не ломается)
    if (recDest && recDest.stream) {
      recDest.stream.getAudioTracks().forEach(function(track) {
        try { suflerPC.addTrack(track, recDest.stream); } catch(e) {}
      });
    } else {
      suflerPost({msg:'no recDest stream'});
    }

    suflerPC.onicecandidate = function(ev) {
      if (ev.candidate) {
        suflerSignal({type: 'ice-candidate', payload: ev.candidate.toJSON()});
      }
    };

    suflerPC.ontrack = function(ev) {
      if (!suflerRemoteAudio) {
        suflerRemoteAudio = document.createElement('audio');
        suflerRemoteAudio.autoplay = true;
        suflerRemoteAudio.setAttribute('data-sufler', 'true');
        document.body.appendChild(suflerRemoteAudio);
      }
      suflerRemoteAudio.srcObject = ev.streams[0];
      var sinkId = window.__waMgrSuflerSinkId;
      if (sinkId && typeof suflerRemoteAudio.setSinkId === 'function') {
        suflerRemoteAudio.setSinkId(sinkId).catch(function(e) {
          suflerPost({msg:'setSinkId failed: ' + String(e)});
        });
      }
      suflerPost({msg:'remote track received'});
    };

    suflerPC.onconnectionstatechange = function() {
      suflerPost({msg:'pc state ' + suflerPC.connectionState});
    };

    // Применяем отложенные ICE кандидаты после получения remote description
    var origSetRemote = suflerPC.setRemoteDescription.bind(suflerPC);
    suflerPC.setRemoteDescription = function(desc) {
      return origSetRemote(desc).then(function() {
        while (suflerIceQueue.length) {
          var cand = suflerIceQueue.shift();
          suflerPC.addIceCandidate(new RTCIceCandidate(cand)).catch(function(){});
        }
      });
    };
  }

  window.__waMgrStartSufler = function(roomId, sinkId) {
    if (suflerPC) { suflerPost({msg:'already started'}); return; }
    window.__waMgrSuflerSinkId = sinkId || null;
    suflerRoomId = roomId;
    createSuflerPC();
    suflerPost({msg:'pc created, waiting for peer'});
  };

  window.__waMgrApplySuflerSignal = function(msg) {
    if (!suflerPC) {
      suflerPost({msg:'apply signal but no pc'});
      return;
    }
    if (msg.type === 'peer-joined') {
      // Оператор подключился — делаем offer
      suflerPC.createOffer().then(function(offer) {
        return suflerPC.setLocalDescription(offer);
      }).then(function() {
        suflerSignal({type: 'offer', payload: suflerPC.localDescription.toJSON()});
      }).catch(function(e) {
        suflerPost({msg:'offer error ' + String(e)});
      });
    } else if (msg.type === 'answer') {
      suflerPC.setRemoteDescription(new RTCSessionDescription(msg.payload)).catch(function(e) {
        suflerPost({msg:'setRemote answer error ' + String(e)});
      });
    } else if (msg.type === 'ice-candidate') {
      if (suflerPC.remoteDescription) {
        suflerPC.addIceCandidate(new RTCIceCandidate(msg.payload)).catch(function(e) {
          suflerPost({msg:'addIceCandidate error ' + String(e)});
        });
      } else {
        suflerIceQueue.push(msg.payload);
      }
    }
  };

  window.__waMgrStopSufler = function() {
    try { if (suflerPC) { suflerPC.close(); } } catch(e) {}
    try { if (suflerRemoteAudio) { suflerRemoteAudio.remove(); } } catch(e) {}
    suflerPC = null;
    suflerRemoteAudio = null;
    suflerIceQueue = [];
    suflerRoomId = null;
    suflerPost({msg:'stopped'});
  };

  window.__waMgrSetSuflerSink = function(sinkId) {
    window.__waMgrSuflerSinkId = sinkId || null;
    if (suflerRemoteAudio && typeof suflerRemoteAudio.setSinkId === 'function') {
      suflerRemoteAudio.setSinkId(sinkId).catch(function(e) {
        suflerPost({msg:'setSinkId failed: ' + String(e)});
      });
    }
  };

})();
