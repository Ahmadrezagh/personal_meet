(function () {
  'use strict';

  var API = window.location.origin;
  var meetingId, myId, myName, isHost;
  var localStream = null;
  var cameraStream = null;
  var screenStream = null;
  var isScreenSharing = false;
  var peers = {}; // peerUserId -> { pc, name, tileEl, videoEl }
  var eventSource = null;

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
    var video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (stream) video.srcObject = stream;
    var label = document.createElement('div');
    label.className = 'tile-label';
    label.innerHTML = '<span>' + escapeHtml(userName) + '</span>';
    tile.appendChild(video);
    tile.appendChild(label);
    container.appendChild(tile);
    peers[userId] = peers[userId] || {};
    peers[userId].videoEl = video;
    peers[userId].tileEl = tile;
    peers[userId].name = userName;
    updateParticipantCount();
  }

  function removeRemoteTile(userId) {
    var p = peers[userId];
    if (!p) return;
    if (p.pc) try { p.pc.close(); } catch (_) {}
    if (p.tileEl && p.tileEl.parentNode) p.tileEl.parentNode.removeChild(p.tileEl);
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
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    if (localStream) localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    if (isScreenSharing && screenStream) {
      var st = screenStream.getVideoTracks()[0];
      if (st) {
        pc.getSenders().forEach(function (sender) {
          if (sender.track && sender.track.kind === 'video') {
            sender.replaceTrack(st).catch(function () {});
          }
        });
      }
    }
    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(remoteUserId, 'ice', e.candidate);
    };
    pc.ontrack = function (e) {
      addRemoteTile(remoteUserId, remoteUserName, e.streams[0]);
      var v = peers[remoteUserId] && peers[remoteUserId].videoEl;
      if (v && e.streams[0]) v.srcObject = e.streams[0];
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
        }
      } catch (e) {}
    };
    eventSource.onerror = function () {
      eventSource.close();
      setTimeout(startEventSource, 2000);
    };
  }

  function joinMeeting() {
    fetch(API + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingId: meetingId,
        userId: myId,
        userName: myName
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      startEventSource();
      var list = data.peers || [];
      list.forEach(function (p) {
        connectToPeer(p.userId, p.userName);
      });
    }).catch(function () {
      alert('Could not join meeting. Is the server running?');
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

  function startScreenShare() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      alert('Screen sharing is not supported in this browser.');
      return;
    }
    if (isScreenSharing) return;
    navigator.mediaDevices.getDisplayMedia({ video: true }).then(function (stream) {
      screenStream = stream;
      var track = stream.getVideoTracks()[0];
      if (!track) return;
      replaceVideoTrackForAll(track);
      var videoEl = byId('localVideo');
      if (videoEl) videoEl.srcObject = stream;
      isScreenSharing = true;
      var btn = byId('btnScreen');
      if (btn) btn.classList.add('screen-on');
      track.onended = function () {
        stopScreenShare();
      };
    }).catch(function (err) {
      // Ignore user cancel; log other errors
      if (err && err.name === 'NotAllowedError') return;
      console.error(err);
    });
  }

  function stopScreenShare() {
    if (!isScreenSharing) return;
    var camTrack = cameraStream && cameraStream.getVideoTracks()[0];
    if (camTrack) {
      replaceVideoTrackForAll(camTrack);
      var videoEl = byId('localVideo');
      if (videoEl) videoEl.srcObject = cameraStream;
    }
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      screenStream = null;
    }
    isScreenSharing = false;
    var btn = byId('btnScreen');
    if (btn) btn.classList.remove('screen-on');
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
    byId('btnScreen').addEventListener('click', function () {
      if (isScreenSharing) stopScreenShare();
      else startScreenShare();
    });
    byId('btnLeave').addEventListener('click', leaveMeeting);
    byId('btnCopyCode').addEventListener('click', copyCode);

    startLocalStream().then(joinMeeting);
  }

  init();
})();
