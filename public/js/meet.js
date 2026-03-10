(function () {
  'use strict';

  var API = window.location.origin;
  var meetingId, myId, myName, isHost;
  var localStream = null;
  var cameraStream = null;
  var screenStream = null;
  var isScreenSharing = false;
  var currentFacingMode = 'user'; // 'user' or 'environment'
  var isReconnecting = false;
  var reconnectTimer = null;
  var peers = {}; // peerUserId -> { pc, name, tileEl, videoEl }
  var eventSource = null;
  var iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // default; replaced by /api/ice-servers
  var dragTileId = null;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  function byId(id) { return document.getElementById(id); }
  function qs(s) { return document.querySelector(s); }

  function parseParams() {
    var params = {};
    window.location.search.slice(1).split('&').forEach(function (p) {
      var kv = p.split('=');
      if (kv[0]) params[kv[0]] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    });
    meetingId = params.code || '';
    myName = params.name || 'Guest';
    isHost = params.host === '1';
    myId = 'u' + Math.random().toString(36).slice(2, 12);
  }

  function updateParticipantCount() {
    var n = 1 + Object.keys(peers).length;
    var el = byId('participantCount');
    if (el) el.textContent = n + ' participant' + (n !== 1 ? 's' : '');
  }

  function addRemoteTile(userId, userName, stream) {
    if (peers[userId] && peers[userId].tileEl) return;
    var container = byId('videosContainer');
    var tile = document.createElement('div');
    tile.className = 'video-tile remote';
    tile.id = 'tile-' + userId;
    tile.draggable = true;
    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (stream) video.srcObject = stream;
    var label = document.createElement('div');
    label.className = 'tile-label';
    label.innerHTML = '<span>' + escapeHtml(userName) + '</span>';
    tile.appendChild(video);
    tile.appendChild(label);
    var fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tile-btn-fullscreen';
    fsBtn.title = 'Full screen';
    fsBtn.setAttribute('aria-label', 'Full screen');
    fsBtn.innerHTML = '<svg class="icon-expand" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm12 0h4v4h-2V5h-2V3zM3 21h6v-2H5v-5H3v7zm12-2v2h4v-4h-2v2h-2z"/></svg><svg class="icon-exit" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M5 5h4v2H7v4H5V5zm10 0h4v4h-2V7h-2V5zM5 19v-4h2v2h4v2H5zm14-4v4h-4v-2h2v-2h2z"/></svg>';
    tile.appendChild(fsBtn);
    container.appendChild(tile);
    peers[userId] = peers[userId] || {};
    peers[userId].videoEl = video;
    peers[userId].tileEl = tile;
    peers[userId].name = userName;
    peers[userId].camStreamId = stream && stream.id;
    updateParticipantCount();
  }

  function removeRemoteTile(userId) {
    var p = peers[userId];
    if (!p) return;
    if (p.pc) try { p.pc.close(); } catch (_) {}
    if (p.tileEl && p.tileEl.parentNode) p.tileEl.parentNode.removeChild(p.tileEl);
    if (p.screenTileEl && p.screenTileEl.parentNode) p.screenTileEl.parentNode.removeChild(p.screenTileEl);
    delete peers[userId];
    updateParticipantCount();
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function createPeerConnection(remoteUserId, remoteUserName, isInitiator) {
    if (peers[remoteUserId] && peers[remoteUserId].pc) return peers[remoteUserId].pc;
    var pc = new RTCPeerConnection({
      iceServers: iceServers
    });
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    if (isScreenSharing && screenStream) {
      var st = screenStream.getVideoTracks()[0];
      if (st) {
        var screenSender = pc.addTrack(st, screenStream);
        peers[remoteUserId] = peers[remoteUserId] || {};
        peers[remoteUserId].screenSender = screenSender;
      }
    }
    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(remoteUserId, 'ice', e.candidate);
    };
    pc.ontrack = function (e) {
      var stream = e.streams && e.streams[0];
      if (!stream) return;
      var p = peers[remoteUserId] = peers[remoteUserId] || {};

      // First stream we see for this peer is treated as camera
      if (!p.camStreamId || p.camStreamId === stream.id) {
        addRemoteTile(remoteUserId, remoteUserName, stream);
        if (p.videoEl) p.videoEl.srcObject = stream;
        p.camStreamId = stream.id;
      } else {
        // Additional video stream is treated as screen share
        if (!p.screenTileEl) {
          addRemoteScreenTile(remoteUserId, remoteUserName, stream);
        } else if (p.screenVideoEl) {
          p.screenVideoEl.srcObject = stream;
        }
        p.screenStreamId = stream.id;
      }

      // Clean up screen tile when its track ends
      e.track.onended = function () {
        handleRemoteTrackEnded(remoteUserId, stream.id);
      };
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        removeRemoteTile(remoteUserId);
      }
    };
    peers[remoteUserId] = peers[remoteUserId] || {};
    peers[remoteUserId].pc = pc;
    peers[remoteUserId].name = remoteUserName;
    return pc;
  }

  function sendSignal(to, type, payload) {
    fetch(API + '/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: meetingId,
        from: myId,
        to: to,
        type: type,
        payload: payload
      })
    }).catch(function () {});
  }

  function handleOffer(from, userName, offerDesc) {
    var pc = createPeerConnection(from, userName, false);
    var offer = offerDesc && (offerDesc.type ? offerDesc : { type: 'offer', sdp: offerDesc.sdp });
    pc.setRemoteDescription(new RTCSessionDescription(offer)).then(function () {
      return pc.createAnswer();
    }).then(function (answer) {
      return pc.setLocalDescription(answer);
    }).then(function () {
      sendSignal(from, 'answer', pc.localDescription);
    }).catch(function (err) { console.error(err); });
  }

  function handleAnswer(from, answerDesc) {
    var p = peers[from];
    if (!p || !p.pc) return;
    var answer = answerDesc && (answerDesc.type ? answerDesc : { type: 'answer', sdp: answerDesc.sdp });
    p.pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(function (err) { console.error(err); });
  }

  function handleIce(from, candidate) {
    var p = peers[from];
    if (!p || !p.pc) return;
    p.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function (err) { console.error(err); });
  }

  function connectToPeer(remoteUserId, remoteUserName) {
    if (remoteUserId === myId) return;
    var pc = createPeerConnection(remoteUserId, remoteUserName, true);
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      var d = pc.localDescription;
      sendSignal(remoteUserId, 'offer', { type: d.type, sdp: d.sdp, userName: myName });
    }).catch(function (err) { console.error(err); });
  }

  function startEventSource() {
    var url = API + '/api/events?meetingId=' + encodeURIComponent(meetingId) + '&userId=' + encodeURIComponent(myId);
    eventSource = new EventSource(url);
    eventSource.onmessage = function (ev) {
      try {
        var data = JSON.parse(ev.data);
        var from = data.from, type = data.type, payload = data.payload;
        if (type === 'offer') {
          handleOffer(from, (payload && payload.userName) || 'Peer', payload);
        } else if (type === 'answer') {
          handleAnswer(from, payload);
        } else if (type === 'ice') {
          handleIce(from, payload);
        } else if (type === 'chat' && payload) {
          appendChatMessage(payload.userName || 'Someone', payload.text, false);
        } else if (type === 'whiteboard' && payload) {
          handleRemoteWhiteboard(payload);
        }
      } catch (e) {}
    };
    eventSource.onerror = function () {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
      scheduleReconnect();
    };
  }

  function fetchIceServers() {
    return fetch(API + '/api/ice-servers')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.iceServers && data.iceServers.length) iceServers = data.iceServers;
      })
      .catch(function () {});
  }

  function joinMeeting(isReconnect) {
    fetch(API + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: meetingId,
        userId: myId,
        userName: myName
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      return fetchIceServers().then(function () { return data; });
    }).then(function (data) {
      startEventSource();
      var list = data.peers || [];
      list.forEach(function (p) {
        connectToPeer(p.userId, p.userName);
      });
    }).catch(function () {
      if (!isReconnect) {
        alert('Could not join meeting. Is the server running?');
      }
    });
  }

  function startLocalStream() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      var msg = 'Camera and microphone require a secure context. Please open this site over HTTPS (or use localhost).';
      alert(msg);
      return Promise.reject(new Error(msg));
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function (stream) {
      localStream = stream;
      cameraStream = stream;
      byId('localVideo').srcObject = stream;
      byId('localName').textContent = myName;
      Object.keys(peers).forEach(function (uid) {
        var pc = peers[uid].pc;
        if (pc) stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
      });
    }).catch(function (err) {
      alert('Camera/microphone access needed: ' + (err.message || err));
    });
  }

  function setMic(enabled) {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = enabled; });
    var btn = byId('btnMic');
    var badge = byId('localMuted');
    if (enabled) {
      btn.classList.remove('mic-off');
      if (badge) badge.style.display = 'none';
    } else {
      btn.classList.add('mic-off');
      if (badge) badge.style.display = 'inline';
    }
  }

  function setCam(enabled) {
    if (!localStream) return;
    localStream.getVideoTracks().forEach(function (t) { t.enabled = enabled; });
    var btn = byId('btnCam');
    var tile = byId('localTile');
    if (enabled) {
      btn.classList.remove('cam-off');
      if (tile) tile.classList.remove('off');
    } else {
      btn.classList.add('cam-off');
      if (tile) tile.classList.add('off');
    }
  }

  function swapCamera() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      alert('Camera switching is not supported in this browser.');
      return;
    }

    var useEnv = currentFacingMode === 'user';
    var constraints = {
      video: {
        facingMode: useEnv ? { exact: 'environment' } : 'user'
      }
    };

    navigator.mediaDevices.getUserMedia(constraints).then(function (newVideoStream) {
      var newVideoTrack = newVideoStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        newVideoStream.getTracks().forEach(function (t) { t.stop(); });
        alert('Could not get a video track for the other camera.');
        return;
      }

      // Build a new local stream preserving existing audio tracks
      var newLocalStream = new MediaStream();
      if (localStream) {
        localStream.getAudioTracks().forEach(function (t) {
          newLocalStream.addTrack(t);
        });
        // Stop old video tracks
        localStream.getVideoTracks().forEach(function (t) {
          t.stop();
        });
      }
      newLocalStream.addTrack(newVideoTrack);

      localStream = newLocalStream;
      cameraStream = newLocalStream;

      var videoEl = byId('localVideo');
      if (videoEl) {
        videoEl.srcObject = newLocalStream;
      }

      // Update all peer connections to use the new video track
      replaceVideoTrackForAll(newVideoTrack);

      // Keep cam on/off visual state consistent
      var camBtn = byId('btnCam');
      var camEnabled = true;
      if (camBtn && camBtn.classList.contains('cam-off')) {
        camEnabled = false;
      }
      setCam(camEnabled);

      // Clean up the temporary stream container (its track has been moved)
      newVideoStream.getTracks().forEach(function (t) {
        if (t !== newVideoTrack) t.stop();
      });

      currentFacingMode = useEnv ? 'environment' : 'user';
    }).catch(function (err) {
      var msg = (err && (err.message || err.name)) || 'unknown error';
      alert('Could not switch camera: ' + msg);
    });
  }

  // ----- Local screen tile helpers -----

  function ensureLocalScreenTile() {
    var existing = byId('localScreenTile');
    if (existing) return existing;

    var container = byId('videosContainer');
    if (!container) return null;

    var tile = document.createElement('div');
    tile.className = 'video-tile local screen-share';
    tile.id = 'localScreenTile';
    tile.draggable = true;

    var video = document.createElement('video');
    video.id = 'localScreenVideo';
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    var label = document.createElement('div');
    label.className = 'tile-label';
    label.innerHTML = '<span>Your screen</span>';

    var fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tile-btn-fullscreen';
    fsBtn.title = 'Full screen';
    fsBtn.setAttribute('aria-label', 'Full screen');
    fsBtn.innerHTML = '<svg class="icon-expand" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm12 0h4v4h-2V5h-2V3zM3 21h6v-2H5v-5H3v7zm12-2v2h4v-4h-2v2h-2z"/></svg><svg class="icon-exit" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M5 5h4v2H7v4H5V5zm10 0h4v4h-2V7h-2V5zM5 19v-4h2v2h4v2H5zm14-4v4h-4v-2h2v-2h2z"/></svg>';

    tile.appendChild(video);
    tile.appendChild(label);
    tile.appendChild(fsBtn);
    container.appendChild(tile);

    return tile;
  }

  function removeLocalScreenTile() {
    var tile = byId('localScreenTile');
    if (tile && tile.parentNode) {
      tile.parentNode.removeChild(tile);
    }
  }

  // ----- Remote screen tile helpers -----

  function addRemoteScreenTile(userId, userName, stream) {
    var container = byId('videosContainer');
    if (!container) return;

    var p = peers[userId] = peers[userId] || {};
    if (p.screenTileEl) return;

    var tile = document.createElement('div');
    tile.className = 'video-tile remote screen-share';
    tile.id = 'tile-screen-' + userId;
    tile.draggable = true;

    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (stream) video.srcObject = stream;

    var label = document.createElement('div');
    label.className = 'tile-label';
    label.innerHTML = '<span>' + escapeHtml(userName) + ' – Screen</span>';

    var fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tile-btn-fullscreen';
    fsBtn.title = 'Full screen';
    fsBtn.setAttribute('aria-label', 'Full screen');
    fsBtn.innerHTML = '<svg class="icon-expand" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h6v2H5v4H3V3zm12 0h4v4h-2V5h-2V3zM3 21h6v-2H5v-5H3v7zm12-2v2h4v-4h-2v2h-2z"/></svg><svg class="icon-exit" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M5 5h4v2H7v4H5V5zm10 0h4v4h-2V7h-2V5zM5 19v-4h2v2h4v2H5zm14-4v4h-4v-2h2v-2h2z"/></svg>';

    tile.appendChild(video);
    tile.appendChild(label);
    tile.appendChild(fsBtn);
    container.appendChild(tile);

    p.screenTileEl = tile;
    p.screenVideoEl = video;
  }

  function handleRemoteTrackEnded(userId, streamId) {
    var p = peers[userId];
    if (!p) return;
    if (p.screenStreamId === streamId) {
      if (p.screenTileEl && p.screenTileEl.parentNode) {
        p.screenTileEl.parentNode.removeChild(p.screenTileEl);
      }
      p.screenTileEl = null;
      p.screenVideoEl = null;
      p.screenStreamId = null;
    }
  }

  function replaceVideoTrackForAll(track) {
    Object.keys(peers).forEach(function (uid) {
      var pc = peers[uid].pc;
      if (!pc) return;
      pc.getSenders().forEach(function (sender) {
        if (sender.track && sender.track.kind === 'video') {
          sender.replaceTrack(track).catch(function () {});
        }
      });
    });
  }

  function renegotiateWithPeer(remoteUserId, remoteUserName) {
    var p = peers[remoteUserId];
    if (!p || !p.pc) return;
    var pc = p.pc;
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      var d = pc.localDescription;
      sendSignal(remoteUserId, 'offer', { type: d.type, sdp: d.sdp, userName: myName });
    }).catch(function (err) { console.error(err); });
  }

  function addScreenTrackForAll(track) {
    Object.keys(peers).forEach(function (uid) {
      var p = peers[uid];
      var pc = p && p.pc;
      if (!pc) return;
      if (p.screenSender) {
        p.screenSender.replaceTrack(track).catch(function () {});
      } else {
        try {
          p.screenSender = pc.addTrack(track, screenStream);
        } catch (_) {
          return;
        }
      }
      renegotiateWithPeer(uid, p.name || 'Peer');
    });
  }

  function startScreenShare() {
    if (isScreenSharing) return;
    var md = navigator.mediaDevices;
    if (!md) {
      alert('Screen sharing requires a secure connection (HTTPS or localhost).');
      return;
    }
    var getDisplayMedia = md.getDisplayMedia;
    if (typeof getDisplayMedia !== 'function') {
      alert('Screen sharing is not supported in this browser. Try Chrome or Edge on desktop.');
      return;
    }
    var opts = { video: true };
    try {
      getDisplayMedia.call(md, opts).then(function (stream) {
        screenStream = stream;
        var track = stream.getVideoTracks()[0];
        if (!track) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          alert('No video track in screen share.');
          return;
        }

        // Keep camera video and add screen as a new tile locally
        var localTile = ensureLocalScreenTile();
        var screenVideoEl = byId('localScreenVideo');
        if (localTile && screenVideoEl) {
          screenVideoEl.srcObject = stream;
        }

        // For remote peers, send an additional video track for the screen
        addScreenTrackForAll(track);

        isScreenSharing = true;
        var btn = byId('btnScreen');
        if (btn) btn.classList.add('screen-on');
        track.onended = function () {
          stopScreenShare();
        };
      }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') {
          alert('Screen share cancelled or denied.');
          return;
        }
        alert('Screen share failed: ' + (err ? err.message || err.name : 'unknown error'));
      });
    } catch (e) {
      alert('Screen share failed: ' + (e.message || 'unknown error'));
    }
  }

  function stopScreenShare() {
    if (!isScreenSharing) return;
    // Remove screen tracks from all peer connections and renegotiate
    Object.keys(peers).forEach(function (uid) {
      var p = peers[uid];
      var pc = p && p.pc;
      if (!pc || !p.screenSender) return;
      try {
        pc.removeTrack(p.screenSender);
      } catch (_) {}
      p.screenSender = null;
      renegotiateWithPeer(uid, p.name || 'Peer');
    });
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      screenStream = null;
    }
    removeLocalScreenTile();
    isScreenSharing = false;
    var btn = byId('btnScreen');
    if (btn) btn.classList.remove('screen-on');
  }

  function scheduleReconnect() {
    if (reconnectTimer || isReconnecting) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectToMeeting();
    }, 2000);
  }

  function reconnectToMeeting() {
    if (isReconnecting) return;
    isReconnecting = true;

    // Clean up existing remote peers
    Object.keys(peers).forEach(function (id) {
      removeRemoteTile(id);
    });

    // EventSource will be recreated by joinMeeting -> startEventSource
    if (eventSource) {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
    }

    joinMeeting(true);
    isReconnecting = false;
  }

  function leaveMeeting() {
    if (eventSource) eventSource.close();
    Object.keys(peers).forEach(function (id) { removeRemoteTile(id); });
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    window.location.href = 'index.html';
  }

  function copyCode() {
    var el = byId('meetCodeDisplay');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () {
      var btn = byId('btnCopyCode');
      if (btn) { btn.title = 'Copied!'; setTimeout(function () { btn.title = 'Copy code'; }, 1500); }
    });
  }

  // ----- Local-only tile reordering (drag & drop) -----

  function handleTileDragStart(e) {
    var tile = e.target && e.target.closest && e.target.closest('.video-tile');
    if (!tile) return;
    dragTileId = tile.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', dragTileId);
      } catch (_) {}
    }
  }

  function handleTileDragOver(e) {
    var tile = e.target && e.target.closest && e.target.closest('.video-tile');
    if (!tile) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleTileDrop(e) {
    var container = byId('videosContainer');
    if (!container) return;
    e.preventDefault();
    var targetTile = e.target && e.target.closest && e.target.closest('.video-tile');
    if (!targetTile) return;
    var sourceId = dragTileId;
    if (!sourceId && e.dataTransfer) {
      try {
        sourceId = e.dataTransfer.getData('text/plain');
      } catch (_) {}
    }
    if (!sourceId) return;
    var srcTile = byId(sourceId);
    if (!srcTile || srcTile === targetTile) return;
    container.insertBefore(srcTile, targetTile);
    dragTileId = null;
  }

  // ----- Whiteboard (inline overlay) -----
  var whiteboardVisible = false;
  var wbCanvas = null;
  var wbCtx = null;
  var wbIsDrawing = false;
  var wbLastX = 0;
  var wbLastY = 0;
  var wbColor = '#ffffff';
  var wbSize = 4;
  var wbIsEraser = false;

  function broadcastWhiteboard(payload) {
    Object.keys(peers).forEach(function (peerId) {
      sendSignal(peerId, 'whiteboard', payload);
    });
  }

  function wbClearLocal() {
    if (!wbCtx || !wbCanvas) return;
    wbCtx.fillStyle = '#202124';
    wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
  }

  function wbResizeCanvas() {
    if (!wbCanvas) return;
    var rect = wbCanvas.getBoundingClientRect();
    var oldW = wbCanvas.width;
    var oldH = wbCanvas.height;
    var oldImage = null;
    if (oldW && oldH && wbCtx) {
      try {
        oldImage = wbCtx.getImageData(0, 0, oldW, oldH);
      } catch (_) {
        oldImage = null;
      }
    }
    wbCanvas.width = rect.width;
    wbCanvas.height = rect.height;
    if (oldImage) {
      wbCtx.putImageData(oldImage, 0, 0);
    } else {
      wbClearLocal();
    }
  }

  function wbDrawSegment(x0, y0, x1, y1, color, size) {
    if (!wbCtx) return;
    wbCtx.strokeStyle = color;
    wbCtx.lineWidth = size;
    wbCtx.lineCap = 'round';
    wbCtx.lineJoin = 'round';
    wbCtx.beginPath();
    wbCtx.moveTo(x0, y0);
    wbCtx.lineTo(x1, y1);
    wbCtx.stroke();
  }

  function wbPointerDown(e) {
    if (!wbCanvas) return;
    wbIsDrawing = true;
    var rect = wbCanvas.getBoundingClientRect();
    wbLastX = e.clientX - rect.left;
    wbLastY = e.clientY - rect.top;
  }

  function wbPointerMove(e) {
    if (!wbIsDrawing || !wbCanvas) return;
    var rect = wbCanvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var drawColor = wbIsEraser ? '#202124' : wbColor;
    var drawSize = wbSize;
    wbDrawSegment(wbLastX, wbLastY, x, y, drawColor, drawSize);
    var w = wbCanvas.width || 1;
    var h = wbCanvas.height || 1;
    broadcastWhiteboard({
      kind: 'draw',
      x0: wbLastX / w,
      y0: wbLastY / h,
      x1: x / w,
      y1: y / h,
      color: drawColor,
      size: drawSize
    });
    wbLastX = x;
    wbLastY = y;
  }

  function wbPointerUp() {
    wbIsDrawing = false;
  }

  function handleRemoteWhiteboard(payload) {
    if (!payload || !wbCanvas) return;
    if (payload.kind === 'clear') {
      wbClearLocal();
      return;
    }
    if (payload.kind === 'draw') {
      var w = wbCanvas.width || 1;
      var h = wbCanvas.height || 1;
      var x0 = payload.x0 * w;
      var y0 = payload.y0 * h;
      var x1 = payload.x1 * w;
      var y1 = payload.y1 * h;
      wbDrawSegment(x0, y0, x1, y1, payload.color || '#ffffff', payload.size || 4);
    }
  }

  function initWhiteboard() {
    var overlay = byId('whiteboardOverlay');
    if (!overlay) return;
    wbCanvas = byId('whiteboardCanvas');
    if (!wbCanvas) return;
    wbCtx = wbCanvas.getContext('2d');
    wbResizeCanvas();
    wbClearLocal();

    wbCanvas.addEventListener('pointerdown', function (e) {
      wbCanvas.setPointerCapture(e.pointerId);
      wbPointerDown(e);
    });
    wbCanvas.addEventListener('pointermove', wbPointerMove);
    wbCanvas.addEventListener('pointerup', function (e) {
      wbCanvas.releasePointerCapture(e.pointerId);
      wbPointerUp();
    });
    wbCanvas.addEventListener('pointercancel', wbPointerUp);

    window.addEventListener('resize', wbResizeCanvas);

    var eraserBtn = byId('btnWhiteboardEraser');
    var colors = byId('whiteboardColors');
    if (colors) {
      colors.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.whiteboard-color');
        if (!btn) return;
        var color = btn.getAttribute('data-color');
        if (!color) return;
        wbColor = color;
        wbIsEraser = false;
        if (eraserBtn) eraserBtn.classList.remove('active');
        [].slice.call(colors.querySelectorAll('.whiteboard-color')).forEach(function (el) {
          el.classList.toggle('selected', el === btn);
        });
      });
    }

    if (eraserBtn) {
      eraserBtn.addEventListener('click', function () {
        wbIsEraser = !wbIsEraser;
        eraserBtn.classList.toggle('active', wbIsEraser);
      });
    }

    var sizeInput = byId('whiteboardSize');
    if (sizeInput) {
      sizeInput.addEventListener('input', function () {
        var v = parseInt(sizeInput.value, 10);
        if (!isNaN(v)) wbSize = v;
      });
    }

    var btnClear = byId('btnWhiteboardClear');
    if (btnClear) {
      btnClear.addEventListener('click', function () {
        wbClearLocal();
        broadcastWhiteboard({ kind: 'clear' });
      });
    }

    var codeEl = byId('whiteboardMeetingCode');
    if (codeEl) {
      codeEl.textContent = meetingId + ' – Whiteboard';
    }
  }

  function openWhiteboard() {
    var overlay = byId('whiteboardOverlay');
    if (!overlay) return;
    // Show overlay first so canvas has real dimensions
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (!wbCanvas || !wbCtx) initWhiteboard();
    wbResizeCanvas();
    whiteboardVisible = true;
  }

  function closeWhiteboard() {
    var overlay = byId('whiteboardOverlay');
    if (!overlay) return;
    whiteboardVisible = false;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function openChat() {
    var panel = byId('chatPanel');
    var backdrop = byId('chatBackdrop');
    if (panel) panel.classList.add('open');
    if (backdrop) backdrop.classList.add('visible');
  }

  function closeChat() {
    var panel = byId('chatPanel');
    var backdrop = byId('chatBackdrop');
    if (panel) panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('visible');
  }

  function toggleChat() {
    var panel = byId('chatPanel');
    var backdrop = byId('chatBackdrop');
    if (!panel) return;
    var willBeOpen = !panel.classList.contains('open');
    panel.classList.toggle('open');
    if (backdrop) {
      if (willBeOpen) backdrop.classList.add('visible');
      else backdrop.classList.remove('visible');
    }
  }

  function appendChatMessage(senderName, text, isOwn) {
    var container = byId('chatMessages');
    if (!container) return;
    var msg = document.createElement('div');
    msg.className = 'meet-chat-msg' + (isOwn ? ' own' : '');
    msg.innerHTML = '<div class="meet-chat-sender">' + escapeHtml(senderName) + '</div><div class="meet-chat-body">' + escapeHtml(text) + '</div>';
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  }

  function sendChatMessage(text) {
    if (!text || !text.trim()) return;
    text = text.trim();
    appendChatMessage(myName, text, true);
    Object.keys(peers).forEach(function (peerId) {
      sendSignal(peerId, 'chat', { userName: myName, text: text });
    });
  }

  function init() {
    parseParams();
    if (!meetingId) {
      window.location.href = 'index.html';
      return;
    }
    byId('meetCodeDisplay').textContent = meetingId;
    byId('localName').textContent = myName;
    updateParticipantCount();

    byId('btnMic').addEventListener('click', function () {
      var muted = this.classList.toggle('mic-off');
      setMic(!muted);
    });
    byId('btnCam').addEventListener('click', function () {
      var off = this.classList.toggle('cam-off');
      setCam(!off);
    });
    var btnSwapCamera = byId('btnSwapCamera');
    if (btnSwapCamera) {
      btnSwapCamera.addEventListener('click', swapCamera);
    }
    var btnScreen = byId('btnScreen');
    if (btnScreen) {
      btnScreen.addEventListener('click', function () {
        if (isScreenSharing) stopScreenShare();
        else startScreenShare();
      });
    }
    byId('btnLeave').addEventListener('click', leaveMeeting);
    byId('btnCopyCode').addEventListener('click', copyCode);

    var btnWhiteboard = byId('btnWhiteboard');
    if (btnWhiteboard) {
      btnWhiteboard.addEventListener('click', openWhiteboard);
    }
    var btnWhiteboardClose = byId('btnWhiteboardClose');
    if (btnWhiteboardClose) {
      btnWhiteboardClose.addEventListener('click', closeWhiteboard);
    }

    var btnChat = byId('btnChat');
    if (btnChat) btnChat.addEventListener('click', toggleChat);
    var btnChatClose = byId('btnChatClose');
    if (btnChatClose) btnChatClose.addEventListener('click', closeChat);
    var chatBackdrop = byId('chatBackdrop');
    if (chatBackdrop) chatBackdrop.addEventListener('click', closeChat);

    var chatForm = byId('chatForm');
    var chatInput = byId('chatInput');
    if (chatForm && chatInput) {
      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        sendChatMessage(chatInput.value);
        chatInput.value = '';
      });
    }

    var container = byId('videosContainer');
    if (container) {
      container.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.tile-btn-fullscreen');
        if (!btn) return;
        var tile = btn.closest('.video-tile');
        if (!tile) return;
        if (!document.fullscreenElement) {
          tile.requestFullscreen && tile.requestFullscreen();
        } else {
          document.exitFullscreen && document.exitFullscreen();
        }
      });

      // Drag & drop reordering handlers (local only)
      container.addEventListener('dragstart', handleTileDragStart);
      container.addEventListener('dragover', handleTileDragOver);
      container.addEventListener('drop', handleTileDrop);
    }
    document.addEventListener('fullscreenchange', function () {
      var el = document.fullscreenElement;
      document.querySelectorAll('.tile-btn-fullscreen').forEach(function (btn) {
        var expand = btn.querySelector('.icon-expand');
        var exit = btn.querySelector('.icon-exit');
        if (!expand || !exit) return;
        if (el && btn.closest('.video-tile') === el) {
          expand.style.display = 'none';
          exit.style.display = 'block';
        } else {
          expand.style.display = 'block';
          exit.style.display = 'none';
        }
      });
    });

    if (typeof window !== 'undefined' && 'addEventListener' in window) {
      window.addEventListener('online', function () {
        scheduleReconnect();
      });
    }

    startLocalStream().then(function () {
      return joinMeeting(false);
    });
  }

  init();
})();
