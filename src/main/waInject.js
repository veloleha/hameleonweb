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
      post({type:'rec-debug', msg:'connected: '+label+' '+JSON.stringify(summarizeStream(stream, label))});
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
    dumpAudioState('recorder-started');
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
      dumpAudioState('desktop-ready');
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
        dumpAudioState('mic-ready');
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
  var suflerAddedTracks = null;
  var suflerScanTmr = null;
  var suflerRelaySendNode = null;
  var suflerRelaySendSource = null;
  var suflerRelaySendGain = null;
  var suflerRelayPlayCtx = null;
  var suflerRelayPlayNode = null;
  var suflerRelayPlayQueue = [];
  var suflerRelayPlayOffset = 0;

  function suflerPost(obj) { post(Object.assign({__waMgr:true, type:'sufler-debug'}, obj)); }
  function suflerSignal(obj) { post(Object.assign({__waMgr:true, type:'sufler-signal'}, obj)); }

  function rmsOfFloat32(samples) {
    try {
      if (!samples || !samples.length) return 0;
      var sum = 0;
      for (var i = 0; i < samples.length; i++) {
        var v = samples[i] || 0;
        sum += v * v;
      }
      return Math.sqrt(sum / samples.length);
    } catch (e) {
      return 0;
    }
  }

  function summarizeTrack(track) {
    if (!track) return null;
    return {
      id: track.id || '',
      label: track.label || '',
      kind: track.kind || '',
      enabled: !!track.enabled,
      muted: !!track.muted,
      readyState: track.readyState || ''
    };
  }

  function summarizeStream(stream, label) {
    try {
      var tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
      return {
        label: label || '',
        audioTracks: tracks.length,
        tracks: tracks.slice(0, 4).map(summarizeTrack)
      };
    } catch (e) {
      return { label: label || '', error: String(e) };
    }
  }

  function dumpAudioState(reason) {
    try {
      var payload = {
        reason: reason || '',
        desktop: summarizeStream(window.__waMgrDesktopStream, 'desktop'),
        mic: summarizeStream(window.__waMgrMicStream, 'mic'),
        rtcCount: (window.__waMgrRtcStreams || []).length,
        rtc: (window.__waMgrRtcStreams || []).slice(0, 6).map(function(stream, idx) {
          return summarizeStream(stream, 'rtc-' + idx);
        }),
        recDest: summarizeStream(recDest && recDest.stream, 'recDest')
      };
      post({type:'rec-debug', msg:'audio-state ' + JSON.stringify(payload)});
    } catch (e) {
      post({type:'rec-debug', msg:'audio-state error: ' + String(e)});
    }
  }

  var localRtcPlaybackAudio = null;
  window.__waMgrTestLocalRtcPlayback = function(index) {
    try {
      var streams = window.__waMgrRtcStreams || [];
      var idx = typeof index === 'number' ? index : 0;
      var stream = streams[idx];
      if (!stream) {
        post({type:'rec-debug', msg:'local rtc playback: no stream at index ' + idx});
        return false;
      }
      if (!localRtcPlaybackAudio) {
        localRtcPlaybackAudio = document.createElement('audio');
        localRtcPlaybackAudio.autoplay = true;
        localRtcPlaybackAudio.playsInline = true;
        localRtcPlaybackAudio.muted = false;
        localRtcPlaybackAudio.setAttribute('data-wa-local-rtc-test', 'true');
        document.body.appendChild(localRtcPlaybackAudio);
      }
      localRtcPlaybackAudio.srcObject = stream;
      var playPromise = localRtcPlaybackAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function(e) {
          post({type:'rec-debug', msg:'local rtc playback failed: ' + String(e)});
        });
      }
      post({type:'rec-debug', msg:'local rtc playback started: ' + JSON.stringify(summarizeStream(stream, 'local-rtc-' + idx))});
      return true;
    } catch (e) {
      post({type:'rec-debug', msg:'local rtc playback error: ' + String(e)});
      return false;
    }
  };

  window.__waMgrStopLocalRtcPlayback = function() {
    try {
      if (localRtcPlaybackAudio) {
        localRtcPlaybackAudio.pause();
        localRtcPlaybackAudio.srcObject = null;
        localRtcPlaybackAudio.remove();
        localRtcPlaybackAudio = null;
      }
      post({type:'rec-debug', msg:'local rtc playback stopped'});
    } catch (e) {
      post({type:'rec-debug', msg:'local rtc playback stop error: ' + String(e)});
    }
  };

  function float32ToBase64(float32) {
    try {
      var pcm = new Int16Array(float32.length);
      for (var i = 0; i < float32.length; i++) {
        var s = Math.max(-1, Math.min(1, float32[i] || 0));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      var bytes = new Uint8Array(pcm.buffer);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    } catch (e) {
      return '';
    }
  }

  function base64ToFloat32(b64) {
    try {
      var binary = atob(String(b64 || ''));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var pcm = new Int16Array(bytes.buffer);
      var out = new Float32Array(pcm.length);
      for (var j = 0; j < pcm.length; j++) out[j] = pcm[j] / 32768;
      return out;
    } catch (e) {
      return new Float32Array(0);
    }
  }

  function startSuflerRelay() {
    if (suflerRelaySendNode || suflerRelayPlayNode) return;
    if (!recCtx || !recDest || !recDest.stream) {
      suflerPost({msg:'relay start skipped: no recDest stream'});
      return;
    }

    try {
      if (recCtx.state === 'suspended') {
        recCtx.resume().catch(function() {});
      }
      suflerRelaySendSource = recCtx.createMediaStreamSource(recDest.stream);
      suflerRelaySendNode = recCtx.createScriptProcessor(1024, 1, 1);
      suflerRelaySendGain = recCtx.createGain();
      suflerRelaySendGain.gain.value = 0;
      suflerRelaySendSource.connect(suflerRelaySendNode);
      suflerRelaySendNode.connect(suflerRelaySendGain);
      suflerRelaySendGain.connect(recCtx.destination);
      suflerRelaySendNode.onaudioprocess = function(ev) {
        try {
          var input = ev.inputBuffer.getChannelData(0);
          if (!input || !input.length) return;
          var copy = new Float32Array(input.length);
          copy.set(input);
          var rms = rmsOfFloat32(copy);
          if (rms > 0) {
            suflerPost({msg:'relay send rms=' + rms.toFixed(4) + ' samples=' + copy.length});
          }
          suflerSignal({signalType:'audio', payload: float32ToBase64(copy), sampleRate: recCtx.sampleRate || 48000, channels: 1});
        } catch (e) {
          suflerPost({msg:'relay send error: ' + String(e)});
        }
      };
      suflerPost({msg:'relay sender started'});
    } catch (e) {
      suflerPost({msg:'relay sender failed: ' + String(e)});
    }

    try {
      var RelayAC = window.AudioContext || window.webkitAudioContext;
      suflerRelayPlayCtx = new RelayAC();
      if (suflerRelayPlayCtx.state === 'suspended') {
        suflerRelayPlayCtx.resume().catch(function() {});
      }
      suflerRelayPlayNode = suflerRelayPlayCtx.createScriptProcessor(1024, 0, 1);
      suflerRelayPlayNode.onaudioprocess = function(ev) {
        try {
          var out = ev.outputBuffer.getChannelData(0);
          var idx = 0;
          while (idx < out.length) {
            while (suflerRelayPlayQueue.length && suflerRelayPlayOffset >= suflerRelayPlayQueue[0].length) {
              suflerRelayPlayQueue.shift();
              suflerRelayPlayOffset = 0;
            }
            if (!suflerRelayPlayQueue.length) {
              out[idx++] = 0;
              continue;
            }
            var chunk = suflerRelayPlayQueue[0];
            var take = Math.min(chunk.length - suflerRelayPlayOffset, out.length - idx);
            out.set(chunk.subarray(suflerRelayPlayOffset, suflerRelayPlayOffset + take), idx);
            idx += take;
            suflerRelayPlayOffset += take;
          }
        } catch (e) {
          suflerPost({msg:'relay play error: ' + String(e)});
        }
      };
      suflerRelayPlayNode.connect(suflerRelayPlayCtx.destination);
      suflerPost({msg:'relay playback started'});
    } catch (e) {
      suflerPost({msg:'relay playback failed: ' + String(e)});
    }
  }

  function queuedSuflerSampleCount() {
    var total = 0;
    for (var i = 0; i < suflerRelayPlayQueue.length; i++) total += suflerRelayPlayQueue[i].length;
    return total - suflerRelayPlayOffset;
  }

  function queueSuflerRelayAudio(base64) {
    var samples = base64ToFloat32(base64);
    if (!samples || !samples.length) return;
    var rms = rmsOfFloat32(samples);
    suflerPost({msg:'relay recv rms=' + rms.toFixed(4) + ' samples=' + samples.length});
    suflerRelayPlayQueue.push(samples);
    // Не даём очереди расти больше ~120 мс, иначе задержка накапливается.
    var sr = (suflerRelayPlayCtx && suflerRelayPlayCtx.sampleRate) || 48000;
    var maxQueued = Math.floor(sr * 0.12);
    while (queuedSuflerSampleCount() > maxQueued && suflerRelayPlayQueue.length > 1) {
      suflerRelayPlayQueue.shift();
      suflerRelayPlayOffset = 0;
    }
  }

  function addSuflerStreamToPC(stream, label) {
    if (!suflerPC || !stream || !stream.getAudioTracks) return;
    if (!suflerAddedTracks) suflerAddedTracks = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var tracks = stream.getAudioTracks();
    if (!tracks.length) return;
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (!track) continue;
      if (suflerAddedTracks && suflerAddedTracks.has(track)) continue;
      try {
        suflerPC.addTrack(track, stream);
        if (suflerAddedTracks) suflerAddedTracks.add(track);
        suflerPost({msg:'added sufler source track: ' + label});
      } catch (e) {
        suflerPost({msg:'addTrack failed for ' + label + ': ' + String(e)});
      }
    }
  }

  function createSuflerPC() {
    if (suflerPC) { try { suflerPC.close(); } catch(e) {} }
    if (suflerScanTmr) {
      try { clearInterval(suflerScanTmr); } catch(e) {}
      suflerScanTmr = null;
    }
    suflerIceQueue = [];
    suflerAddedTracks = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    suflerPC = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Отправляем прямой RTC-источник звонка, а recDest оставляем как fallback/микс
    var rtcStreams = window.__waMgrRtcStreams || [];
    if (rtcStreams.length) {
      rtcStreams.forEach(function(stream, idx) {
        addSuflerStreamToPC(stream, 'rtc-' + idx);
      });
    }

    // Fallback: смешанный аудиопоток (копия, запись не ломается)
    if (recDest && recDest.stream) {
      addSuflerStreamToPC(recDest.stream, 'mixed-recDest');
    } else {
      suflerPost({msg:'no recDest stream'});
    }

    // Подцепляем любые новые RTC потоки, которые появились уже после старта суфлёра
    suflerScanTmr = setInterval(function() {
      try {
        var streams = window.__waMgrRtcStreams || [];
        for (var i = 0; i < streams.length; i++) {
          addSuflerStreamToPC(streams[i], 'rtc-scan-' + i);
        }
        if (recDest && recDest.stream) {
          addSuflerStreamToPC(recDest.stream, 'mixed-recDest-scan');
        }
      } catch (e) {
        suflerPost({msg:'sufler scan error: ' + String(e)});
      }
    }, 500);

    suflerPC.onicecandidate = function(ev) {
      if (ev.candidate) {
        suflerSignal({signalType: 'ice-candidate', payload: ev.candidate.toJSON()});
      }
    };

    suflerPC.addEventListener('track', function(ev) {
      if (!suflerRemoteAudio) {
        suflerRemoteAudio = document.createElement('audio');
        suflerRemoteAudio.autoplay = true;
        suflerRemoteAudio.playsInline = true;
        suflerRemoteAudio.setAttribute('data-sufler', 'true');
        document.body.appendChild(suflerRemoteAudio);
      }
      var remoteStream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
      suflerRemoteAudio.srcObject = remoteStream;
      var sinkId = window.__waMgrSuflerSinkId;
      if (sinkId && typeof suflerRemoteAudio.setSinkId === 'function') {
        suflerRemoteAudio.setSinkId(sinkId).catch(function(e) {
          suflerPost({msg:'setSinkId failed: ' + String(e)});
        });
      }
      try {
        var playPromise = suflerRemoteAudio.play && suflerRemoteAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function(e) {
            suflerPost({msg:'remote audio play failed: ' + String(e)});
          });
        }
      } catch (e) {
        suflerPost({msg:'remote audio play exception: ' + String(e)});
      }
      suflerPost({msg:'remote track received'});
    });

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

    // Пытаемся активировать AudioContext, т.к. в вебвью он часто suspended до user gesture
    if (recCtx && recCtx.state === 'suspended') {
      recCtx.resume().then(function() {
        suflerPost({msg:'audio context resumed'});
      }).catch(function(e) {
        suflerPost({msg:'audio context resume failed: ' + String(e)});
      });
    }

    createSuflerPC();
    startSuflerRelay();
    dumpAudioState('sufler-start');
    var trackCount = 0;
    try {
      if (window.__waMgrRtcStreams && window.__waMgrRtcStreams.length) {
        window.__waMgrRtcStreams.forEach(function(s) {
          trackCount += (s && s.getAudioTracks) ? s.getAudioTracks().length : 0;
        });
      }
      if (recDest && recDest.stream && recDest.stream.getAudioTracks) {
        trackCount += recDest.stream.getAudioTracks().length;
      }
    } catch (e) {}
    suflerPost({msg:'pc created, sourceTracks=' + trackCount + ', waiting for peer'});
  };

  window.__waMgrApplySuflerSignal = function(msg) {
    if (msg.type === 'audio') {
      queueSuflerRelayAudio(msg.payload);
      return;
    }

    if (!suflerPC) {
      suflerPost({msg:'apply signal but no pc'});
      return;
    }

    if (msg.type === 'peer-joined') {
      suflerPost({msg:'operator joined'});
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
    try { if (suflerScanTmr) { clearInterval(suflerScanTmr); } } catch(e) {}
    try { if (suflerRelaySendNode) { suflerRelaySendNode.disconnect(); } } catch(e) {}
    try { if (suflerRelaySendSource) { suflerRelaySendSource.disconnect(); } } catch(e) {}
    try { if (suflerRelaySendGain) { suflerRelaySendGain.disconnect(); } } catch(e) {}
    try { if (suflerRelayPlayNode) { suflerRelayPlayNode.disconnect(); } } catch(e) {}
    try { if (suflerRelayPlayCtx) { suflerRelayPlayCtx.close(); } } catch(e) {}
    try { if (suflerRemoteAudio) { suflerRemoteAudio.remove(); } } catch(e) {}
    suflerPC = null;
    suflerRemoteAudio = null;
    suflerIceQueue = [];
    suflerRoomId = null;
    suflerScanTmr = null;
    suflerRelaySendNode = null;
    suflerRelaySendSource = null;
    suflerRelaySendGain = null;
    suflerRelayPlayCtx = null;
    suflerRelayPlayNode = null;
    suflerRelayPlayQueue = [];
    suflerRelayPlayOffset = 0;
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
